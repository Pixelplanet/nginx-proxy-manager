import fs from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import _ from "lodash";
import errs from "../lib/error.js";
import {
	attributeToHostFile,
	blameOtherHost,
	blameTests,
	blameUnattributed,
	causedByProtected,
	regenerateOrDisable,
} from "../lib/nginx-blame.js";
import {
	capitalise,
	humaniseNginxMessage,
	mayResolveLater,
	parseManagedFile,
	parseNginxTestOutput,
	sentence,
} from "../lib/nginx-errors.js";
import { createLock } from "../lib/nginx-lock.js";
import {
	CONFIG_VERSION_MARKER,
	chooseLocationMode,
	describeConfigLine,
	isVariableHost,
	MESSAGES as LOCATION_MESSAGES,
	parseLocationPath,
	preflightLocation,
	prepareLocation,
	publicLocationState,
	readLocationTemplate,
	renderLocation,
} from "../lib/nginx-locations.js";
import { createModeResolver, toBool } from "../lib/upstream-dns.js";
import utils from "../lib/utils.js";
import { debug, nginx as logger } from "../logger.js";
import accessListModel from "../models/access_list.js";
import certificateModel from "../models/certificate.js";
import deadHostModel from "../models/dead_host.js";
import proxyHostModel from "../models/proxy_host.js";
import redirectionHostModel from "../models/redirection_host.js";
import streamModel from "../models/stream.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Meta keys owned by the server. They are stripped from incoming data and only set by configure().
 */
const SERVER_META_KEYS = ["nginx_online", "nginx_err", "nginx_locations", "nginx_checked_at", "nginx_details"];

const HOST_MODELS = {
	proxy_host: proxyHostModel,
	redirection_host: redirectionHostModel,
	dead_host: deadHostModel,
	stream: streamModel,
};

const HOST_LABELS = {
	proxy_host: "Proxy host",
	redirection_host: "Redirection host",
	dead_host: "404 host",
	stream: "Stream",
};

// How often broken files of other hosts may be repaired / moved aside in one configure or reload. Each repair
// runs a nested configure (DNS lookups, several nginx -t) while holding the lock, which blocks every save.
// A group of hosts sharing a broken path (see blameUnattributed()) counts once.
const MAX_HEAL_ITERATIONS = 10;
const TOO_MANY_BROKEN_HOSTS = `Too many broken host configs to repair in one go (more than ${MAX_HEAL_ITERATIONS}). Regenerate all host configs (restart NPM or run backend/scripts/regenerate-config), then try again.`;
// Extra configure iterations on top of one per location
const EXTRA_CONFIGURE_ITERATIONS = 10;

// Config name of a host that doesn't exist yet, see dryRun(). Not a number, so it can never be a real host's
// file (see parseManagedFile/listManagedFiles) and is easy to clean up after an interrupted test.
const DRY_RUN_ID = "npm-dry-run";
// When the startup reconcile tries hosts again whose upstream names did not resolve yet
const RECONCILE_RETRY_DELAYS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];

/**
 * Every sequence that writes nginx config, tests it and reloads nginx runs through this lock,
 * otherwise concurrent saves test and rename each other's files. Re-entrant: code that already
 * holds the lock runs directly. Timers started inside the lock must use runOutsideLock, see lib/nginx-lock.js.
 */
const { withLock, runOutsideLock } = createLock();

const readFileOrNull = (filename) => {
	try {
		return fs.readFileSync(filename, { encoding: "utf8" });
	} catch {
		return null;
	}
};

const hostLabel = (hostType, host) => {
	const label = HOST_LABELS[hostType] || hostType;
	const names =
		Array.isArray(host?.domain_names) && host.domain_names.length ? ` (${host.domain_names.join(", ")})` : "";
	return `${label} #${host?.id}${names}`;
};

/**
 * @param   {Object} entry  an other host's file moved aside during a dry run
 * @returns {Object}
 */
const describeAside = (entry) => {
	const humanised = entry.parsed?.message ? humaniseNginxMessage(entry.parsed.message) : null;
	return {
		host_type: entry.host_type,
		host_id: entry.host_id,
		message: sentence(
			`Nginx rejects the current configuration of ${hostLabel(entry.host_type, { id: entry.host_id })}${
				humanised ? `: ${humanised.text}` : ""
			}`,
		),
	};
};

