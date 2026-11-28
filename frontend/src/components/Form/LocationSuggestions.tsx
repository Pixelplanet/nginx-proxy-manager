import { IconBrandDocker, IconPlus } from "@tabler/icons-react";
import { useFormikContext } from "formik";
import { useMemo } from "react";
import type { ProxyLocation, UpstreamCandidate } from "src/api/backend";
import { useUpstreamCandidates } from "src/hooks";
import { intl, T } from "src/locale";
import { locationDuplicateKey, locationHostPart, normaliseLocationPath } from "src/modules/HostStatus";
import { candidatePrefill, isLocationContainer } from "./UpstreamField";

// Containers with an npm.path label (see isLocationContainer): custom locations of the host that serves their
// npm.domain names, e.g. an API under /api/ of its frontend's domain.

/** The custom location a container's labels describe: its path, host (with npm.forward_path), port and scheme */
export const locationFromCandidate = (c: UpstreamCandidate): ProxyLocation => {
	const prefill = candidatePrefill(c);
	return {
		path: c.suggestion?.locationPath || "",
		advancedConfig: "",
		forwardScheme: prefill.scheme || "http",
		forwardHost: `${c.host}${c.suggestion?.locationForwardPath || ""}`,
		// no known port: empty, a validation error until filled in
		forwardPort: (prefill.port ?? "") as unknown as number,
		accessListId: 0,
	};
};

// Paths that are the same location for nginx, also for regex and named locations (which nginx lets repeat)
const samePath = (a: string, b: string) => {
	const ka = locationDuplicateKey(a);
	return ka ? ka === locationDuplicateKey(b) : normaliseLocationPath(a) === normaliseLocationPath(b);
};

const lower = (values: unknown): string[] =>
	Array.isArray(values) ? values.map((d) => `${d ?? ""}`.trim().toLowerCase()).filter(Boolean) : [];

export interface LocationSuggestion {
	// stable key for React: the container and the path
	key: string;
	candidate: UpstreamCandidate;
	location: ProxyLocation;
}

/**
 * Ready-made custom locations for a host: discovered containers whose npm.domain names include one of the host's
 * domain names and that have an npm.path. One per container (its compose service alias is preferred, the name
 * stays the same when the container is recreated), none whose path the form already has.
 */
export const locationSuggestions = (
	items: UpstreamCandidate[] | undefined,
	domainNames: unknown,
	locations: ProxyLocation[] | undefined,
): LocationSuggestion[] => {
	const domains = new Set(lower(domainNames));
	if (!domains.size) return [];
	const taken = (locations || []).map((l) => `${l?.path ?? ""}`).filter((p) => p.trim());
	const byContainer = new Map<string, UpstreamCandidate>();
	for (const c of items || []) {
		const s = c.suggestion;
		if (c.source !== "docker" || !isLocationContainer(s) || !s) continue;
		if (!lower(s.domainNames).some((d) => domains.has(d))) continue;
		const container = c.kind === "compose_service" && c.owner ? c.owner : c.host;
		const seen = byContainer.get(container);
		if (!seen || (c.kind === "compose_service" && seen.kind !== "compose_service")) {
			byContainer.set(container, c);
		}
	}
	const result: LocationSuggestion[] = [];
	for (const [container, c] of byContainer) {
		const location = locationFromCandidate(c);
		if (taken.some((p) => samePath(p, location.path))) continue;
		result.push({ key: `${container} ${location.path}`, candidate: c, location });
	}
	return result;
};

/** `locationSuggestions` for the form's domain names and locations, fetched only once the host has domains */
export function useLocationSuggestions(enabled = true): LocationSuggestion[] {
	const { values } = useFormikContext<{ domainNames?: string[]; locations?: ProxyLocation[] }>();
	const hasDomains = lower(values?.domainNames).length > 0;
	const query = useUpstreamCandidates(enabled && hasDomains);
	const items = query.data?.items;
	return useMemo(
		() => (enabled ? locationSuggestions(items, values?.domainNames, values?.locations) : []),
		[enabled, items, values?.domainNames, values?.locations],
	);
}

/** "http://api:8080/": where a ready-made location sends its requests (the path part of "host/path" last) */
export const suggestionTarget = (location: ProxyLocation) => {
	const host = locationHostPart(location.forwardHost);
	const path = `${location.forwardHost ?? ""}`.trim().slice(host.length);
	return `${location.forwardScheme}://${host}${location.forwardPort ? `:${location.forwardPort}` : ""}${path}`;
};

interface PanelProps {
	suggestions: LocationSuggestion[];
	onAdd: (location: ProxyLocation) => void;
	disabled?: boolean;
}

