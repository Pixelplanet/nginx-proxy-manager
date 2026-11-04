/**
 * Rendering of proxy host custom locations.
 *
 * Every location is wrapped in marker comments so an `nginx -t` error line can be mapped back
 * to the location that caused it:
 *
 *   # npm-location-begin <i>
 *   location /path { ... }
 *   # npm-location-end <i>
 *
 * A location is rendered in one of these ways (see docs/src/advanced-config/locations.md):
 * - dynamic:     the upstream host is put in a variable, nginx resolves it per request
 * - static:      the upstream host is literal (the historic behaviour)
 * - quarantined: `location <path> { return 503; }` or nothing at all
 * - disabled:    nothing, the user switched the location off
 *
 * This module has no database imports so it can be unit tested.
 */

import fs from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMPLATE_FILE = `${__dirname}/../templates/_location.conf`;

const CONFIG_VERSION = 2;
const CONFIG_VERSION_MARKER = `# npm-config-version: ${CONFIG_VERSION}`;

// Characters that would break out of the generated nginx directive
const INVALID_HOST_CHARS = /[\s;{}'"`\\$#]/;

const MESSAGES = {
	regexWithForwardPath:
		"A forward path can't be used with a regular-expression location; remove the forward path or use a prefix location.",
	namedWithForwardPath: "A forward path can't be used with a named location; remove the forward path.",
	invalidHost: "The forward host contains characters that are not allowed (spaces, quotes, ; { } $ # or \\).",
	emptyHost: "The forward host is empty.",
	emptyPath: "The location path is empty.",
	unbalancedBraces: "The advanced configuration of this location has unbalanced { } braces.",
	unresolved: (host) =>
		`Host "${host}" can't be resolved right now. Requests to this location fail with 502 until it resolves.`,
	rejected: (text) => `Disabled because nginx rejected it: ${text}`,
	omitted: (text) => `Removed because nginx rejected it, even as a placeholder: ${text}`,
};

/**
 * @param   {String} path
 * @returns {{modifier: String, uri: String, isRegex: boolean, isNamed: boolean, isExact: boolean, normalised: String}}
 */
const parseLocationPath = (path) => {
	const trimmed = `${path || ""}`.trim();
	const match = trimmed.match(/^(=|\^~|~\*|~)\s*(.*)$/s);
	const modifier = match ? match[1] : "";
	const uri = (match ? match[2] : trimmed).trim();
	return {
		modifier,
		uri,
		isRegex: modifier === "~" || modifier === "~*",
		isNamed: !modifier && uri.startsWith("@"),
		isExact: modifier === "=",
		normalised: modifier ? `${modifier} ${uri}` : uri,
	};
};

/**
 * Normalised form used to detect duplicates, `^~  /x` -> `^~ /x`
 *
 * @param   {String} path
 * @returns {String}
 */
const normaliseLocationPath = (path) => parseLocationPath(path).normalised;

/**
 * @param   {Array} locations
 * @returns {String|null}  the first duplicated (normalised) path, or null
 */
const findDuplicatePath = (locations) => {
	const seen = new Set();
	for (const location of locations || []) {
		const normalised = normaliseLocationPath(location?.path);
		if (!normalised) {
			continue;
		}
		if (seen.has(normalised)) {
			return normalised;
		}
		seen.add(normalised);
	}
	return null;
};

/**
 * @param   {String} str
 * @returns {String}
 */
const escapeRegex = (str) => `${str}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Trims the user input and splits `host/path` the way it has always been done:
 * a path in the forward host wins over the forward path field.
 *
 * @param   {Object} location
 * @returns {Object} a copy
 */
const prepareLocation = (location) => {
	const loc = Object.assign({}, location);
	loc.path = `${loc.path || ""}`.trim();
	loc.forward_host = `${loc.forward_host || ""}`.trim();
	loc.forward_path = typeof loc.forward_path === "string" ? loc.forward_path.trim() : "";

	if (loc.forward_host.indexOf("/") > -1) {
		const splitted = loc.forward_host.split("/");
		loc.forward_host = splitted.shift();
		loc.forward_path = `/${splitted.join("/")}`;
	}

	if (loc.forward_path && !loc.forward_path.startsWith("/")) {
		loc.forward_path = `/${loc.forward_path}`;
	}

	if (net.isIPv6(loc.forward_host)) {
		loc.forward_host = `[${loc.forward_host}]`;
	}

	return loc;
};

/**
 * Checks that { and } are balanced, ignoring comments and quoted strings.
 *
 * @param   {String} text
 * @returns {boolean}
 */
const bracesBalanced = (text) => {
	const str = `${text || ""}`;
	let depth = 0;
	let quote = null;
	for (let i = 0; i < str.length; i++) {
		const ch = str[i];
		if (quote) {
			if (ch === "\\") {
				i++;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "#") {
			const eol = str.indexOf("\n", i);
			if (eol === -1) {
				break;
			}
			i = eol;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "\\") {
			i++;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth < 0) {
				return false;
			}
		}
	}
	return depth === 0 && quote === null;
};

/**
 * Problems that are known before nginx is asked.
 *
 * @param   {Object} loc  a prepared location
 * @returns {{status: String, message: String|null}|null}
 */
const preflightLocation = (loc) => {
	if (loc.enabled === false) {
		return { status: "disabled", message: null };
	}
	const parsed = parseLocationPath(loc.path);
	if (!parsed.uri) {
		return { status: "quarantined", message: MESSAGES.emptyPath };
	}
	if (!loc.forward_host) {
		return { status: "quarantined", message: MESSAGES.emptyHost };
	}
	if (INVALID_HOST_CHARS.test(loc.forward_host)) {
		return { status: "quarantined", message: MESSAGES.invalidHost };
	}
	if (!bracesBalanced(loc.advanced_config)) {
		return { status: "quarantined", message: MESSAGES.unbalancedBraces };
	}
	if (loc.forward_path && parsed.isRegex) {
		return { status: "quarantined", message: MESSAGES.regexWithForwardPath };
	}
	if (loc.forward_path && parsed.isNamed) {
		return { status: "quarantined", message: MESSAGES.namedWithForwardPath };
	}
	return null;
};

/**
 * @param   {String} advancedConfig
 * @param   {String} directive
 * @returns {boolean}
 */
const hasDirective = (advancedConfig, directive) =>
	new RegExp(`(^|[;{}\\s])${directive}\\s`, "m").test(`${advancedConfig || ""}`.replace(/#.*$/gm, ""));

/**
 * Template variables (all prefixed npm_) for the dynamic / static rendering of a location.
 *
 * @param   {Object} loc    prepared location (merged with the host's settings)
 * @param   {Object} state  {index, mode}
 * @returns {Object}
 */
const buildLocationContext = (loc, state) => {
	const parsed = parseLocationPath(loc.path);
	const dynamic = state.mode === "dynamic";
	const hostVar = `$npm_loc_${state.index}_host`;
	const upstreamBase = `${loc.forward_scheme}://${loc.forward_host}:${loc.forward_port}`;
	const fp = loc.forward_path || "";
	const canRewrite = !!fp && !parsed.isRegex && !parsed.isNamed;
	const rewrite = canRewrite ? `^${escapeRegex(parsed.uri)}(.*)$ ${fp}$1` : "";
	const redirect = canRewrite ? `${upstreamBase}${fp} ${parsed.uri}` : `${upstreamBase}/ /`;
	// nginx does not allow nested locations in exact match and named locations
	const assetsAllowed = !parsed.isExact && !parsed.isNamed;

	return Object.assign({}, loc, {
		forward_path: fp,
		npm_index: state.index,
		npm_mode: state.mode,
		npm_dynamic: dynamic,
		npm_host_var: hostVar,
		npm_upstream: dynamic ? hostVar : loc.forward_host,
		npm_rewrite: rewrite,
		// A variable proxy_pass disables "proxy_redirect default", so it is spelled out unless
		// the user manages proxy_redirect in the advanced config
		npm_redirect: dynamic && !hasDirective(loc.advanced_config, "proxy_redirect") ? redirect : "",
		npm_assets: assetsAllowed && (loc.caching_enabled === 1 || loc.caching_enabled === true),
		npm_asset_rewrite: rewrite,
		npm_asset_redirect: redirect,
	});
};

