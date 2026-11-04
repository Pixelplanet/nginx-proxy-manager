import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import _ from "lodash";
import errs from "../lib/error.js";
import {
	capitalise,
	humaniseNginxMessage,
	parseManagedFile,
	parseNginxTestOutput,
	sentence,
} from "../lib/nginx-errors.js";
import {
	CONFIG_VERSION_MARKER,
	describeConfigLine,
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

// How often a broken file of another host may be repaired / moved aside in one test
const MAX_HEAL_ITERATIONS = 100;
// Extra configure iterations on top of one per location
const EXTRA_CONFIGURE_ITERATIONS = 10;

/**
 * Every sequence that writes nginx config, tests it and reloads nginx runs through this lock,
 * otherwise concurrent saves test and rename each other's files. Re-entrant: code that already
 * holds the lock runs directly.
 */
const lockStorage = new AsyncLocalStorage();
let lockQueue = Promise.resolve();

const withLock = (fn) => {
	if (lockStorage.getStore()) {
		return fn();
	}
	const run = lockQueue.then(() => lockStorage.run(true, fn));
	lockQueue = run.catch(() => {});
	return run;
};

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
	 * @returns {Promise<Object>} the new meta
	 */
	configure: (model, host_type, host, opts = {}) => {
		return withLock(() =>
			internalNginx.configureHost(model, host_type, host, {
				reload: opts.reload !== false,
				depth: 0,
			}),
		);
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
			if (quarantines > maxQuarantines || heals > MAX_HEAL_ITERATIONS) {
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

			const result = await internalNginx.runTest();
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

			const other = parseManagedFile(parsed.file);
			if (other && (await internalNginx.healOtherHost(other, parsed, opts.depth))) {
				heals++;
				continue;
			}

			failure = { scope: "global", parsed };
			break;
		}

		if (failure) {
			const error = internalNginx.buildConfigError(failure.scope, hostType, host, failure.parsed, configText);
			if (opts.offlineOnError && failure.scope === "host") {
				// Bulk mode: don't fail the whole operation because of one host, take it offline instead
				internalNginx.renameConfigAsErrorSync(filename);
				const meta = internalNginx.buildOfflineMeta(host.meta, error, states);
				await model.query().where("id", host.id).patch({ meta });
				logger.warn(`${hostLabel(hostType, host)} is offline: ${error.message}`);
				return meta;
			}
			await internalNginx.restoreHost(model, host, filename, previous, previousErr, heals > 0);
			throw error;
		}

		internalNginx.deleteFile(`${filename}.err`);
		const meta = _.assign({}, host.meta, {
			nginx_online: true,
			nginx_err: null,
			nginx_details: null,
			nginx_checked_at: new Date().toISOString(),
		});
		if (hostType === "proxy_host") {
			meta.nginx_locations = states ? states.map(publicLocationState) : [];
		}

		await model.query().where("id", host.id).patch({ meta });

		if (opts.reload) {
			// The config was just tested while holding the lock, no need to test again
			await internalNginx.reloadNginx({ skipTest: true });
		}
		return meta;
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
				const result = await modeResolver(loc.forward_host);
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
	 * Another host's config file breaks `nginx -t`. Proxy hosts are regenerated first (their custom
	 * locations get quarantined, old literal upstreams become dynamic), anything else is moved to .err
	 * and the host is marked offline.
	 *
	 * @param   {Object}  other   {host_type, host_id}
	 * @param   {Object}  parsed  parsed nginx -t output
	 * @param   {Number}  depth
	 * @returns {Promise<boolean>} true when something was changed and the test should be repeated
	 */
	healOtherHost: async (other, parsed, depth) => {
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

		if (row?.enabled && other.host_type === "proxy_host" && (depth || 0) < 1) {
			const where = describeConfigLine(fileText, parsed.line);
			if (where.location_index !== null || fileText.indexOf(CONFIG_VERSION_MARKER) === -1) {
				try {
					await internalNginx.configureHost(model, other.host_type, row, {
						reload: false,
						depth: (depth || 0) + 1,
					});
					logger.warn(
						`Regenerated the nginx config of ${hostLabel(other.host_type, row)} because nginx rejected it`,
					);
					return true;
				} catch (err) {
					debug(logger, `Regenerating ${other.host_type} #${other.host_id} failed:`, err.message);
				}
			}
		}

		const error = internalNginx.buildConfigError(
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
		let visible = false;
		try {
			const permission = hostType === "stream" ? "streams" : `${hostType}s`;
			const accessData = await access.can(`${permission}:list`);
			if (
				accessData === true ||
				accessData?.permission_visibility === "all" ||
				accessData?.roles?.includes("admin")
			) {
				visible = true;
			} else if (HOST_MODELS[hostType]) {
				const row = await HOST_MODELS[hostType].query().where("id", hostId).first();
				visible = !!row && row.owner_user_id === access.token.getUserId(1);
			}
		} catch {
			visible = false;
		}
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
	 * @returns {Promise<{ok: boolean, parsed?: Object}>}
	 */
	runTest: async () => {
		try {
			await internalNginx.test();
			return { ok: true };
		} catch (err) {
			const output = err?.message || `${err}`;
			debug(logger, "Nginx test failed:", output);
			return { ok: false, parsed: internalNginx.attributeToHostFile(parseNginxTestOutput(output)) };
		}
	},

	/**
	 * Some errors (eg. `cannot load certificate "/etc/letsencrypt/live/npm-1/fullchain.pem"`) don't name the
	 * config file. When the message names a file path, the host config that references it is blamed.
	 *
	 * @param   {Object} parsed  parsed nginx -t output
	 * @returns {Object} parsed, with file set when a host config could be found
	 */
	attributeToHostFile: (parsed) => {
		if (parsed.file) {
			return parsed;
		}
		const paths = [...`${parsed.message}`.matchAll(/"(\/[^"\s]+)"/g)].map((m) => m[1]);
		if (!paths.length) {
			return parsed;
		}
		for (const hostType of Object.keys(HOST_MODELS)) {
			const dir = `/data/nginx/${hostType}`;
			let files = [];
			try {
				files = fs.readdirSync(dir).filter((f) => /^\d+\.conf$/.test(f));
			} catch {
				continue;
			}
			for (const file of files) {
				const text = readFileOrNull(`${dir}/${file}`) || "";
				if (paths.some((p) => text.includes(p))) {
					return Object.assign({}, parsed, { file: `${dir}/${file}` });
				}
			}
		}
		return parsed;
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
		for (let i = 0; i < MAX_HEAL_ITERATIONS; i++) {
			const result = await internalNginx.runTest();
			if (result.ok) {
				return;
			}
			const other = parseManagedFile(result.parsed.file);
			if (other && (await internalNginx.healOtherHost(other, result.parsed, 0))) {
				continue;
			}
			throw internalNginx.buildConfigError("global", "default", { id: 0 }, result.parsed, "");
		}
		throw new errs.NginxConfigError("Nginx kept rejecting the configuration.", {
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
			for (const host of hosts || []) {
				if (!host?.enabled || host.is_deleted) {
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
	 * @returns {Promise<Object>} summary
	 */
	reconcile: () =>
		withLock(async () => {
			const summary = { checked: 0, regenerated: 0, offline: 0, failed: 0 };
			const modeResolver = createModeResolver();

			for (const [hostType, model] of Object.entries(HOST_MODELS)) {
				let rows = [];
				try {
					rows = await model
						.query()
						.where("is_deleted", 0)
						.andWhere("enabled", 1)
						.allowGraph(model.defaultAllowGraph)
						.withGraphFetched(`[${model.defaultExpand.join(", ")}]`);
				} catch (err) {
					logger.error(`Startup reconcile: could not load ${hostType} rows: ${err.message}`);
					continue;
				}

				for (const row of rows) {
					summary.checked++;
					const filename = internalNginx.getConfigName(hostType, row.id);
					const text = readFileOrNull(filename);
					const needsWork =
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
			logger.info(
				`Startup reconcile: checked ${summary.checked} hosts, regenerated ${summary.regenerated}, offline ${summary.offline}, failed ${summary.failed}`,
			);
			return summary;
		}).catch((err) => {
			logger.error(`Startup reconcile failed: ${err.message}`);
			return null;
		}),

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
