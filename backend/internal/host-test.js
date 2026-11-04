import _ from "lodash";
import errs from "../lib/error.js";
import { buildTestResult, buildTestTargets, mergeTargetResults, WARNING_MESSAGES } from "../lib/host-test.js";
import { checkTargets } from "../lib/upstream/check.js";
import { isUpstreamCheckEnabled } from "../lib/upstream/config.js";
import { TooManyRequestsError } from "../lib/upstream/errors.js";
import { createRateLimiter } from "../lib/upstream/rate-limit.js";
import { debug, global as logger } from "../logger.js";
import deadHostModel from "../models/dead_host.js";
import proxyHostModel from "../models/proxy_host.js";
import redirectionHostModel from "../models/redirection_host.js";
import streamModel from "../models/stream.js";
import internalDeadHost from "./dead-host.js";
import internalHost from "./host.js";
import internalNginx from "./nginx.js";
import internalProxyHost from "./proxy-host.js";
import internalRedirectionHost from "./redirection-host.js";
import internalStream from "./stream.js";

/**
 * "Test config": checks a host's settings the way a save would, without saving anything.
 * POST /api/nginx/(proxy-hosts|redirection-hosts|dead-hosts|streams)/test
 */

const testLimiter = createRateLimiter({ limit: 30, windowMs: 60 * 1000 });

const HOST_TYPES = {
	proxy_host: {
		model: proxyHostModel,
		permission: "proxy_hosts",
		hostnameType: "proxy",
		get: (access, data) => internalProxyHost.get(access, data),
		expand: ["owner", "certificate", "access_list.[clients,items]"],
		defaults: { advanced_config: "", locations: [] },
	},
	redirection_host: {
		model: redirectionHostModel,
		permission: "redirection_hosts",
		hostnameType: "redirection",
		get: (access, data) => internalRedirectionHost.get(access, data),
		expand: ["owner", "certificate"],
		defaults: { advanced_config: "" },
	},
	dead_host: {
		model: deadHostModel,
		permission: "dead_hosts",
		hostnameType: "dead",
		get: (access, data) => internalDeadHost.get(access, data),
		expand: ["owner", "certificate"],
		defaults: { advanced_config: "" },
	},
	stream: {
		model: streamModel,
		permission: "streams",
		hostnameType: null,
		get: (access, data) => internalStream.get(access, data),
		expand: ["owner", "certificate"],
		defaults: {},
	},
};

const internalHostTest = {
	/**
	 * @param   {Access}  access
	 * @param   {String}  hostType  proxy_host, redirection_host, dead_host or stream
	 * @param   {Object}  data      the create payload of that host type, plus `id` when testing an edit
	 * @returns {Promise<Object>}   see lib/host-test.js buildTestResult()
	 */
	test: async (access, hostType, data) => {
		const type = HOST_TYPES[hostType];
		if (!type) {
			throw new errs.InternalValidationError(`Unknown host type ${hostType}`);
		}

		// Same input hygiene as create/update: strips server-owned meta, trims hosts, duplicate location paths
		// and forbidden file directives are 400s
		const input = internalHost.sanitiseInput(structuredClone(data || {}));
		const id = input.id ? Number.parseInt(input.id, 10) : null;
		delete input.id;

		if (id) {
			await access.can(`${type.permission}:update`, id);
		} else {
			await access.can(`${type.permission}:create`, input);
		}

		const limit = testLimiter.consume(`${access.token.getUserId(0)}`);
		if (!limit.ok) {
			throw new TooManyRequestsError(
				`Too many configuration tests. Try again in ${limit.retryAfter} seconds.`,
				limit.retryAfter,
			);
		}

		const warnings = [];
		if (input.certificate_id === "new") {
			// Like create/update before the certificate exists: the host is checked without SSL
			delete input.certificate_id;
			warnings.push({ code: "certificate_pending", message: WARNING_MESSAGES.certificate_pending });
		}

		if (type.hostnameType && Array.isArray(input.domain_names)) {
			const results = await Promise.all(
				input.domain_names.map((name) =>
					internalHost.isHostnameTaken(name, id ? type.hostnameType : undefined, id || undefined),
				),
			);
			for (const result of results) {
				if (result.is_taken) {
					throw new errs.ValidationError(`${result.hostname} is already in use`);
				}
			}
		}

		const host = await internalHostTest.buildHost(access, type, hostType, id, input);
		const targets = buildTestTargets(hostType, host);

		const [dry, results] = await Promise.all([
			internalNginx.dryRun(type.model, hostType, host),
			targets.length ? checkTargets(targets, { enabled: isUpstreamCheckEnabled() }) : Promise.resolve([]),
		]);

		let error = dry.error;
		if (error) {
			error = await internalNginx.redactConfigError(access, error);
			if (!id && error.details) {
				// The temporary config of a new host is no file the user can look at
				error.details = Object.assign({}, error.details, {
					host_id: error.details.host_id === internalNginx.DRY_RUN_ID ? null : error.details.host_id,
					file: `${error.details.file || ""}`.includes(internalNginx.DRY_RUN_ID) ? null : error.details.file,
				});
			}
		}

		for (const other of dry.aside) {
			const visible = await internalNginx.canSeeHost(access, other.host_type, other.host_id);
			warnings.push(
				visible
					? {
							code: "other_host_broken",
							message: `${other.message} Saving would repair or disable it.`,
							host_type: other.host_type,
							host_id: other.host_id,
						}
					: { code: "other_host_broken", message: WARNING_MESSAGES.other_host_hidden, host_type: null, host_id: null },
			);
		}

		const result = buildTestResult({
			meta: dry.meta,
			error,
			locations: dry.locations,
			upstreams: mergeTargetResults(targets, results),
			warnings,
		});
		debug(
			logger,
			`Config test of ${hostType} ${id ? `#${id}` : "(new)"}: ok=${result.ok} online=${result.nginx_online}`,
		);
		return result;
	},

	/**
	 * The host as a save would store and configure it
	 *
	 * @param   {Access}       access
	 * @param   {Object}       type    entry of HOST_TYPES
	 * @param   {String}       hostType
	 * @param   {Number|null}  id
	 * @param   {Object}       input   sanitised payload
	 * @returns {Promise<Object>}
	 */
	buildHost: async (access, type, hostType, id, input) => {
		let host;
		if (id) {
			const row = await type.get(access, { id, expand: type.expand });
			// the payload is merged over the stored row, like update does
			host = internalHost.cleanSslHstsData(input, row);
			host.id = row.id;
			host.meta = _.assign({}, row.meta || {}, input.meta || {});
		} else {
			host = internalHost.cleanSslHstsData(Object.assign({}, type.defaults, input));
			host.id = internalNginx.DRY_RUN_ID;
			host.owner_user_id = access.token.getUserId(1);
			host.meta = input.meta || {};
			if (typeof host.enabled === "undefined") {
				host.enabled = true;
			}
		}

		// Relations of the stored row that the payload changed are (re)loaded by nginx.loadRenderRelations()
		if (!(host.certificate_id > 0)) {
			host.certificate = null;
		}
		if (!(host.access_list_id > 0)) {
			host.access_list = null;
		}
		if (Array.isArray(host.domain_names)) {
			host.domain_names = [...host.domain_names].sort();
		}
		if (hostType === "stream") {
			// streams aren't routed by domain name
			delete host.domain_names;
		}
		return host;
	},
};

export default internalHostTest;
