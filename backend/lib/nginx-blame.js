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
 * @param   {String} message  nginx error message
 * @returns {String[]} the absolute paths quoted in the message, eg. the log file of
 *                     `open() "/data/logs/proxy-host-5_access.log" failed (13: Permission denied)`
 */
const errorPaths = (message) => [...`${message || ""}`.matchAll(/"(\/[^"\s]+)"/g)].map((m) => m[1]);

/**
 * @param   {String} configText
 * @param   {String} path
 * @returns {boolean} true when the config (not counting comments) mentions the path
 */
const mentionsPath = (configText, path) =>
	`${configText || ""}`.split("\n").some((line) => line.replace(/#.*$/, "").includes(path));

/**
 * Some errors (eg. `cannot load certificate "/etc/letsencrypt/live/npm-1/fullchain.pem"` or
 * `open() "/data/logs/proxy-host-5_access.log" failed (13: Permission denied)`) don't name the config file.
 * Such an error is blamed on the host being configured when its new config mentions a path named in the
 * error. Other hosts are never blamed here, see blameUnattributed().
 *
 * @param   {Object}   parsed      parsed nginx -t output
 * @param   {Object}   [own]       {file, text} of the host being configured
 * @returns {Object} parsed, with file set to own.file when the host being configured is to blame
 */
const attributeToHostFile = (parsed, own) => {
	if (parsed.file || !own?.file || !own.text) {
		return parsed;
	}
	const paths = errorPaths(parsed.message);
	if (paths.some((p) => mentionsPath(own.text, p))) {
		return Object.assign({}, parsed, { file: own.file });
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

/**
 * An error that names no config file and isn't the fault of the host being configured (see
 * attributeToHostFile()), eg. another host's log file that nginx can't open.
 *
 * The candidates are the managed host files that mention a path quoted in the error, with any directive.
 * A mention alone is never enough (a user could otherwise point their own config at another host's log
 * file to get that host taken offline). A candidate is only blamed when
 * 1. nginx -t still fails without the new config of the host being configured (when there is one), and
 * 2. the error goes away when the candidate is taken out as well: the test passes, or the remaining
 *    error no longer names that path (another, unrelated host is broken too and is handled next).
 *
 * @param   {Object}   parsed                     parsed nginx -t output, without a file
 * @param   {Object}   opts
 * @param   {Object}   [opts.own]                 {file} of the host being configured, if any
 * @param   {Function} opts.listFiles             () => [{file, text}], the managed host config files
 * @param   {Function} [opts.testWithout]         async () => {ok, parsed}: nginx -t without own.file
 * @param   {Function} opts.testWithoutCandidate  async (file) => {ok, parsed}: nginx -t without own.file
 *                                                (if any) and without the candidate's file
 * @returns {Promise<{action: "conflict"|"heal"|"global", parsed: Object, other?: Object}>} see blameOtherHost()
 */
const blameUnattributed = async (parsed, { own, listFiles, testWithout, testWithoutCandidate }) => {
	let failure = parsed;
	if (own?.file && testWithout) {
		const alone = await testWithout();
		if (alone.ok) {
			return { action: "conflict", parsed };
		}
		failure = alone.parsed;
		if (failure.file) {
			const other = parseManagedFile(failure.file);
			return other ? { action: "heal", parsed: failure, other } : { action: "global", parsed: failure };
		}
	}

	const paths = errorPaths(failure.message);
	if (!paths.length) {
		return { action: "global", parsed: failure };
	}

	for (const { file, text } of listFiles()) {
		if (file === own?.file) {
			continue;
		}
		const other = parseManagedFile(file);
		if (!other || !paths.some((p) => mentionsPath(text, p))) {
			continue;
		}
		const without = await testWithoutCandidate(file);
		const remaining = without.ok ? "" : `${without.parsed?.message || ""}`;
		if (without.ok || !paths.some((p) => remaining.includes(p))) {
			return { action: "heal", parsed: Object.assign({}, failure, { file, line: null }), other };
		}
	}
	return { action: "global", parsed: failure };
};

/**
 * Repairs another host whose config file fails by itself: an enabled host is regenerated from its database
 * row first (that also undoes tampering with its file); only when that fails (eg. still a host level error)
 * or the host can't be regenerated is it disabled.
 *
 * @param   {Object}   opts
 * @param   {boolean}  opts.enabled     the host's row exists and is enabled
 * @param   {Number}   opts.depth       recursion depth, regenerating only happens at depth 0
 * @param   {Function} opts.regenerate  async (): configure the host again, throws when that fails
 * @param   {Function} opts.disable     async (regenerateError?): move the file aside, mark the host offline
 * @returns {Promise<"regenerated"|"disabled">}
 */
const regenerateOrDisable = async ({ enabled, depth, regenerate, disable }) => {
	let regenerateError = null;
	if (enabled && (depth || 0) < 1) {
		try {
			await regenerate();
			return "regenerated";
		} catch (err) {
			regenerateError = err;
		}
	}
	await disable(regenerateError);
	return "disabled";
};

export { attributeToHostFile, blameOtherHost, blameUnattributed, errorPaths, mentionsPath, regenerateOrDisable };
