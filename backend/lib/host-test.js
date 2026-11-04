import { buildHealthTargets } from "./upstream/health.js";

/**
 * Pure helpers of the "Test config" endpoints (POST /nginx/<host type>/test), see internal/host-test.js
 */

const MAX_TEST_TARGETS = 20;

const WARNING_MESSAGES = {
	certificate_pending:
		"A new certificate is requested when you save. The test checked the host without SSL, the SSL part is checked when the certificate is added.",
	other_host_hidden:
		"Nginx rejects the current configuration of another host. Saving would repair or disable that host. Please ask an administrator to check it.",
};

/**
 * The upstream targets of a host, the same ones the health monitor probes: the main forward target and every
 * enabled custom location (proxy hosts), the forwarding target (TCP streams). Redirection and 404 hosts have none.
 *
 * @param   {String} hostType  proxy_host, redirection_host, dead_host or stream
 * @param   {Object} host
 * @returns {Array<{location_index: number|null, path?: string, host: string, port: number, scheme: string|null}>}
 */
const buildTestTargets = (hostType, host) => {
	if (!host || !["proxy_host", "stream"].includes(hostType)) {
		return [];
	}
	// The test checks the host as it would be saved, also when it is (still) disabled
	const row = Object.assign({}, host, { enabled: true });
	const built = buildHealthTargets(hostType === "proxy_host" ? { proxyHosts: [row] } : { streams: [row] });
	return (built[0]?.targets || []).slice(0, MAX_TEST_TARGETS);
};

/**
 * @param   {Array} [locations]  meta.nginx_locations
 * @returns {boolean} true when a custom location was quarantined (nginx rejected it, it would be replaced by a stub)
 */
const hasQuarantinedLocation = (locations) =>
	Array.isArray(locations) && locations.some((location) => location?.status === "quarantined");

/**
 * Builds the response of a config test.
 *
 * ok: nginx accepts the configuration as entered: the host would be online and no custom location would be
 * quarantined. Unresolved locations and unreachable upstreams don't make the test fail, they are reported in
 * nginx_locations and upstreams.
 *
 * @param   {Object}       input
 * @param   {Object|null}  input.meta       the meta a save would write (null when nginx rejected the host)
 * @param   {Error|null}   input.error      the host level error a save would fail with
 * @param   {Array|null}   input.locations  location states, also known when nginx rejected the host
 * @param   {Array}        [input.upstreams]  check results, with location_index and path
 * @param   {Array}        [input.warnings]   [{code, message}]
 * @returns {Object}
 */
const buildTestResult = ({ meta, error, locations, upstreams = [], warnings = [] }) => {
	const nginxOnline = !error && meta?.nginx_online !== false;
	const nginxLocations = Array.isArray(meta?.nginx_locations)
		? meta.nginx_locations
		: Array.isArray(locations)
			? locations
			: [];
	return {
		ok: nginxOnline && !hasQuarantinedLocation(nginxLocations),
		nginx_online: nginxOnline,
		nginx_err: error ? error.message : null,
		nginx_details: error?.details || null,
		nginx_locations: nginxLocations,
		upstreams,
		warnings,
	};
};

/**
 * Puts the check results next to the targets they belong to
 *
 * @param   {Array} targets  from buildTestTargets()
 * @param   {Array} results  from checkTargets(), same order
 * @returns {Array}
 */
const mergeTargetResults = (targets, results) =>
	targets.map((target, index) =>
		Object.assign({}, results[index], {
			location_index: target.location_index ?? null,
			path: typeof target.path === "string" ? target.path : null,
		}),
	);

export { buildTestResult, buildTestTargets, hasQuarantinedLocation, MAX_TEST_TARGETS, mergeTargetResults, WARNING_MESSAGES };
