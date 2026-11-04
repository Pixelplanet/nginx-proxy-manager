import _ from "lodash";
import errs from "../lib/error.js";
import { castJsonIfNeed } from "../lib/helpers.js";
import { findDuplicatePath } from "../lib/nginx-locations.js";
import deadHostModel from "../models/dead_host.js";
import proxyHostModel from "../models/proxy_host.js";
import redirectionHostModel from "../models/redirection_host.js";
import internalNginx from "./nginx.js";

const internalHost = {
	/**
	 * Makes sure that the ssl_* and hsts_* fields play nicely together.
	 * ie: if there is no cert, then force_ssl is off.
	 *     if force_ssl is off, then hsts_enabled is definitely off.
	 *
	 * @param   {object} data
	 * @param   {object} [existing_data]
	 * @returns {object}
	 */
	cleanSslHstsData: (data, existingData) => {
		const combinedData = _.assign({}, existingData || {}, data);

		if (!combinedData.certificate_id) {
			combinedData.ssl_forced = false;
			combinedData.http2_support = false;
		}

		if (!combinedData.ssl_forced) {
			combinedData.hsts_enabled = false;
		}

		if (!combinedData.hsts_enabled) {
			combinedData.hsts_subdomains = false;
		}

		return combinedData;
	},

	/**
	 * used by the getAll functions of hosts, this removes the certificate meta if present
	 *
	 * @param   {Array}  rows
	 * @returns {Array}
	 */
	cleanAllRowsCertificateMeta: (rows) => {
		rows.map((_, idx) => {
			if (typeof rows[idx].certificate !== "undefined" && rows[idx].certificate) {
				rows[idx].certificate.meta = {};
			}
			return true;
		});

		return rows;
	},

	/**
	 * used by the get/update functions of hosts, this removes the certificate meta if present
	 *
	 * @param   {Object}  row
	 * @returns {Object}
	 */
	cleanRowCertificateMeta: (row) => {
		if (typeof row.certificate !== "undefined" && row.certificate) {
			row.certificate.meta = {};
		}

		return row;
	},

	/**
	 * Input hygiene for incoming create/update data of all host types:
	 * - strips the server-owned meta keys (the UI sends meta back on save)
	 * - trims upstream host names and location paths
	 * - rejects duplicate custom location paths
	 *
	 * @param   {Object} data
	 * @returns {Object} data, modified in place
	 */
	sanitiseInput: (data) => {
		if (!data || typeof data !== "object") {
			return data;
		}

		internalNginx.stripServerMeta(data);

		for (const field of ["forward_host", "forwarding_host", "forward_domain_name"]) {
			if (typeof data[field] === "string") {
				data[field] = data[field].trim();
			}
		}

		if (Array.isArray(data.locations)) {
			data.locations = data.locations.map((location) => {
				if (!location || typeof location !== "object") {
					return location;
				}
				const loc = Object.assign({}, location);
				if (typeof loc.forward_host === "string") {
					loc.forward_host = loc.forward_host.trim();
				}
				if (typeof loc.path === "string") {
					loc.path = loc.path.trim();
				}
				return loc;
			});

			const duplicate = findDuplicatePath(data.locations);
			if (duplicate) {
				throw new errs.ValidationError(`The custom location path "${duplicate}" is used more than once`);
			}
		}

		return data;
	},

	/**
	 * Puts back the values a failed update patched.
	 *
	 * @param   {Object} model
	 * @param   {Object} before  the row as it was before the update
	 * @param   {Object} patch   the data that was patched
	 * @returns {Promise}
	 */
	restoreRow: async (model, before, patch) => {
		const columns = Object.keys(patch || {}).filter(
			(key) => !["id", "created_on", "modified_on"].includes(key) && Object.hasOwn(before, key),
		);
		const values = _.pick(before, columns);
		// Relations that may have been fetched with the row are not columns
		for (const relation of ["owner", "certificate", "access_list"]) {
			delete values[relation];
		}
		if (Object.keys(values).length) {
			await model.query().where("id", before.id).patch(values);
		}
	},

	/**
	 * This returns all the host types with any domain listed in the provided domainNames array.
	 * This is used by the certificates to temporarily disable any host that is using the domain
	 *
	 * @param   {Array}  domainNames
	 * @returns {Promise}
	 */
	getHostsWithDomains: async (domainNames) => {
		const responseObject = {
			total_count: 0,
			dead_hosts: [],
			proxy_hosts: [],
			redirection_hosts: [],
		};

		const proxyRes = await proxyHostModel
			.query()
			.where("is_deleted", 0)
			.withGraphFetched("[certificate, access_list.[clients,items]]");
		responseObject.proxy_hosts = internalHost._getHostsWithDomains(proxyRes, domainNames);
		responseObject.total_count += responseObject.proxy_hosts.length;

		const redirRes = await redirectionHostModel.query().where("is_deleted", 0).withGraphFetched("[certificate]");
		responseObject.redirection_hosts = internalHost._getHostsWithDomains(redirRes, domainNames);
		responseObject.total_count += responseObject.redirection_hosts.length;

		const deadRes = await deadHostModel.query().where("is_deleted", 0).withGraphFetched("[certificate]");
		responseObject.dead_hosts = internalHost._getHostsWithDomains(deadRes, domainNames);
		responseObject.total_count += responseObject.dead_hosts.length;

		return responseObject;
	},

	/**
	 * Internal use only, checks to see if the domain is already taken by any other record
	 *
	 * @param   {String}   hostname
	 * @param   {String}   [ignore_type]   'proxy', 'redirection', 'dead'
	 * @param   {Integer}  [ignore_id]     Must be supplied if type was also supplied
	 * @returns {Promise}
	 */
	isHostnameTaken: (hostname, ignore_type, ignore_id) => {
		const promises = [
			proxyHostModel
				.query()
				.where("is_deleted", 0)
				.andWhere(castJsonIfNeed("domain_names"), "like", `%${hostname}%`),
			redirectionHostModel
				.query()
				.where("is_deleted", 0)
				.andWhere(castJsonIfNeed("domain_names"), "like", `%${hostname}%`),
			deadHostModel
				.query()
				.where("is_deleted", 0)
				.andWhere(castJsonIfNeed("domain_names"), "like", `%${hostname}%`),
		];

		return Promise.all(promises).then((promises_results) => {
			let is_taken = false;

			if (promises_results[0]) {
				// Proxy Hosts
				if (
					internalHost._checkHostnameRecordsTaken(
						hostname,
						promises_results[0],
						ignore_type === "proxy" && ignore_id ? ignore_id : 0,
					)
				) {
					is_taken = true;
				}
			}

			if (promises_results[1]) {
				// Redirection Hosts
				if (
					internalHost._checkHostnameRecordsTaken(
						hostname,
						promises_results[1],
						ignore_type === "redirection" && ignore_id ? ignore_id : 0,
					)
				) {
					is_taken = true;
				}
			}

			if (promises_results[2]) {
				// Dead Hosts
				if (
					internalHost._checkHostnameRecordsTaken(
						hostname,
						promises_results[2],
						ignore_type === "dead" && ignore_id ? ignore_id : 0,
					)
				) {
					is_taken = true;
				}
			}

			return {
				hostname: hostname,
				is_taken: is_taken,
			};
		});
	},

	/**
	 * Private call only
	 *
	 * @param   {String}  hostname
	 * @param   {Array}   existingRows
	 * @param   {Integer} [ignoreId]
	 * @returns {Boolean}
	 */
	_checkHostnameRecordsTaken: (hostname, existingRows, ignoreId) => {
		let isTaken = false;

		if (existingRows?.length) {
			existingRows.map((existingRow) => {
				existingRow.domain_names.map((existingHostname) => {
					// Does this domain match?
					if (existingHostname.toLowerCase() === hostname.toLowerCase()) {
						if (!ignoreId || ignoreId !== existingRow.id) {
							isTaken = true;
						}
					}
					return true;
				});
				return true;
			});
		}

		return isTaken;
	},

	/**
	 * Private call only
	 *
	 * @param   {Array}   hosts
	 * @param   {Array}   domainNames
	 * @returns {Array}
	 */
	_getHostsWithDomains: (hosts, domainNames) => {
		const response = [];

		if (hosts?.length) {
			hosts.map((host) => {
				let hostMatches = false;

				domainNames.map((domainName) => {
					host.domain_names.map((hostDomainName) => {
						if (domainName.toLowerCase() === hostDomainName.toLowerCase()) {
							hostMatches = true;
						}
						return true;
					});
					return true;
				});

				if (hostMatches) {
					response.push(host);
				}
				return true;
			});
		}

		return response;
	},
};

export default internalHost;
