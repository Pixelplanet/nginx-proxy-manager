import { IconAlertTriangle, IconCheck, IconLoader2, IconX } from "@tabler/icons-react";
import cn from "classnames";
import type { ReactNode } from "react";
import OverlayTrigger from "react-bootstrap/OverlayTrigger";
import Tooltip from "react-bootstrap/Tooltip";
import type { LocationStatusValue, UpstreamCheckResult } from "src/api/backend";
import { intl, T } from "src/locale";
import { isTranslatedCheckCode } from "src/modules/HostStatus";

interface TipProps {
	id: string;
	tip?: ReactNode;
	children: ReactNode;
}
// A badge with an optional tooltip; focusable so the tip works without a mouse
function Tip({ id, tip, children }: TipProps) {
	if (!tip) {
		return <>{children}</>;
	}
	return (
		<OverlayTrigger placement="top" trigger={["hover", "focus"]} overlay={<Tooltip id={id}>{tip}</Tooltip>}>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the tooltip for keyboard and touch users */}
			<span tabIndex={0} className="d-inline-flex">
				{children}
			</span>
		</OverlayTrigger>
	);
}

const LOCATION_STATUS_CLASS: Record<LocationStatusValue, string> = {
	ok: "bg-green-lt",
	disabled: "bg-secondary-lt",
	unresolved: "bg-yellow-lt",
	quarantined: "bg-red-lt",
};

interface LocationStatusBadgeProps {
	id: string;
	status: LocationStatusValue;
	message?: string | null;
}
/** Server reported status of a custom location; nothing for "ok" */
export function LocationStatusBadge({ id, status, message }: LocationStatusBadgeProps) {
	if (status === "ok") {
		return null;
	}
	const tip =
		status === "disabled" ? null : message || intl.formatMessage({ id: `location-status.${status}.default` });
	return (
		<Tip id={`${id}-tip`} tip={tip}>
			<span className={cn("badge", LOCATION_STATUS_CLASS[status])} data-status={status}>
				<T id={`location-status.${status}`} />
			</span>
		</Tip>
	);
}

/** Short translated text for a reachability check result */
export const checkResultText = (result: UpstreamCheckResult): string => {
	if (result.code === "ok") {
		return typeof result.ms === "number"
			? intl.formatMessage({ id: "upstream.check.ok-ms" }, { ms: Math.round(result.ms) })
			: intl.formatMessage({ id: "upstream.check.ok" });
	}
	if (isTranslatedCheckCode(result.code)) {
		return intl.formatMessage({ id: `upstream.check.${result.code}` });
	}
	return result.message || result.code;
};

interface UpstreamCheckBadgeProps {
	id: string;
	result: UpstreamCheckResult | null;
	isChecking?: boolean;
}
/** Live reachability of a forward host:port */
export function UpstreamCheckBadge({ id, result, isChecking }: UpstreamCheckBadgeProps) {
	if (isChecking) {
		return (
			<span className="badge bg-secondary-lt" data-check="checking">
				<IconLoader2 size={12} className="me-1" />
				<T id="upstream.check.checking" />
			</span>
		);
	}
	if (!result || result.code === "disabled") {
		return null;
	}
	const warn = result.code === "resolver_mismatch";
	const cls = result.ok ? (warn ? "bg-yellow-lt" : "bg-green-lt") : "bg-red-lt";
	const icon = result.ok ? (
		warn ? (
			<IconAlertTriangle size={12} className="me-1" />
		) : (
			<IconCheck size={12} className="me-1" />
		)
	) : (
		<IconX size={12} className="me-1" />
	);
	const tip = [result.message, result.addresses?.length ? result.addresses.join(", ") : null]
		.filter(Boolean)
		.join(" – ");
	return (
		<Tip id={`${id}-tip`} tip={tip || null}>
			<span className={cn("badge", cls)} data-check={result.code}>
				{icon}
				{checkResultText(result)}
			</span>
		</Tip>
	);
}