/** On the Custom Locations tab: the ready-made locations, each added only with its Add button */
export function LocationSuggestionsPanel({ suggestions, onAdd, disabled }: PanelProps) {
	if (!suggestions.length) return null;
	return (
		<div className="card card-sm mb-3 bg-azure-lt border-0" data-testid="location-suggestions">
			<div className="card-body">
				<div className="d-flex align-items-center mb-1">
					<IconBrandDocker size={16} className="text-blue me-2" />
					<strong>
						<T id="location.suggestions.title" />
					</strong>
				</div>
				<div className="small text-secondary mb-2">
					<T id="location.suggestions.hint" />
				</div>
				{suggestions.map(({ key, candidate, location }) => (
					<div
						key={key}
						className="d-flex align-items-center flex-wrap gap-2 py-1"
						data-testid="location-suggestion"
					>
						<span className="flex-fill text-break">
							{/* path and target only, no words to translate */}
							<code>{location.path}</code> → <strong>{suggestionTarget(location)}</strong>
							{candidate.state && candidate.state !== "running" ? (
								<span className="badge bg-secondary-lt ms-2">{candidate.state}</span>
							) : null}
						</span>
						<button
							type="button"
							className="btn btn-sm"
							disabled={disabled}
							onClick={() => onAdd(location)}
							aria-label={intl.formatMessage(
								{ id: "location.suggestions.add-label" },
								{ path: location.path, target: suggestionTarget(location) },
							)}
						>
							<IconPlus size={14} className="me-1" />
							<T id="action.add" />
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

/** On the Details tab: a pointer to the ready-made locations of the Custom Locations tab */
export function LocationSuggestionsPointer({ onShow }: { onShow: () => void }) {
	const suggestions = useLocationSuggestions();
	if (!suggestions.length) return null;
	return (
		<div className="small mt-n2 mb-3" data-testid="location-suggestions-pointer">
			<IconBrandDocker size={14} className="text-blue me-1" />
			<button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={onShow}>
				<T id="location.suggestions.pointer" data={{ count: suggestions.length }} />
			</button>
		</div>
	);
}

interface HintProps {
	candidate: UpstreamCandidate;
	onAdd: () => void;
}

/**
 * Under a proxy host's forward host after a container with npm.path was picked: it expects to be a custom location,
 * with a button to add it as one instead. The pick itself is not blocked.
 */
export function LocationContainerHint({ candidate, onAdd }: HintProps) {
	const path = candidate.suggestion?.locationPath;
	if (!path) return null;
	return (
		<div className="small text-warning mt-n2 mb-3" data-testid="location-container-hint">
			<T id="docker-labels.location-hint" data={{ host: candidate.host, path }} />{" "}
			<button
				type="button"
				className="btn btn-link btn-sm p-0 align-baseline"
				onClick={onAdd}
				data-testid="add-as-location"
			>
				<T id="docker-labels.add-as-location" />
			</button>
		</div>
	);
}

/** What a pick in a location card writes into its path and its forward host ("host/path") */
export interface LocationPickFill {
	path?: string;
	forwardHost?: string;
}

/** What earlier picks of a location card filled in: the path, and the path part of the forward host */
export interface LocationPicked {
	path?: string;
	forwardPath?: string;
}

/**
 * The location path and forward path a picked container fills into a location card, only where the fields are
 * free: the path when it is empty or holds what an earlier pick filled in (a saved path is kept: changing it
 * would move the location to another URL); the forward
 * path (the "/path" part of "host/path") when the label sets one and the field had no path of its own, or only
 * what an earlier pick filled in. A path the user typed is kept; with npm.forward_path set it stays behind the
 * new host instead of being dropped. A path an earlier pick filled in is reset to the saved one when this
 * container has none. Without npm.forward_path the host field is left as the pick set it (the host alone).
 *
 * @param before   the card before the pick (the host field still holds the old value)
 * @param initial  the card as loaded or added
 * @param previous what earlier picks of this card filled in
 * @returns the changes, and what to remember for the next pick
 */
export const locationPickFill = (
	c: UpstreamCandidate,
	before: { path?: string; forwardHost?: string },
	initial: { path?: string },
	previous: LocationPicked = {},
): { changes: LocationPickFill; picked: LocationPicked } => {
	const changes: LocationPickFill = {};
	const picked: LocationPicked = {};
	const saved = `${initial.path ?? ""}`;
	const path = c.suggestion?.locationPath || "";
	const current = `${before.path ?? ""}`;
	const fromPick = !!previous.path && current === previous.path;
	if (path && (!current.trim() || fromPick)) {
		changes.path = path;
		picked.path = path;
	} else if (!path && fromPick && current !== saved) {
		changes.path = saved;
	} else if (fromPick) {
		picked.path = previous.path;
	}
	const forwardPath = c.suggestion?.locationForwardPath || "";
	if (forwardPath) {
		const oldHost = `${before.forwardHost ?? ""}`.trim();
		const oldPath = oldHost.slice(locationHostPart(oldHost).length);
		const free = !oldPath || (!!previous.forwardPath && oldPath === previous.forwardPath);
		changes.forwardHost = `${c.host}${free ? forwardPath : oldPath}`;
		if (free) picked.forwardPath = forwardPath;
	}
	return { changes, picked };
};