const indexMarker = (kind, index) => `# npm-location-${kind} ${index}`;

/**
 * @param   {Object} engine    liquid engine from utils.getRenderEngine()
 * @param   {String} template  contents of _location.conf
 * @param   {Object} loc       prepared location merged with host settings
 * @param   {Object} state     {index, status, mode, stub}
 * @returns {Promise<String>}
 */
const renderLocation = async (engine, template, loc, state) => {
	const begin = indexMarker("begin", state.index);
	const end = indexMarker("end", state.index);

	if (state.status === "disabled") {
		return `  # npm-location ${state.index} disabled by user\n`;
	}

	if (state.status === "quarantined") {
		if (state.stub && loc.path) {
			return `  ${begin}\n  location ${loc.path} {\n    # npm: quarantined, see the host's status in the UI\n    return 503;\n  }\n  ${end}\n`;
		}
		return `  # npm-location ${state.index} quarantined, not rendered\n`;
	}

	const rendered = await engine.parseAndRender(template, buildLocationContext(loc, state));
	return `  ${begin}\n${rendered.replace(/\s+$/, "")}\n  ${end}\n`;
};

/**
 * @returns {String}
 */
const readLocationTemplate = () => fs.readFileSync(TEMPLATE_FILE, { encoding: "utf8" });

