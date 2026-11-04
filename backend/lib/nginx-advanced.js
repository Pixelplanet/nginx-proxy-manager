/**
 * Narrow server-side check of user supplied advanced configuration (host and custom location level).
 *
 * The advanced config is pasted into the host's own config file, but file directives can reach other
 * files: `access_log /data/nginx/proxy_host/2.conf;` makes nginx append log lines to another host's config
 * (breaking it at the next test), and `include /data/nginx/proxy_host/2.conf;` pulls another host's config
 * into this one. These are rejected:
 * - access_log / error_log writing into /data/nginx/ (the generated configs) or /etc/nginx/ (relative log
 *   paths resolve there too)
 * - include of another host's generated config: /data/nginx/(proxy_host|redirection_host|dead_host|stream|default_host)/
 *
 * Everything else stays allowed, notably `root`, `alias` and `include` of the user's own snippets
 * (eg. /data/nginx/custom/*.conf, /snippets/*.conf, conf.d/include/*.conf).
 *
 * This module has no database imports so it can be unit tested.
 */

import { posix } from "node:path";

const NGINX_PREFIX = "/etc/nginx/";
const LOG_FORBIDDEN = ["/data/nginx/", "/etc/nginx/"];
const INCLUDE_FORBIDDEN = /^\/data\/nginx\/(proxy_host|redirection_host|dead_host|stream|default_host)(\/|$)/;

/**
 * Splits nginx config text into statements (arrays of tokens). Handles quotes, escapes and comments; block
 * braces end a statement like `;` does.
 *
 * @param   {String} text
 * @returns {String[][]}
 */
const tokenize = (text) => {
	const statements = [];
	let tokens = [];
	let token = null;
	let quote = null;
	const src = `${text || ""}`;

	const endToken = () => {
		if (token !== null) {
			tokens.push(token);
			token = null;
		}
	};
	const endStatement = () => {
		endToken();
		if (tokens.length) {
			statements.push(tokens);
		}
		tokens = [];
	};

	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			if (c === "\\" && i + 1 < src.length) {
				token += src[++i];
			} else if (c === quote) {
				quote = null;
			} else {
				token += c;
			}
			continue;
		}
		if (c === "#" && token === null) {
			while (i < src.length && src[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			token = token === null ? "" : token;
			continue;
		}
		if (c === ";" || c === "{" || c === "}") {
			endStatement();
			continue;
		}
		if (/\s/.test(c)) {
			endToken();
			continue;
		}
		if (c === "\\" && i + 1 < src.length) {
			token = (token === null ? "" : token) + src[++i];
			continue;
		}
		token = (token === null ? "" : token) + c;
	}
	endStatement();
	return statements;
};

/**
 * @param   {String} path  a path as written in the config
 * @returns {String|null} the absolute, normalised path, null when it can't be known (starts with a variable)
 */
const resolvePath = (path) => {
	if (!path || path.startsWith("$")) {
		return null;
	}
	const absolute = path.startsWith("/") ? path : `${NGINX_PREFIX}${path}`;
	return posix.normalize(absolute);
};

/**
 * @param   {String} target  first argument of access_log / error_log
 * @returns {boolean}
 */
const isForbiddenLogTarget = (target) => {
	if (!target || target === "off" || /^(syslog|memory):/.test(target) || target === "stderr") {
		return false;
	}
	const resolved = resolvePath(target);
	return !!resolved && LOG_FORBIDDEN.some((dir) => resolved.startsWith(dir) || `${resolved}/` === dir);
};

/**
 * @param   {String} text  advanced configuration
 * @returns {{directive: String, path: String, reason: String}|null} the first forbidden file directive
 */
const findForbiddenFileDirective = (text) => {
	for (const [directive, target] of tokenize(text)) {
		if ((directive === "access_log" || directive === "error_log") && isForbiddenLogTarget(target)) {
			return {
				directive,
				path: target,
				reason: `${directive} can't write to "${target}": log files must not be placed in /data/nginx/ or /etc/nginx/, use /data/logs/ instead`,
			};
		}
		if (directive === "include" && target) {
			const resolved = resolvePath(target);
			if (resolved && INCLUDE_FORBIDDEN.test(resolved)) {
				return {
					directive,
					path: target,
					reason: `include of "${target}" is not allowed: files in /data/nginx/ generated for other hosts can't be included, put shared snippets in /data/nginx/custom/ instead`,
				};
			}
		}
	}
	return null;
};

export { findForbiddenFileDirective, tokenize };
