/**
 * Helpers for regenerating every host config at once, see internalNginx.regenerateAll() and
 * POST /api/nginx/regenerate. No database imports, so it can be unit tested.
 */

const HOST_TYPES = ["proxy_host", "redirection_host", "dead_host", "stream"];

/**
 * @param   {Array<String>} [hostTypes]
 * @returns {Array<String>} the known host types in a stable order, all of them when none are given
 */
const normaliseHostTypes = (hostTypes) => {
	if (!Array.isArray(hostTypes) || !hostTypes.length) {
		return [...HOST_TYPES];
	}
	return HOST_TYPES.filter((type) => hostTypes.includes(type));
};

/**
 * @param   {String} hostType
 * @param   {Object} row
 * @returns {String} the first domain name, or the incoming port of a stream
 */
const hostName = (hostType, row) => {
	if (Array.isArray(row?.domain_names) && row.domain_names.length) {
		return `${row.domain_names[0]}`;
	}
	if (hostType === "stream" && row?.incoming_port) {
		return `${row.incoming_port}`;
	}
	return `#${row?.id}`;
};

/**
 * @param   {Array} locations  meta.nginx_locations
 * @returns {String|null} what is wrong with the custom locations of a host that is online, or null
 */
const locationWarning = (locations) => {
	if (!Array.isArray(locations)) {
		return null;
	}
	const bad = locations.filter((loc) => loc?.status === "quarantined" || loc?.status === "unresolved");
	if (!bad.length) {
		return null;
	}
	return bad.map((loc) => `${loc.path}: ${loc.message || loc.status}`).join("\n");
};

/**
 * @param   {Array<{hostType: String, row: Object, meta?: Object, error?: Error}>} results
 *          one entry per host that was configured: `meta` is what configure returned, `error` what it threw
 * @returns {{checked: Number, regenerated: Number, offline: Array, failed: Array, warnings: Array}}
 */
const summarise = (results) => {
	const summary = { checked: 0, regenerated: 0, offline: [], failed: [], warnings: [] };
	for (const { hostType, row, meta, error } of results) {
		summary.checked++;
		const item = { host_type: hostType, id: row.id, name: hostName(hostType, row) };
		if (error) {
			// Not a host level nginx error (eg. a certificate file is missing): the previous config was kept
			summary.failed.push(Object.assign(item, { error: `${error.message || error}` }));
			continue;
		}
		if (meta?.nginx_online === false) {
			summary.offline.push(Object.assign(item, { error: meta.nginx_err || "" }));
			continue;
		}
		summary.regenerated++;
		const message = locationWarning(meta?.nginx_locations);
		if (message) {
			summary.warnings.push(Object.assign(item, { message }));
		}
	}
	return summary;
};

/**
 * Lets only one call run at a time, a second call while the first one runs fails with the error that
 * makeBusyError() returns.
 *
 * @param   {Function} makeBusyError
 * @returns {{run: Function, isRunning: Function}}
 */
const createSingleFlight = (makeBusyError) => {
	let running = false;
	return {
		run: async (fn) => {
			if (running) {
				throw makeBusyError();
			}
			running = true;
			try {
				return await fn();
			} finally {
				running = false;
			}
		},
		isRunning: () => running,
	};
};

export { HOST_TYPES, createSingleFlight, hostName, locationWarning, normaliseHostTypes, summarise };
