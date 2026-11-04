import errs from "../lib/error.js";
import { createSingleFlight } from "../lib/nginx-regenerate.js";
import internalAuditLog from "./audit-log.js";
import internalNginx from "./nginx.js";

const flight = createSingleFlight(
	() => new errs.ConflictError("All host configs are being regenerated already, wait for that to finish."),
);

const internalNginxRegenerate = {
	/**
	 * Rewrites the config files of all enabled hosts from the database and reloads nginx once,
	 * see internalNginx.regenerateAll(). Admin only, one run at a time.
	 *
	 * @param   {Access}  access
	 * @param   {Object}  [data]
	 * @param   {Array}   [data.host_types]  default all
	 * @returns {Promise<Object>} {checked, regenerated, offline, failed, warnings, duration_ms}
	 */
	regenerate: async (access, data = {}) => {
		await access.can("nginx:regenerate");
		return flight.run(async () => {
			const summary = await internalNginx.regenerateAll({ hostTypes: data.host_types });
			await internalAuditLog.add(access, {
				action: "regenerated",
				object_type: "nginx-config",
				object_id: 0,
				meta: {
					host_types: data.host_types || null,
					checked: summary.checked,
					regenerated: summary.regenerated,
					offline: summary.offline.length,
					failed: summary.failed.length,
					warnings: summary.warnings.length,
					duration_ms: summary.duration_ms,
				},
			});
			return summary;
		});
	},
};

export default internalNginxRegenerate;
