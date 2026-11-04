import {
	type HostMeta,
	isApiError,
	type NginxConfigErrorDetails,
	type NginxLocationStatus,
	type UpstreamHealthTarget,
	type UpstreamHostHealth,
} from "src/api/backend";
import { intl } from "src/locale";

// Meta keys the backend owns. It strips them from anything we send, but there
// is no reason to send stale copies back in the first place.
export const SERVER_META_KEYS = [
	"nginxOnline",
	"nginxErr",
	"nginxLocations",
	"nginxCheckedAt",
	"nginxDetails",
] as const;

export const stripServerMeta = (meta?: HostMeta | Record<string, any> | null): Record<string, any> => {
	const result: Record<string, any> = { ...(meta || {}) };
	for (const key of SERVER_META_KEYS) {
		delete result[key];
	}
	return result;
};

const hasMessage = (id?: string): id is string =>
	!!id && typeof (intl.messages as Record<string, unknown> | undefined)?.[id] !== "undefined";

/**
 * Best displayable text for an error thrown by the API layer (or anything else).
 * Prefers a translation of the backend's i18n key, then a translation of the
 * message itself (some messages are locale keys), then the message verbatim.
 */
export const formatApiError = (err: unknown): string => {
	if (isApiError(err) && hasMessage(err.messageI18n)) {
		return intl.formatMessage({ id: err.messageI18n });
	}
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	if (hasMessage(message)) {
		return intl.formatMessage({ id: message });
	}
	return message || intl.formatMessage({ id: "error.unknown" });
};

export const getNginxErrorDetails = (err: unknown): NginxConfigErrorDetails | null => {
	if (isApiError(err) && err.details && err.details.kind === "nginx_config") {
		return err.details as NginxConfigErrorDetails;
	}
	return null;
};

/** Index of the custom location an nginx error points at, if any */
export const getErrorLocationIndex = (details?: NginxConfigErrorDetails | null): number | null => {
	if (!details) return null;
	if (typeof details.locationIndex === "number") return details.locationIndex;
	return null;
};

export const PROBLEM_LOCATION_STATUSES = ["quarantined", "unresolved"];

export const getProblemLocations = (meta?: HostMeta | null): NginxLocationStatus[] =>
	(meta?.nginxLocations || []).filter((l) => PROBLEM_LOCATION_STATUSES.includes(l.status));

export const getUnhealthyTargets = (health?: UpstreamHostHealth | null): UpstreamHealthTarget[] =>
	(health?.targets || []).filter((t) => !t.ok);

export type HostState = "disabled" | "online" | "warning" | "error";

export interface HostStatusInfo {
	state: HostState;
	nginxErr: string | null;
	problemLocations: NginxLocationStatus[];
	unhealthyTargets: UpstreamHealthTarget[];
}

export const getHostStatus = (
	enabled: boolean,
	meta?: HostMeta | null,
	health?: UpstreamHostHealth | null,
): HostStatusInfo => {
	if (!enabled) {
		return { state: "disabled", nginxErr: null, problemLocations: [], unhealthyTargets: [] };
	}
	const problemLocations = getProblemLocations(meta);
	const unhealthyTargets = getUnhealthyTargets(health);
	if (meta?.nginxOnline === false) {
		return { state: "error", nginxErr: meta.nginxErr || null, problemLocations, unhealthyTargets };
	}
	return {
		state: problemLocations.length || unhealthyTargets.length ? "warning" : "online",
		nginxErr: null,
		problemLocations,
		unhealthyTargets,
	};
};

/** Whether a successful save still needs the user's attention */
export const hasSaveWarnings = (meta?: HostMeta | null) =>
	meta?.nginxOnline === false || getProblemLocations(meta).length > 0;

/**
 * Normalised form of a location path for duplicate detection: the modifier
 * (`=`, `~`, `~*`, `^~`) and the URI are separated by exactly one space,
 * surrounding whitespace is ignored. `= /x` and `=/x` are the same location.
 */
export const normaliseLocationPath = (path: string): string => {
	const m = `${path ?? ""}`.trim().match(/^(=|~\*|~|\^~)?\s*(.*)$/s);
	if (!m) return `${path ?? ""}`.trim();
	return m[1] ? `${m[1]} ${m[2]}` : m[2];
};

export const isTranslatedCheckCode = (code?: string) => !!code && hasMessage(`upstream.check.${code}`);