/**
 * Maps a line of a generated config to the location / advanced config area it belongs to.
 *
 * @param   {String} configText
 * @param   {Number} line  1-based
 * @returns {{location_index: Number|null, area: "location"|"location_advanced"|"host_advanced"|null, relative_line: Number|null}}
 */
const describeConfigLine = (configText, line) => {
	const result = { location_index: null, area: null, relative_line: null };
	if (!configText || !line) {
		return result;
	}
	const lines = configText.split("\n").slice(0, line);
	let locationIndex = null;
	let locationAdvancedStart = null;
	let hostAdvancedStart = null;

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i].trim();
		let m = text.match(/^# npm-location-begin (\d+)$/);
		if (m) {
			locationIndex = Number.parseInt(m[1], 10);
			continue;
		}
		m = text.match(/^# npm-location-end (\d+)$/);
		if (m) {
			// The error line itself can be the end marker line, that still belongs to the location
			if (i < lines.length - 1) {
				locationIndex = null;
			}
			continue;
		}
		if (/^# npm-location-advanced-begin \d+$/.test(text)) {
			locationAdvancedStart = i + 1;
			continue;
		}
		if (/^# npm-location-advanced-end \d+$/.test(text)) {
			if (i < lines.length - 1) {
				locationAdvancedStart = null;
			}
			continue;
		}
		if (text === "# npm-advanced-config-begin") {
			hostAdvancedStart = i + 1;
			continue;
		}
		if (text === "# npm-advanced-config-end") {
			if (i < lines.length - 1) {
				hostAdvancedStart = null;
			}
		}
	}

	if (locationIndex !== null) {
		result.location_index = locationIndex;
		result.area = "location";
		if (locationAdvancedStart !== null) {
			result.area = "location_advanced";
			result.relative_line = line - locationAdvancedStart;
		}
	} else if (hostAdvancedStart !== null) {
		result.area = "host_advanced";
		result.relative_line = line - hostAdvancedStart;
	}
	return result;
};

/**
 * @param   {Object} state
 * @returns {Object} the public shape stored in meta.nginx_locations
 */
const publicLocationState = (state) => ({
	index: state.index,
	path: state.path,
	status: state.status,
	mode: state.status === "ok" || state.status === "unresolved" ? state.mode : null,
	message: state.message || null,
});

export {
	CONFIG_VERSION,
	CONFIG_VERSION_MARKER,
	MESSAGES,
	bracesBalanced,
	buildLocationContext,
	describeConfigLine,
	escapeRegex,
	findDuplicatePath,
	hasDirective,
	normaliseLocationPath,
	parseLocationPath,
	preflightLocation,
	prepareLocation,
	publicLocationState,
	readLocationTemplate,
	renderLocation,
};