const internalNginx = {
	SERVER_META_KEYS,

	/**
	 * Runs fn while holding the nginx lock
	 *
	 * @param   {Function} fn
	 * @returns {Promise}
	 */
	withLock: withLock,

	/**
	 * Removes the server-owned meta keys from incoming data, in place.
	 *
	 * @param   {Object} data
	 * @returns {Object} data
	 */
	stripServerMeta: (data) => {
		if (data?.meta && typeof data.meta === "object") {
			for (const key of SERVER_META_KEYS) {
				delete data.meta[key];
			}
		}
		return data;
	},

	/**
	 * @param   {Error}  err
	 * @returns {boolean} true when configure() did not apply the change: nginx rejected the host itself (or the
	 *                    global config), or the config could not be rendered. The previous config is still active.
	 */
	isHostLevelError: (err) =>
		(err instanceof errs.NginxConfigError && ["host", "global"].includes(err.details?.scope)) ||
		(err instanceof errs.ConfigurationError && err.configureFailed === true),

	/**
	 * Writes the config for a host, makes sure nginx accepts it and reloads nginx.
	 *
	 * - Custom locations that nginx rejects are quarantined (replaced by a 503 stub, or left out),
	 *   the rest of the host stays online. See meta.nginx_locations.
	 * - Broken config files of OTHER hosts are repaired or moved aside (.err) and that host is marked offline.
	 * - When this host's config is rejected outside of a custom location, the previous config is
	 *   restored and an NginxConfigError (scope "host" or "global") is thrown.
	 *
	 * @param   {Object|String}  model
	 * @param   {String}         host_type
	 * @param   {Object}         host
	 * @param   {Object}         [opts]
	 * @param   {Boolean}        [opts.reload]  default true
	 * @param   {Boolean}        [opts.dryRun]  only check that nginx accepts the host, nothing is changed:
	 *                                          see dryRun(). Throws like a real configure would.
	 * @returns {Promise<Object>} the new meta
	 */
	configure: (model, host_type, host, opts = {}) => {
		if (opts.dryRun === true) {
			return internalNginx.dryRun(model, host_type, host).then((result) => {
				if (result.error) {
					throw result.error;
				}
				return result.meta;
			});
		}
		return withLock(() =>
			internalNginx.configureHost(model, host_type, host, {
				reload: opts.reload !== false,
				depth: 0,
			}),
		);
	},

	/**
	 * Checks whether nginx would accept a host, without changing anything: the host's config is written for the
	 * duration of `nginx -t` only, nothing is written to the database, nginx is not reloaded and other hosts'
	 * files are not repaired (a broken one is moved aside for the test, put back afterwards and reported).
	 *
	 * A host that doesn't exist yet has no id: pass `id: internalNginx.DRY_RUN_ID`, its config is written to a
	 * reserved file name that is removed afterwards (with the log files `nginx -t` creates for it).
	 *
	 * @param   {Object}  model
	 * @param   {String}  host_type
	 * @param   {Object}  host  the host as it would be saved, with its relations
	 * @returns {Promise<{meta: Object|null, error: Error|null, locations: Array|null, aside: Array}>}
	 *          error: the host-level NginxConfigError/ConfigurationError a save would fail with.
	 *          aside: other hosts whose broken config would be repaired or disabled by a save
	 *          ({host_type, host_id, message, details}).
	 */
	dryRun: (model, host_type, host) =>
		withLock(async () => {
			const hostType = internalNginx.getFileFriendlyHostType(host_type);
			const isNew = host.id === DRY_RUN_ID;
			const filename = internalNginx.getConfigName(hostType, host.id);
			if (isNew) {
				// a leftover of an interrupted test must not be put back
				internalNginx.deleteFile(filename);
				internalNginx.deleteFile(`${filename}.err`);
			}
			const previous = readFileOrNull(filename);
			const previousErr = readFileOrNull(`${filename}.err`);
			const aside = [];
			const opts = { reload: false, depth: 0, dryRun: true, aside };

			try {
				const meta = await internalNginx.configureHost(model, hostType, host, opts);
				return {
					meta,
					error: null,
					locations: meta.nginx_locations || null,
					aside: aside.map(describeAside),
				};
			} catch (err) {
				if (!internalNginx.isHostLevelError(err)) {
					throw err;
				}
				return { meta: null, error: err, locations: err.locationStates || null, aside: aside.map(describeAside) };
			} finally {
				internalNginx.restoreConfig(filename, previous);
				internalNginx.restoreConfig(`${filename}.err`, previousErr);
				for (const entry of aside) {
					try {
						if (fs.existsSync(`${entry.file}.npm-aside`)) {
							fs.renameSync(`${entry.file}.npm-aside`, entry.file);
						}
					} catch (err) {
						logger.error(`Could not move ${entry.file} back: ${err.message}`);
					}
				}
				if (isNew) {
					internalNginx.removeDryRunFiles();
				}
			}
		}),

	DRY_RUN_ID,

	/**
	 * Removes what a dry run of a new host leaves behind: its config file (only after an interrupted test) and
	 * the log files `nginx -t` opened for it. Only call this while holding the lock.
	 */
	removeDryRunFiles: () => {
		for (const hostType of Object.keys(HOST_MODELS)) {
			const filename = internalNginx.getConfigName(hostType, DRY_RUN_ID);
			for (const file of [filename, `${filename}.err`, `${filename}.npm-aside`]) {
				if (fs.existsSync(file)) {
					internalNginx.deleteFile(file);
				}
			}
		}
		let logs = [];
		try {
			logs = fs.readdirSync("/data/logs").filter((f) => f.includes(`-${DRY_RUN_ID}_`));
		} catch {
			return;
		}
		for (const file of logs) {
			try {
				fs.rmSync(`/data/logs/${file}`, { force: true });
			} catch (err) {
				logger.warn(`Could not remove /data/logs/${file}: ${err.message}`);
			}
		}
	},

	/**
	 * configure() without the lock. Only call this while holding the lock.
	 *
	 * @param   {Object}   model
	 * @param   {String}   host_type
	 * @param   {Object}   host
	 * @param   {Object}   opts
	 * @param   {Boolean}  opts.reload
	 * @param   {Number}   opts.depth           recursion guard for repairing other hosts
	 * @param   {Function} [opts.modeResolver]  shared DNS cache, see lib/upstream-dns.js
	 * @param   {Boolean}  [opts.offlineOnError] mark the host offline instead of throwing on host level errors
	 * @param   {Boolean}  [opts.dryRun]  check only: on success the host's previous config files are put back and
	 *                                    nothing is written to the database. Broken files of other hosts are not
	 *                                    repaired: they are moved aside for the test and listed in opts.aside,
	 *                                    the caller puts them back, see dryRun()
	 * @param   {Array}    [opts.aside]   dry run: collects the other hosts' files moved aside
	 * @returns {Promise<Object>}
	 */
	configureHost: async (model, host_type, host, opts) => {
		const hostType = internalNginx.getFileFriendlyHostType(host_type);
		const filename = internalNginx.getConfigName(hostType, host.id);
		const previous = readFileOrNull(filename);
		// A config kept aside for inspection survives a failed attempt
		const previousErr = readFileOrNull(`${filename}.err`);
		const modeResolver = opts.modeResolver || createModeResolver();

		let states = null;
		if (hostType === "proxy_host" && Array.isArray(host.locations) && host.locations.length) {
			states = await internalNginx.computeLocationStates(host.locations, modeResolver);
		}

		// Each location can be quarantined twice (stub, then omitted)
		const maxQuarantines = (host.locations?.length || 0) * 2 + EXTRA_CONFIGURE_ITERATIONS;
		let quarantines = 0;
		let heals = 0;
		let configText = "";
		let failure = null;

		for (;;) {
			if (quarantines > maxQuarantines) {
				failure = { scope: "host", parsed: { file: filename, line: null, message: "", output: "" } };
				break;
			}

			try {
				configText = await internalNginx.generateConfig(hostType, host, { locationStates: states });
			} catch (err) {
				await internalNginx.restoreHost(model, host, filename, previous, previousErr, heals > 0);
				const error =
					err instanceof errs.ConfigurationError ? err : new errs.ConfigurationError(err.message, err);
				// the change was not applied, see isHostLevelError()
				error.configureFailed = true;
				throw error;
			}

			const result = await internalNginx.runTest({ file: filename, text: configText });
			if (result.ok) {
				failure = null;
				break;
			}

			const parsed = result.parsed;
			if (parsed.file === filename) {
				const where = describeConfigLine(configText, parsed.line);
				if (
					states &&
					where.location_index !== null &&
					states[where.location_index] &&
					internalNginx.quarantineLocation(states[where.location_index], host, parsed, modeResolver)
				) {
					quarantines++;
					continue;
				}
				failure = { scope: "host", parsed };
				break;
			}

			let blame = null;
			const tests = blameTests({
				own: filename,
				protect: opts.protect,
				testWithoutOwn: () => internalNginx.testWithout(filename, configText),
				testAside: (files) => internalNginx.testAside(files),
			});
			if (parseManagedFile(parsed.file)) {
				// nginx names another host's file. That host is only repaired or taken offline when its file
				// fails on its own, without this host's new config: an error can show up in a file that is
				// fine by itself, eg. a duplicate `listen ... default_server` is reported at the second
				// definition, or this host's advanced config includes the other host's file.
				// In a nested configure the host being saved is taken out as well, see blameTests().
				blame = await blameOtherHost(parsed, tests.testWithout);
			} else if (!parsed.file) {
				// No file named, eg. another host's log file can't be opened. Only a host whose file mentions
				// the path AND whose removal makes the error go away is blamed, see lib/nginx-blame.js
				blame = await blameUnattributed(parsed, {
					own: { file: filename },
					listFiles: internalNginx.listManagedFiles,
					testWithout: tests.testWithout,
					testWithoutCandidate: tests.testWithoutCandidate,
					testWithoutCandidates: tests.testWithoutCandidates,
				});
			}
			if (blame) {
				if (blame.action === "conflict") {
					failure = { scope: "host", parsed, conflict: true };
					break;
				}
				const protect = opts.protect || [];
				const others = blame.action === "heal" ? blame.others || [blame.other] : [];
				if (
					others.some((other) =>
						protect.includes(internalNginx.getConfigName(other.host_type, other.host_id)),
					)
				) {
					// A nested configure (regenerating another host, see healOtherHost()) never touches the
					// host being saved: the host being saved is at fault, see the protect check below
					failure = { scope: "host", parsed: blame.parsed, namesProtected: true };
					break;
				}
				if (opts.dryRun && others.length) {
					// A dry run never changes another host: the broken file is only moved aside for the test (so
					// this host's config can still be checked) and reported. Saving would repair or disable it.
					const aside = opts.aside || [];
					if (aside.length >= MAX_HEAL_ITERATIONS) {
						failure = { scope: "global", tooMany: true, parsed: blame.parsed };
						break;
					}
					let moved = false;
					for (const other of others) {
						const otherFile = internalNginx.getConfigName(other.host_type, other.host_id);
						if (!fs.existsSync(otherFile)) {
							continue;
						}
						fs.renameSync(otherFile, `${otherFile}.npm-aside`);
						aside.push({
							host_type: other.host_type,
							host_id: other.host_id,
							file: otherFile,
							parsed: others.length > 1 ? Object.assign({}, blame.parsed, { file: otherFile }) : blame.parsed,
						});
						moved = true;
					}
					if (moved) {
						continue;
					}
					failure = { scope: "global", parsed: blame.parsed };
					break;
				}
				if (others.length && heals >= MAX_HEAL_ITERATIONS) {
					logger.error(`${hostLabel(hostType, host)}: ${TOO_MANY_BROKEN_HOSTS}`);
					failure = { scope: "global", tooMany: true, parsed: blame.parsed };
					break;
				}
				let healed = false;
				try {
					for (const other of others) {
						const otherParsed =
							others.length > 1
								? Object.assign({}, blame.parsed, {
										file: internalNginx.getConfigName(other.host_type, other.host_id),
									})
								: blame.parsed;
						if (await internalNginx.healOtherHost(other, otherParsed, opts.depth, [...protect, filename])) {
							healed = true;
						}
					}
				} catch (err) {
					if (!err.protectedConflict) {
						throw err;
					}
					// Regenerating the other host failed because of this host's new config: this change conflicts
					// with it. The other host keeps its file, nothing is disabled.
					failure = { scope: "host", parsed: err.parsed, conflict: true };
					break;
				}
				if (healed) {
					heals++;
					continue;
				}
				failure = { scope: "global", parsed: blame.parsed };
				break;
			}

			failure = { scope: "global", parsed };
			break;
		}

		if (
			failure &&
			opts.protect?.length &&
			(await causedByProtected({
				parsed: failure.parsed,
				protect: opts.protect,
				namesProtected: failure.namesProtected,
				testWithoutProtected: () => internalNginx.testAside(opts.protect),
			}))
		) {
			// A nested configure (regenerating this host while another host is being saved) failed because of the
			// host being saved: that save must fail as a conflict, this host must not be disabled for it
			await internalNginx.restoreHost(model, host, filename, previous, previousErr, heals > 0);
			const abort = new Error(`Regenerating ${hostLabel(hostType, host)} conflicts with the host being saved`);
			abort.protectedConflict = true;
			abort.parsed = failure.parsed;
			throw abort;
		}

		if (failure) {
			const error = failure.tooMany
				? new errs.NginxConfigError(TOO_MANY_BROKEN_HOSTS, { kind: "nginx_config", scope: "global" })
				: failure.conflict
					? internalNginx.buildConflictError(hostType, host, failure.parsed)
					: internalNginx.buildConfigError(failure.scope, hostType, host, failure.parsed, configText);
			if (opts.offlineOnError && failure.scope === "host") {
				// Bulk mode: don't fail the whole operation because of one host, take it offline instead
				internalNginx.renameConfigAsErrorSync(filename);
				const meta = internalNginx.buildOfflineMeta(host.meta, error, states);
				await model.query().where("id", host.id).patch({ meta });
				logger.warn(`${hostLabel(hostType, host)} is offline: ${error.message}`);
				return meta;
			}
			await internalNginx.restoreHost(model, host, filename, previous, previousErr, heals > 0);
			if (opts.dryRun && states) {
				error.locationStates = states.map(publicLocationState);
			}
			throw error;
		}

		const meta = _.assign({}, host.meta, {
			nginx_online: true,
			nginx_err: null,
			nginx_details: null,
			nginx_checked_at: new Date().toISOString(),
		});
		if (hostType === "proxy_host") {
			meta.nginx_locations = states ? states.map(publicLocationState) : [];
		}

		if (opts.dryRun) {
			internalNginx.restoreConfig(filename, previous);
			internalNginx.restoreConfig(`${filename}.err`, previousErr);
			return meta;
		}

		internalNginx.deleteFile(`${filename}.err`);
		await model.query().where("id", host.id).patch({ meta });

		if (opts.reload) {
			// The config was just tested while holding the lock, no need to test again
			await internalNginx.reloadNginx({ skipTest: true });
		}
		return meta;
	},

	/**
	 * Runs `nginx -t` with the config file of the host being configured taken out, then puts it back.
	 * Only call this while holding the lock.
	 *
	 * @param   {String} filename    the config file of the host being configured
	 * @param   {String} configText  its new content
	 * @returns {Promise<{ok: boolean, parsed?: Object}>}
	 */
	testWithout: async (filename, configText) => {
		internalNginx.deleteFile(filename);
		try {
			return await internalNginx.runTest();
		} finally {
			try {
				fs.writeFileSync(filename, configText, { encoding: "utf8" });
			} catch (err) {
				logger.error(`Could not write ${filename} back: ${err.message}`);
			}
		}
	},

	/**
	 * Runs `nginx -t` with the given config files moved aside (to `<file>.npm-aside`, which nginx doesn't
	 * include), then puts them back. Only call this while holding the lock.
	 *
	 * @param   {String[]} filenames
	 * @returns {Promise<{ok: boolean, parsed?: Object}>}
	 */
	testAside: async (filenames) => {
		const moved = [];
		try {
			for (const filename of filenames) {
				if (fs.existsSync(filename)) {
					fs.renameSync(filename, `${filename}.npm-aside`);
					moved.push(filename);
				}
			}
			return await internalNginx.runTest();
		} finally {
			for (const filename of moved) {
				try {
					fs.renameSync(`${filename}.npm-aside`, filename);
				} catch (err) {
					logger.error(`Could not move ${filename} back: ${err.message}`);
				}
			}
		}
	},

	/**
	 * nginx reported the error in another host's file, but that file passes without this host's new config:
	 * this change is at fault. The other host's file name is not passed on, the user may not be allowed to
	 * see that host.
	 *
	 * @param   {String}  hostType
	 * @param   {Object}  host
	 * @param   {Object}  parsed  parsed nginx -t output
	 * @returns {errs.NginxConfigError}
	 */
	buildConflictError: (hostType, host, parsed) => {
		const humanised = parsed.message
			? humaniseNginxMessage(parsed.message)
			: { text: "nginx rejected the configuration", hint: null };
		const output = `${parsed.output || ""}`.replace(
			/\/data\/nginx\/(proxy_host|redirection_host|dead_host|stream)\/\d+\.conf(:\d+)?/g,
			"<another host's config>",
		);
		return new errs.NginxConfigError(
			sentence(`This change conflicts with the configuration of another host: ${humanised.text}`),
			{
				kind: "nginx_config",
				scope: "host",
				host_type: hostType,
				host_id: host.id,
				file: internalNginx.getConfigName(hostType, host.id),
				line: null,
				location_index: null,
				location_path: null,
				nginx_output: output || null,
				hint:
					humanised.hint ||
					"Another host already uses this setting (for example the same listen port with default_server), or the advanced configuration includes another host's config file.",
			},
		);
	},

	/**
	 * Puts a host back the way it was before a configure attempt that did not apply: its config file,
	 * the .err file kept for inspection and, when other hosts were repaired during the attempt, its meta.
	 * Repairing another host runs a nested configure that can blame this host's new file and mark this host
	 * offline, although its previous config stays active.
	 *
	 * @param   {Object}       model
	 * @param   {Object}       host
	 * @param   {String}       filename
	 * @param   {String|null}  previous     previous content of the config file
	 * @param   {String|null}  previousErr  previous content of the .err file
	 * @param   {Boolean}      restoreMeta
	 * @returns {Promise}
	 */
	restoreHost: async (model, host, filename, previous, previousErr, restoreMeta) => {
		internalNginx.restoreConfig(filename, previous);
		internalNginx.restoreConfig(`${filename}.err`, previousErr);
		if (restoreMeta) {
			try {
				await model
					.query()
					.where("id", host.id)
					.patch({ meta: host.meta || {} });
			} catch (err) {
				logger.warn(`Could not restore the meta of the host of ${filename}: ${err.message}`);
			}
		}
	},

	/**
	 * @param   {Array}    locations
	 * @param   {Function} modeResolver
	 * @returns {Promise<Array>}
	 */
	computeLocationStates: (locations, modeResolver) => {
		return Promise.all(
			locations.map(async (raw, index) => {
				const loc = prepareLocation(raw);
				const state = { index, path: loc.path, status: "ok", mode: null, message: null, stub: true };
				const problem = preflightLocation(loc);
				if (problem) {
					return Object.assign(state, problem);
				}
				// A variable upstream (`$backend`) is resolved by nginx itself, there is nothing to look up
				const resolved = isVariableHost(loc.forward_host)
					? { mode: "static", status: "ok" }
					: await modeResolver(loc.forward_host);
				const result = chooseLocationMode(loc, resolved);
				state.mode = result.mode;
				state.status = result.status;
				if (result.status === "unresolved") {
					state.message = LOCATION_MESSAGES.unresolved(loc.forward_host);
				}
				return state;
			}),
		);
	},

	/**
	 * Takes a location out of service after nginx rejected it.
	 *
	 * @param   {Object}   state
	 * @param   {Object}   host
	 * @param   {Object}   parsed        parsed nginx -t output
	 * @param   {Function} modeResolver
	 * @returns {boolean}  false when nothing more can be done for this location
	 */
	quarantineLocation: (state, host, parsed, modeResolver) => {
		const humanised = humaniseNginxMessage(parsed.message);

		// A static location whose host vanished between the DNS check and nginx -t:
		// switch to dynamic resolution instead of dropping it
		if (
			state.status === "ok" &&
			state.mode === "static" &&
			/host not found in upstream/.test(parsed.message) &&
			modeResolver.hasResolver &&
			modeResolver.dynamicEnabled
		) {
			const loc = prepareLocation(host.locations[state.index]);
			state.mode = "dynamic";
			state.status = "unresolved";
			state.message = LOCATION_MESSAGES.unresolved(loc.forward_host);
			return true;
		}

		if (state.status === "ok" || state.status === "unresolved") {
			state.status = "quarantined";
			state.mode = null;
			state.stub = true;
			state.message = LOCATION_MESSAGES.rejected(sentence(humanised.text));
			return true;
		}

		if (state.status === "quarantined" && state.stub) {
			state.stub = false;
			state.message = LOCATION_MESSAGES.omitted(sentence(humanised.text));
			return true;
		}

		return false;
	},

	/**
	 * Another host's config file breaks `nginx -t` by itself. An enabled host is first regenerated from its
	 * database row (without reload, with its own location quarantine): that repairs files written by older
	 * versions and files that were tampered with, eg. by a log directive of another host's advanced config
	 * writing into them. Only when the regenerated config still fails at host level (or the host is
	 * disabled / has no row) is the file moved to .err and the host marked offline.
	 *
	 * @param   {Object}   other      {host_type, host_id}
	 * @param   {Object}   parsed     parsed nginx -t output
	 * @param   {Number}   depth
	 * @param   {String[]} [protect]  config files the regeneration must not repair or move aside (the host
	 *                                being saved)
	 * @returns {Promise<boolean>} true when something was changed and the test should be repeated
	 */
	healOtherHost: async (other, parsed, depth, protect = []) => {
		const model = HOST_MODELS[other.host_type];
		const filename = internalNginx.getConfigName(other.host_type, other.host_id);
		const fileText = readFileOrNull(filename);
		if (fileText === null) {
			return false;
		}

		let row = null;
		try {
			row = await model
				.query()
				.where("is_deleted", 0)
				.andWhere("id", other.host_id)
				.allowGraph(model.defaultAllowGraph)
				.withGraphFetched(`[${model.defaultExpand.join(", ")}]`)
				.first();
		} catch (err) {
			logger.warn(`Could not load ${other.host_type} #${other.host_id}: ${err.message}`);
		}

		await regenerateOrDisable({
			enabled: !!row?.enabled,
			depth: depth || 0,
			// the host being saved caused the failure: no disabling, configureHost() turns it into a conflict
			isAbort: (err) => err?.protectedConflict === true,
			regenerate: async () => {
				await internalNginx.configureHost(model, other.host_type, row, {
					reload: false,
					depth: (depth || 0) + 1,
					protect,
				});
				logger.warn(
					`Regenerated the nginx config of ${hostLabel(other.host_type, row)} because nginx rejected it`,
				);
			},
			disable: async (regenerateError) => {
				if (regenerateError) {
					debug(logger, `Regenerating ${other.host_type} #${other.host_id} failed:`, regenerateError.message);
				}
				// The regenerated config's own failure explains best what is wrong with the host
				const regenerated =
					regenerateError instanceof errs.NginxConfigError && regenerateError.details?.scope === "host";
				const error = regenerated
					? new errs.NginxConfigError(
							regenerateError.message,
							Object.assign({}, regenerateError.details, { scope: "other_host" }),
						)
					: internalNginx.buildConfigError(
							"other_host",
							other.host_type,
							row || { id: other.host_id },
							parsed,
							readFileOrNull(filename) || fileText,
						);
				internalNginx.renameConfigAsErrorSync(filename);

				if (row) {
					const meta = internalNginx.buildOfflineMeta(row.meta, error, null, "Disabled automatically: ");
					await model.query().where("id", row.id).patch({ meta });
				}
				logger.warn(
					`Disabled the nginx config of ${hostLabel(other.host_type, row || { id: other.host_id })}: ${error.message}`,
				);
			},
		});
		return true;
	},

	/**
	 * @param   {Object}  oldMeta
	 * @param   {Error}   error   NginxConfigError
	 * @param   {Array}   [states]
	 * @param   {String}  [prefix]
	 * @returns {Object}
	 */
	buildOfflineMeta: (oldMeta, error, states, prefix = "") => {
		const meta = _.assign({}, oldMeta, {
			nginx_online: false,
			nginx_err: `${prefix}${error.message}`,
			nginx_details: error.details,
			nginx_checked_at: new Date().toISOString(),
		});
		if (states) {
			meta.nginx_locations = states.map(publicLocationState);
		}
		return meta;
	},

	/**
	 * @param   {String}  scope       host | other_host | global
	 * @param   {String}  hostType
	 * @param   {Object}  host
	 * @param   {Object}  parsed      parsed nginx -t output
	 * @param   {String}  configText  the host's generated config, used to locate the error
	 * @returns {errs.NginxConfigError}
	 */
	buildConfigError: (scope, hostType, host, parsed, configText) => {
		const filename = internalNginx.getConfigName(hostType, host.id);
		const humanised = parsed.message
			? humaniseNginxMessage(parsed.message)
			: { text: "nginx kept rejecting the configuration", hint: null };
		const ownFile = parsed.file === filename;
		const where = ownFile ? describeConfigLine(configText, parsed.line) : { location_index: null, area: null };
		const location = where.location_index !== null ? host.locations?.[where.location_index] : null;
		const locationPath = location ? `${location.path || ""}`.trim() : null;

		let message;
		if (scope === "global") {
			const managed = parseManagedFile(parsed.file);
			const fileInfo = parsed.file ? ` in ${parsed.file}${parsed.line ? ` (line ${parsed.line})` : ""}` : "";
			message = managed
				? `Nginx rejected ${hostLabel(managed.host_type, { id: managed.host_id })}: ${humanised.text}`
				: `Nginx configuration error${fileInfo}: ${humanised.text}`;
		} else if (where.area === "host_advanced") {
			message = `Advanced configuration: ${humanised.text} (line ${where.relative_line})`;
		} else if (where.area === "location_advanced") {
			message = `Custom location "${locationPath}" advanced configuration: ${humanised.text} (line ${where.relative_line})`;
		} else if (where.area === "location") {
			message = `Custom location "${locationPath}": ${humanised.text}`;
		} else {
			message = capitalise(humanised.text);
		}

		const managed = scope === "global" ? parseManagedFile(parsed.file) : null;
		return new errs.NginxConfigError(sentence(message), {
			kind: "nginx_config",
			scope,
			host_type: managed ? managed.host_type : scope === "global" ? null : hostType,
			host_id: managed ? managed.host_id : scope === "global" ? null : host.id,
			file: parsed.file || null,
			line: parsed.line || null,
			location_index: location ? where.location_index : null,
			location_path: locationPath,
			nginx_output: parsed.output || null,
			hint: humanised.hint || null,
		});
	},

	/**
	 * Never throws, false when in doubt.
	 *
	 * @param   {Object}  access    the request's Access object
	 * @param   {String}  hostType  proxy_host, redirection_host, dead_host or stream
	 * @param   {Number}  hostId
	 * @returns {Promise<boolean>} whether the user may see that host
	 */
	canSeeHost: async (access, hostType, hostId) => {
		try {
			const permission = hostType === "stream" ? "streams" : `${hostType}s`;
			const accessData = await access.can(`${permission}:list`);
			if (
				accessData === true ||
				accessData?.permission_visibility === "all" ||
				accessData?.roles?.includes("admin")
			) {
				return true;
			}
			if (HOST_MODELS[hostType]) {
				const row = await HOST_MODELS[hostType].query().where("id", hostId).first();
				return !!row && row.owner_user_id === access.token.getUserId(1);
			}
		} catch {
			// not visible
		}
		return false;
	},

	/**
	 * An NginxConfigError of scope "global" can name another host and include its nginx output. A user who
	 * can't see that host only gets a generic message. Never throws, redacts when in doubt.
	 *
	 * @param   {Object}  access  the request's Access object
	 * @param   {Error}   err
	 * @returns {Promise<Error>} err, modified in place
	 */
	redactConfigError: async (access, err) => {
		if (!(err instanceof errs.NginxConfigError) || err.details?.scope !== "global" || !err.details.host_id) {
			return err;
		}
		const { host_type: hostType, host_id: hostId } = err.details;
		const visible = await internalNginx.canSeeHost(access, hostType, hostId);
		if (!visible) {
			err.message = "Nginx rejected the configuration of another host. Please ask an administrator to check it.";
			err.details = Object.assign({}, err.details, {
				host_type: null,
				host_id: null,
				file: null,
				line: null,
				location_index: null,
				location_path: null,
				nginx_output: null,
				hint: null,
			});
		}
		return err;
	},

	/**
	 * @param   {Object} [own]       the host being configured
	 * @param   {String} [own.file]  its config file
	 * @param   {String} [own.text]  its new config
	 * @returns {Promise<{ok: boolean, parsed?: Object}>}
	 */
	runTest: async (own) => {
		try {
			await internalNginx.test();
			return { ok: true };
		} catch (err) {
			const output = err?.message || `${err}`;
			debug(logger, "Nginx test failed:", output);
			return { ok: false, parsed: internalNginx.attributeToHostFile(parseNginxTestOutput(output), own) };
		}
	},

	/**
	 * Blames an error that names no config file on the host being configured when its new config mentions
	 * a path named in the error, see lib/nginx-blame.js
	 *
	 * @param   {Object} parsed  parsed nginx -t output
	 * @param   {Object} [own]   {file, text} of the host being configured
	 * @returns {Object} parsed, with file set when the host being configured is to blame
	 */
	attributeToHostFile: (parsed, own) => attributeToHostFile(parsed, own),

	/**
	 * @returns {Array<{file: String, text: String}>} the managed host config files, in the order nginx and
	 *          prepare/55-nginx-validate.sh read them in
	 */
	listManagedFiles: () => {
		const out = [];
		for (const hostType of Object.keys(HOST_MODELS)) {
			const dir = `/data/nginx/${hostType}`;
			let files = [];
			try {
				files = fs
					.readdirSync(dir)
					.filter((f) => /^\d+\.conf$/.test(f))
					.sort();
			} catch {
				continue;
			}
			for (const file of files) {
				out.push({ file: `${dir}/${file}`, text: readFileOrNull(`${dir}/${file}`) || "" });
			}
		}
		return out;
	},

	/**
	 * Plain `nginx -t` of the whole configuration
	 *
	 * @returns {Promise}
	 */
	test: () => {
		debug(logger, "Testing Nginx configuration");
		return utils.execFile("/usr/sbin/nginx", ["-t", "-g", "error_log off;"]);
	},

	/**
	 * Tests the config, repairing or moving aside broken files of managed hosts.
	 * Throws an NginxConfigError (scope global) when the config can't be repaired.
	 * Only call this while holding the lock.
	 *
	 * @returns {Promise}
	 */
	testAndHeal: async () => {
		for (let i = 0; i <= MAX_HEAL_ITERATIONS; i++) {
			const result = await internalNginx.runTest();
			if (result.ok) {
				return;
			}
			if (i === MAX_HEAL_ITERATIONS) {
				break;
			}
			const parsed = result.parsed;
			const named = parseManagedFile(parsed.file);
			let targets = named ? [{ other: named, parsed }] : [];
			if (!named && !parsed.file) {
				// eg. a log file that can't be opened: blame the host(s) whose removal makes the error go away
				const blame = await blameUnattributed(parsed, {
					listFiles: internalNginx.listManagedFiles,
					testWithoutCandidate: (file) => internalNginx.testAside([file]),
					testWithoutCandidates: (files) => internalNginx.testAside(files),
				});
				if (blame.action === "heal") {
					targets = (blame.others || [blame.other]).map((other) => ({
						other,
						parsed: Object.assign({}, blame.parsed, {
							file: internalNginx.getConfigName(other.host_type, other.host_id),
						}),
					}));
				}
			}
			let healed = false;
			for (const target of targets) {
				if (await internalNginx.healOtherHost(target.other, target.parsed, 0)) {
					healed = true;
				}
			}
			if (healed) {
				continue;
			}
			throw internalNginx.buildConfigError("global", "default", { id: 0 }, result.parsed, "");
		}
		logger.error(TOO_MANY_BROKEN_HOSTS);
		throw new errs.NginxConfigError(TOO_MANY_BROKEN_HOSTS, {
			kind: "nginx_config",
			scope: "global",
		});
	},

	/**
	 * Only call this while holding the lock.
	 *
	 * @param   {Object}  [opts]
	 * @param   {Boolean} [opts.skipTest]
	 * @returns {Promise}
	 */
	reloadNginx: async (opts = {}) => {
		if (!opts.skipTest) {
			await internalNginx.testAndHeal();
		}
		logger.info("Reloading Nginx");
		return utils.execFile("/usr/sbin/nginx", ["-s", "reload"]);
	},

	/**
	 * Tests (repairing broken files of other hosts) and reloads nginx
	 *
	 * @returns {Promise}
	 */
	reload: () => withLock(() => internalNginx.reloadNginx()),

	/**
	 * Removes the config of a host and reloads nginx
	 *
	 * @param   {String}  host_type
	 * @param   {Object}  host
	 * @returns {Promise}
	 */
	removeConfigAndReload: (host_type, host) =>
		withLock(async () => {
			await internalNginx.deleteConfig(host_type, host);
			return internalNginx.reloadNginx();
		}),

	/**
	 * Regenerates the default site config and reloads nginx.
	 * On failure the default site config is removed, nginx falls back to the built-in default.
	 *
	 * @param   {Object}  setting  the default-site setting row
	 * @returns {Promise}
	 */
	configureDefaultSite: (setting) =>
		withLock(async () => {
			await internalNginx.deleteConfig("default");
			await internalNginx.generateConfig("default", setting);
			try {
				await internalNginx.reloadNginx();
			} catch (err) {
				await internalNginx.deleteConfig("default");
				await internalNginx.reloadNginx().catch((reloadErr) => {
					logger.error(`Could not reload nginx: ${reloadErr.message}`);
				});
				if (err instanceof errs.NginxConfigError) {
					throw new errs.NginxConfigError(
						`Could not reconfigure the default site. ${err.message}`,
						err.details,
						err,
					);
				}
				throw new errs.ValidationError("Could not reconfigure Nginx. Please check logs.", err);
			}
		}),

	/**
	 * @param   {String}       filename
	 * @param   {String|null}  previous
	 */
	restoreConfig: (filename, previous) => {
		if (previous === null) {
			internalNginx.deleteFile(filename);
			return;
		}
		try {
			fs.writeFileSync(filename, previous, { encoding: "utf8" });
		} catch (err) {
			logger.error(`Could not restore ${filename}: ${err.message}`);
		}
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Integer} host_id
	 * @returns {String}
	 */
	getConfigName: (host_type, host_id) => {
		if (host_type === "default") {
			return "/data/nginx/default_host/site.conf";
		}
		return `/data/nginx/${internalNginx.getFileFriendlyHostType(host_type)}/${host_id}.conf`;
	},

	/**
	 * Generates custom locations
	 *
	 * @param   {Object}  host
	 * @param   {Array}   states  from computeLocationStates()
	 * @returns {Promise<String>}
	 */
	renderLocations: async (host, states) => {
		let template;
		try {
			template = readLocationTemplate();
		} catch (err) {
			throw new errs.ConfigurationError(err.message);
		}

		const renderEngine = utils.getRenderEngine();
		let renderedLocations = "";

		for (let i = 0; i < host.locations.length; i++) {
			const state = states[i];
			const locationCopy = Object.assign(
				{},
				{ access_list_id: host.access_list_id },
				{ certificate_id: host.certificate_id },
				{ ssl_forced: host.ssl_forced },
				{ caching_enabled: host.caching_enabled },
				{ block_exploits: host.block_exploits },
				{ allow_websocket_upgrade: host.allow_websocket_upgrade },
				{ http2_support: host.http2_support },
				{ hsts_enabled: host.hsts_enabled },
				{ hsts_subdomains: host.hsts_subdomains },
				{ access_list: host.access_list },
				{ certificate: host.certificate },
				prepareLocation(host.locations[i]),
			);

			if (state.status === "ok" || state.status === "unresolved") {
				// A location with its own access list overrides the host's,
				// otherwise it inherits the host's access list
				let locationAccessList = null;
				if (locationCopy.access_list_id > 0 && locationCopy.access_list_id !== host.access_list?.id) {
					locationAccessList = await accessListModel
						.query()
						.where("is_deleted", 0)
						.andWhere("id", locationCopy.access_list_id)
						.withGraphFetched("[clients,items]")
						.first();
				}
				if (locationAccessList) {
					locationCopy.access_list = locationAccessList;
				} else {
					locationCopy.access_list_id = host.access_list_id;
					locationCopy.access_list = host.access_list;
				}
			}

			renderedLocations += await renderLocation(renderEngine, template, locationCopy, state);
		}
		return renderedLocations;
	},

	/**
	 * Renders and writes the config file of a host.
	 *
	 * @param   {String}  host_type
	 * @param   {Object}  host_row
	 * @param   {Object}  [opts]
	 * @param   {Array}   [opts.locationStates]  from computeLocationStates(), computed when missing
	 * @returns {Promise<String>} the written config
	 */
	generateConfig: async (host_type, host_row, opts = {}) => {
		// Prevent modifying the original object:
		const host = JSON.parse(JSON.stringify(host_row));
		const nice_host_type = internalNginx.getFileFriendlyHostType(host_type);

		await internalNginx.loadRenderRelations(nice_host_type, host);

		debug(logger, `Generating ${nice_host_type} Config:`, JSON.stringify(host, null, 2));

		const renderEngine = utils.getRenderEngine();
		const filename = internalNginx.getConfigName(nice_host_type, host.id);

		let template = null;
		try {
			template = fs.readFileSync(`${__dirname}/../templates/${nice_host_type}.conf`, { encoding: "utf8" });
		} catch (err) {
			throw new errs.ConfigurationError(err.message);
		}

		// Manipulate the data a bit before sending it to the template
		if (nice_host_type !== "default") {
			host.use_default_location = true;
			if (typeof host.advanced_config !== "undefined" && host.advanced_config) {
				host.use_default_location = !internalNginx.advancedConfigHasDefaultLocation(host.advanced_config);
			}
		}

		// For redirection hosts, if the scheme is not http or https, set it to $scheme
		if (
			nice_host_type === "redirection_host" &&
			["http", "https"].indexOf(host.forward_scheme.toLowerCase()) === -1
		) {
			host.forward_scheme = "$scheme";
		}

		// A stream forwarding to an IPv6 literal must have the address wrapped in
		// square brackets before nginx appends ":<port>". Without the brackets nginx
		// reads the trailing ":<port>" as part of the address and rejects the upstream
		// ("invalid port in upstream"), so the stream saves but never activates (#5740).
		if (nice_host_type === "stream" && net.isIPv6(host.forwarding_host)) {
			host.forwarding_host = `[${host.forwarding_host}]`;
		}

		if (Array.isArray(host.locations) && host.locations.length) {
			const states =
				opts.locationStates ||
				(await internalNginx.computeLocationStates(host.locations, createModeResolver()));

			// Allow someone who is using / custom location path to use it, and skip the default / location.
			// A location the user disabled doesn't count, the default location takes over.
			host.locations.forEach((location, index) => {
				if (parseLocationPath(location.path).normalised === "/" && states[index].status !== "disabled") {
					host.use_default_location = false;
				}
			});

			try {
				host.locations = await internalNginx.renderLocations(host, states);
			} catch (err) {
				debug(logger, `Could not render locations for ${filename}:`, err.message);
				throw new errs.ConfigurationError(err.message);
			}
		} else if (Array.isArray(host.locations)) {
			host.locations = "";
		}

		// Set the IPv6 setting for the host
		host.ipv6 = internalNginx.ipv6Enabled();

		let config_text;
		try {
			config_text = await renderEngine.parseAndRender(template, host);
			fs.writeFileSync(filename, config_text, { encoding: "utf8" });
		} catch (err) {
			debug(logger, `Could not write ${filename}:`, err.message);
			throw new errs.ConfigurationError(err.message);
		}
		debug(logger, "Wrote config:", filename, config_text);
		return config_text;
	},

	/**
	 * The templates rely on the certificate and access list relations being loaded.
	 * Not every caller fetches them (or fetches them fully), and when they're missing
	 * the config silently renders without SSL or without any access rules (#5919).
	 * Load anything that is referenced but not loaded onto the given host object.
	 *
	 * @param   {String}  host_type
	 * @param   {Object}  host
	 * @returns {Promise}
	 */
	loadRenderRelations: async (host_type, host) => {
		if (host.certificate_id > 0 && host.certificate?.id !== host.certificate_id) {
			const certificate = await certificateModel
				.query()
				.where("is_deleted", 0)
				.andWhere("id", host.certificate_id)
				.first();
			host.certificate = certificate ? JSON.parse(JSON.stringify(certificate)) : null;
		}

		if (host_type === "proxy_host" && host.access_list_id > 0) {
			if (
				host.access_list?.id !== host.access_list_id ||
				!Array.isArray(host.access_list.clients) ||
				!Array.isArray(host.access_list.items)
			) {
				const accessList = await accessListModel
					.query()
					.where("is_deleted", 0)
					.andWhere("id", host.access_list_id)
					.withGraphFetched("[clients,items]")
					.first();
				host.access_list = accessList ? JSON.parse(JSON.stringify(accessList)) : null;
			}

			if (!host.access_list) {
				logger.warn(
					`Proxy Host #${host.id} references Access List #${host.access_list_id} which does not exist`,
				);
			} else if (!host.access_list.clients.length && !host.access_list.items.length) {
				logger.warn(
					`Proxy Host #${host.id} uses Access List #${host.access_list_id} which has no clients or authorizations, no access restrictions will apply`,
				);
			}
		}
	},

	/**
	 * This generates a temporary nginx config listening on port 80 for the domain names listed
	 * in the certificate setup. It allows the letsencrypt acme challenge to be requested by letsencrypt
	 * when requesting a certificate without having a hostname set up already.
	 *
	 * @param   {Object}  certificate
	 * @returns {Promise}
	 */
	generateLetsEncryptRequestConfig: (certificate) => {
		debug(logger, "Generating LetsEncrypt Request Config:", certificate);
		const renderEngine = utils.getRenderEngine();

		return new Promise((resolve, reject) => {
			let template = null;
			const filename = `/data/nginx/temp/letsencrypt_${certificate.id}.conf`;

			try {
				template = fs.readFileSync(`${__dirname}/../templates/letsencrypt-request.conf`, { encoding: "utf8" });
			} catch (err) {
				reject(new errs.ConfigurationError(err.message));
				return;
			}

			certificate.ipv6 = internalNginx.ipv6Enabled();

			renderEngine
				.parseAndRender(template, certificate)
				.then((config_text) => {
					fs.writeFileSync(filename, config_text, { encoding: "utf8" });
					debug(logger, "Wrote config:", filename, config_text);
					resolve(true);
				})
				.catch((err) => {
					debug(logger, `Could not write ${filename}:`, err.message);
					reject(new errs.ConfigurationError(err.message));
				});
		});
	},

	/**
	 * A simple wrapper around unlinkSync that writes to the logger
	 *
	 * @param   {String}  filename
	 */
	deleteFile: (filename) => {
		if (!fs.existsSync(filename)) {
			return;
		}
		try {
			debug(logger, `Deleting file: ${filename}`);
			fs.unlinkSync(filename);
		} catch (err) {
			debug(logger, "Could not delete file:", JSON.stringify(err, null, 2));
		}
	},

	/**
	 *
	 * @param   {String} host_type
	 * @returns String
	 */
	getFileFriendlyHostType: (host_type) => {
		return host_type.replace(/-/g, "_");
	},

	/**
	 * This removes the temporary nginx config file generated by `generateLetsEncryptRequestConfig`
	 *
	 * @param   {Object}  certificate
	 * @returns {Promise}
	 */
	deleteLetsEncryptRequestConfig: (certificate) => {
		const config_file = `/data/nginx/temp/letsencrypt_${certificate.id}.conf`;
		return new Promise((resolve /*, reject*/) => {
			internalNginx.deleteFile(config_file);
			resolve();
		});
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Object}  [host]
	 * @param   {Boolean} [delete_err_file]
	 * @returns {Promise}
	 */
	deleteConfig: (host_type, host, delete_err_file) => {
		const config_file = internalNginx.getConfigName(
			internalNginx.getFileFriendlyHostType(host_type),
			typeof host === "undefined" ? 0 : host.id,
		);
		const config_file_err = `${config_file}.err`;

		return new Promise((resolve /*, reject*/) => {
			internalNginx.deleteFile(config_file);
			if (delete_err_file) {
				internalNginx.deleteFile(config_file_err);
			}
			resolve();
		});
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Object}  [host]
	 * @returns {Promise}
	 */
	renameConfigAsError: (host_type, host) => {
		const config_file = internalNginx.getConfigName(
			internalNginx.getFileFriendlyHostType(host_type),
			typeof host === "undefined" ? 0 : host.id,
		);
		return new Promise((resolve) => {
			internalNginx.renameConfigAsErrorSync(config_file);
			resolve();
		});
	},

	/**
	 * Moves a config to <file>.err, which nginx does not include, keeping it for inspection.
	 *
	 * @param   {String}  config_file
	 */
	renameConfigAsErrorSync: (config_file) => {
		const config_file_err = `${config_file}.err`;
		try {
			fs.rmSync(config_file_err, { force: true });
			if (fs.existsSync(config_file)) {
				fs.renameSync(config_file, config_file_err);
			}
		} catch (err) {
			logger.warn(`Could not move ${config_file} to ${config_file_err}: ${err.message}`);
			internalNginx.deleteFile(config_file);
		}
	},

	/**
	 * Regenerates the configs of several hosts (eg. after an access list or certificate change).
	 * Each host goes through configure without reloading, a host that nginx rejects is taken
	 * offline instead of failing the whole operation. The caller reloads nginx afterwards.
	 *
	 * @param   {String}  hostType
	 * @param   {Array}   hosts
	 * @returns {Promise}
	 */
	bulkGenerateConfigs: (hostType, hosts) =>
		withLock(async () => {
			const type = internalNginx.getFileFriendlyHostType(hostType);
			const model = HOST_MODELS[type];
			const modeResolver = createModeResolver();
			for (const staleHost of hosts || []) {
				if (!staleHost?.id) {
					continue;
				}
				// The rows were loaded before the lock was taken, sometimes minutes before (a certificate
				// request). Configure from the current row, or a concurrent edit (its locations, its meta)
				// would be overwritten with the old values.
				const host = await internalNginx.loadHostRow(type, staleHost.id);
				if (!host?.enabled) {
					continue;
				}
				await internalNginx.configureHost(model, type, host, {
					reload: false,
					depth: 0,
					modeResolver,
					offlineOnError: true,
				});
			}
		}),

	/**
	 * @param   {String}  hostType  file friendly host type
	 * @param   {Number}  id
	 * @returns {Promise<Object|undefined>} the non-deleted row with the relations the templates need
	 */
	loadHostRow: (hostType, id) => {
		const model = HOST_MODELS[hostType];
		return model
			.query()
			.where("is_deleted", 0)
			.andWhere("id", id)
			.allowGraph(model.defaultAllowGraph)
			.withGraphFetched(`[${model.defaultExpand.join(", ")}]`)
			.first();
	},

	/**
	 * @param   {String}  host_type
	 * @param   {Array}   hosts
	 * @returns {Promise}
	 */
	bulkDeleteConfigs: (host_type, hosts) => {
		const promises = [];
		hosts.map((host) => {
			promises.push(internalNginx.deleteConfig(host_type, host, true));
			return true;
		});

		return Promise.all(promises);
	},

	/**
	 * Called once after the backend started: regenerates hosts whose config is missing, was moved aside
	 * (by the prepare/55-nginx-validate.sh startup check or a failed test), or was written by an older
	 * version (literal custom location upstreams). Never throws.
	 *
	 * Upstream names often don't resolve yet right after a host reboot (all containers start at once).
	 * Hosts that end offline because of that, and proxy hosts with unresolved custom locations, are tried
	 * again a few times with backoff (RECONCILE_RETRY_DELAYS), so they come back on their own.
	 *
	 * @param   {Object}  [opts]
	 * @param   {Object}  [opts.only]     {host_type: [ids]}, configure exactly these hosts (retry pass)
	 * @param   {Number}  [opts.attempt]  retry attempt, 0 for the startup pass
	 * @returns {Promise<Object>} summary
	 */
	reconcile: (opts = {}) =>
		withLock(async () => {
			const attempt = opts.attempt || 0;
			const summary = { checked: 0, regenerated: 0, offline: 0, failed: 0, retry: {} };
			const modeResolver = createModeResolver();
			if (!opts.only) {
				internalNginx.restoreStaleAside();
			}

			for (const [hostType, model] of Object.entries(HOST_MODELS)) {
				const only = opts.only ? opts.only[hostType] : null;
				if (opts.only && !only?.length) {
					continue;
				}
				let rows = [];
				try {
					const query = model
						.query()
						.where("is_deleted", 0)
						.andWhere("enabled", 1)
						.allowGraph(model.defaultAllowGraph)
						.withGraphFetched(`[${model.defaultExpand.join(", ")}]`);
					if (only) {
						query.whereIn("id", only);
					}
					rows = await query;
				} catch (err) {
					logger.error(`Startup reconcile: could not load ${hostType} rows: ${err.message}`);
					continue;
				}

				for (const row of rows) {
					summary.checked++;
					const filename = internalNginx.getConfigName(hostType, row.id);
					const text = readFileOrNull(filename);
					const needsWork =
						!!only ||
						text === null ||
						fs.existsSync(`${filename}.err`) ||
						(hostType === "proxy_host" &&
							Array.isArray(row.locations) &&
							row.locations.length > 0 &&
							text.indexOf(CONFIG_VERSION_MARKER) === -1);
					if (!needsWork) {
						continue;
					}
					try {
						const meta = await internalNginx.configureHost(model, hostType, row, {
							reload: false,
							depth: 0,
							modeResolver,
							offlineOnError: true,
						});
						if (meta.nginx_online === false) {
							summary.offline++;
						} else {
							summary.regenerated++;
						}
						if (mayResolveLater(meta)) {
							summary.retry[hostType] = summary.retry[hostType] || [];
							summary.retry[hostType].push(row.id);
						}
					} catch (err) {
						summary.failed++;
						logger.error(`Startup reconcile: ${hostLabel(hostType, row)}: ${err.message}`);
					}
				}
			}

			if (summary.regenerated || summary.offline) {
				try {
					await internalNginx.reloadNginx();
				} catch (err) {
					logger.error(`Startup reconcile: nginx reload failed: ${err.message}`);
				}
			}
			const retries = Object.values(summary.retry).reduce((sum, ids) => sum + ids.length, 0);
			logger.info(
				`Startup reconcile${attempt ? ` (retry ${attempt})` : ""}: checked ${summary.checked} hosts, regenerated ${summary.regenerated}, offline ${summary.offline}, failed ${summary.failed}${retries ? `, ${retries} waiting for DNS` : ""}`,
			);

			if (retries && attempt < RECONCILE_RETRY_DELAYS.length) {
				// Outside the lock context: the retry has to queue for the lock like any other caller
				runOutsideLock(() => {
					const timer = setTimeout(() => {
						internalNginx.reconcile({ only: summary.retry, attempt: attempt + 1 });
					}, RECONCILE_RETRY_DELAYS[attempt]);
					timer.unref?.();
				});
			}
			return summary;
		}).catch((err) => {
			logger.error(`Startup reconcile failed: ${err.message}`);
			return null;
		}),

	/**
	 * testAside() moves config files to `<file>.npm-aside` for a moment. A backend killed right then leaves
	 * them there: put them back, or delete them when the config was written again since. Only call this
	 * while holding the lock.
	 *
	 * @returns {Number} how many files were handled
	 */
	restoreStaleAside: () => {
		let handled = 0;
		// files of a dry run of a new host, see dryRun()
		internalNginx.removeDryRunFiles();
		for (const hostType of [...Object.keys(HOST_MODELS), "default_host"]) {
			const dir = `/data/nginx/${hostType}`;
			let files = [];
			try {
				files = fs.readdirSync(dir).filter((f) => f.endsWith(".conf.npm-aside"));
			} catch {
				continue;
			}
			for (const file of files) {
				const aside = `${dir}/${file}`;
				const conf = aside.slice(0, -".npm-aside".length);
				try {
					if (fs.existsSync(conf)) {
						fs.rmSync(aside, { force: true });
					} else {
						fs.renameSync(aside, conf);
						logger.warn(`Restored ${conf} from an interrupted config test`);
					}
					handled++;
				} catch (err) {
					logger.error(`Could not restore ${conf} from ${aside}: ${err.message}`);
				}
			}
		}
		return handled;
	},

	/**
	 * @returns {boolean}
	 */
	reconcileOnStartEnabled: () => toBool(process.env.NPM_RECONCILE_ON_START, true),

	/**
	 * @param   {string}  config
	 * @returns {boolean}
	 */
	advancedConfigHasDefaultLocation: (cfg) => !!cfg.match(/^(?:.*;)?\s*?location\s*?\/\s*?{/im),

	/**
	 * @returns {boolean}
	 */
	ipv6Enabled: () => {
		if (typeof process.env.DISABLE_IPV6 !== "undefined") {
			const disabled = process.env.DISABLE_IPV6.toLowerCase();
			return !(disabled === "on" || disabled === "true" || disabled === "1" || disabled === "yes");
		}

		return true;
	},
};

export default internalNginx;
