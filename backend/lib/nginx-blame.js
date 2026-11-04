/**
 * Decides which host an `nginx -t` failure is blamed on while a host is being configured.
 *
 * A failure must never take another host offline because of the change being saved: one user could
 * otherwise disable another user's host, eg. with `include /data/nginx/proxy_host/2.conf;` or a duplicate
 * `listen ... default_server` (nginx reports that at the second definition, which can be the other host's
 * file) in their own advanced config.
 *
 * This module has no database imports so it can be unit tested.
 */

import { parseManagedFile } from "./nginx-errors.js";

/**
 * @param   {String} configText
 * @param   {String} path
 * @returns {boolean} true when an ssl_* directive of the config (not a comment) names the path
 */
const referencesInSslDirective = (configText, path) =>
	`${configText || ""}`.split("\n").some((line) => {
		const code = line.replace(/#.*$/, "").trim();
		return /^ssl_[a-z_]+\s/.test(code) && code.includes(path);
	});

/**
 * Some errors (eg. `cannot load certificate "/etc/letsencrypt/live/npm-1/fullchain.pem"`) don't name the
 * config file. When the message names a file path:
 * - the host being configured is blamed when its new config mentions the path
 * - otherwise the first host config that loads the path with one of its own ssl_* directives
 *   (ssl_certificate, ssl_certificate_key, ...). Any other mention, eg. `access_log`, is not enough:
 *   a user could otherwise point their own ssl_certificate at another host's log file and get that
 *   host taken offline.
 *
 * @param   {Object}   parsed           parsed nginx -t output
 * @param   {Object}   opts
 * @param   {Object}   [opts.own]       {file, text} of the host being configured
 * @param   {Function} opts.listFiles   () => [{file, text}], the managed host config files
 * @returns {Object} parsed, with file set when a host config could be found
 */
const attributeToHostFile = (parsed, { own, listFiles }) => {
	if (parsed.file) {
		return parsed;
	}
	const paths = [...`${parsed.message}`.matchAll(/"(\/[^"\s]+)"/g)].map((m) => m[1]);
	if (!paths.length) {
		return parsed;
	}
	if (own?.file && own.text && paths.some((p) => own.text.includes(p))) {
		return Object.assign({}, parsed, { file: own.file });
	}
	for (const { file, text } of listFiles()) {
		if (file === own?.file) {
			continue;
		}
		if (paths.some((p) => referencesInSslDirective(text, p))) {
			return Object.assign({}, parsed, { file });
		}
	}
	return parsed;
};

/**
 * nginx named ANOTHER managed host's file while a host was being configured. That host is only repaired
 * or taken offline when its file also fails without the new config of the host being configured.
 *
 * @param   {Object}   parsed         parsed nginx -t output, naming another host's file
 * @param   {Function} testWithout    async () => {ok, parsed}, nginx -t without the new config of the host
 *                                    being configured
 * @returns {Promise<{action: "conflict"|"heal"|"global", parsed: Object, other?: Object}>}
 *          conflict: the change being saved is at fault (host level error of that host)
 *          heal:     `other` ({host_type, host_id}) is broken by itself, `parsed` is its failure
 *          global:   something else is broken, `parsed` is that failure
 */
const blameOtherHost = async (parsed, testWithout) => {
	const alone = await testWithout();
	if (alone.ok) {
		return { action: "conflict", parsed };
	}
	const other = parseManagedFile(alone.parsed.file);
	if (other) {
		return { action: "heal", parsed: alone.parsed, other };
	}
	return { action: "global", parsed: alone.parsed };
};

export { attributeToHostFile, blameOtherHost, referencesInSslDirective };
