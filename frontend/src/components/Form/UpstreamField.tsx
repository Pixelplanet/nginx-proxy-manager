import { IconBrandDocker, IconHistory, IconNetwork, IconRefresh } from "@tabler/icons-react";
import cn from "classnames";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
	components,
	type GroupBase,
	type InputProps,
	type MenuListProps,
	type OptionProps,
	type SingleValue,
} from "react-select";
import CreatableSelect from "react-select/creatable";
import type { UpstreamCandidate, UpstreamCandidates, UpstreamSource } from "src/api/backend";
import { useUpstreamCandidates } from "src/hooks";
import { intl, T } from "src/locale";

export interface UpstreamOption {
	readonly value: string;
	readonly label: string;
	readonly candidate?: UpstreamCandidate;
	// react-select sets this on the synthetic "create" option
	readonly __isNew__?: boolean;
}

export interface UpstreamPrefill {
	port?: number;
	scheme?: "http" | "https";
}

const SOURCE_ORDER: UpstreamSource[] = ["docker", "dns", "history"];

const SOURCE_ICON: Record<UpstreamSource, ReactNode> = {
	docker: <IconBrandDocker size={14} className="text-blue" />,
	dns: <IconNetwork size={14} className="text-teal" />,
	history: <IconHistory size={14} className="text-secondary" />,
};

/** Port and scheme to fill in when a candidate is picked */
export const candidatePrefill = (c: UpstreamCandidate): UpstreamPrefill => {
	const prefill: UpstreamPrefill = {};
	if (typeof c.hintPort === "number" && c.hintPort > 0) {
		prefill.port = c.hintPort;
	} else if (c.ports?.length === 1) {
		prefill.port = c.ports[0];
	}
	if (c.hintScheme === "http" || c.hintScheme === "https") {
		prefill.scheme = c.hintScheme;
	}
	return prefill;
};

/** react-select option groups, one per source, in a fixed order, empty ones left out */
export const groupCandidates = (items: UpstreamCandidate[] = []): GroupBase<UpstreamOption>[] =>
	SOURCE_ORDER.map((source) => ({
		label: intl.formatMessage({ id: `upstream.group.${source}` }),
		options: items
			.filter((c) => c.source === source)
			.map((c) => ({ value: c.host, label: c.label || c.host, candidate: c })),
	})).filter((g) => g.options.length > 0);

const Option = (props: OptionProps<UpstreamOption, false, GroupBase<UpstreamOption>>) => {
	const c = props.data.candidate;
	if (!c) {
		return <components.Option {...props} />;
	}
	const extra = [
		c.ports?.length ? intl.formatMessage({ id: "upstream.ports" }, { ports: c.ports.join(", ") }) : null,
		c.network,
		c.usedBy ? intl.formatMessage({ id: "upstream.used-by" }, { count: c.usedBy }) : null,
	].filter(Boolean);
	return (
		<components.Option {...props}>
			<div className="d-flex align-items-center">
				<span className="me-1">{SOURCE_ICON[c.source]}</span>
				<strong className="text-break">{c.host}</strong>
				{c.state ? (
					<span
						className={cn("badge ms-2", c.state === "running" ? "bg-green-lt" : "bg-secondary-lt")}
						data-state={c.state}
					>
						{c.state}
					</span>
				) : null}
			</div>
			{c.label && c.label !== c.host ? <div className="text-secondary small ps-3">{c.label}</div> : null}
			{extra.length ? <div className="text-secondary small ps-3">{extra.join(" · ")}</div> : null}
		</components.Option>
	);
};

// The input text is the only visible value (controlShouldRenderValue is off), so it
// must never be hidden. react-select hides the input after selecting an option until
// the next keystroke or focus, which would make the field look empty.
const Input = (props: InputProps<UpstreamOption, false, GroupBase<UpstreamOption>>) => (
	<components.Input {...props} isHidden={false} />
);

interface MenuFooterInfo {
	dockerDisabled: boolean;
	onRefresh?: () => void;
	isRefreshing?: boolean;
}
const MenuFooterContext = createContext<MenuFooterInfo>({ dockerDisabled: false });

// Menu with a footer: a hint how to enable Docker discovery (or that free text
// works), and a button to refresh the suggestions.
function MenuList(props: MenuListProps<UpstreamOption, false, GroupBase<UpstreamOption>>) {
	const { dockerDisabled, onRefresh, isRefreshing } = useContext(MenuFooterContext);
	return (
		<>
			<components.MenuList {...props}>{props.children}</components.MenuList>
			<div className="border-top px-3 py-2 small text-secondary d-flex align-items-start">
				<span className="flex-fill">
					{dockerDisabled ? (
						<span data-testid="docker-disabled-hint">
							<T id="upstream.docker-disabled" />
						</span>
					) : (
						<T id="upstream.free-text" />
					)}
				</span>
				{onRefresh ? (
					<button
						type="button"
						className="btn btn-sm btn-link p-0 ms-2"
						title={intl.formatMessage({ id: "upstream.refresh" })}
						aria-label={intl.formatMessage({ id: "upstream.refresh" })}
						disabled={isRefreshing}
						// keep the menu open and the input focused
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => onRefresh()}
					>
						<IconRefresh size={14} />
					</button>
				) : null}
			</div>
		</>
	);
}

interface Props {
	id: string;
	value: string;
	onChange: (host: string) => void;
	// Called after `onChange` when a discovered candidate (not free text) was picked
	onSelectCandidate?: (prefill: UpstreamPrefill, candidate: UpstreamCandidate) => void;
	onBlur?: () => void;
	placeholder?: string;
	isInvalid?: boolean;
	// For tests and storybook-like usage; normally fetched lazily on first use
	candidates?: UpstreamCandidates;
}

/**
 * Forward host input with suggestions from the upstream discovery API.
 *
 * Behaves like a text input: whatever is typed is the value, kept verbatim
 * (IPs, `host/path`, anything), while discovered containers, hosts on the
 * network and previously used hosts are offered grouped in the menu.
 */
export function UpstreamField({
	id,
	value,
	onChange,
	onSelectCandidate,
	onBlur,
	placeholder,
	isInvalid,
	candidates,
}: Props) {
	const [wanted, setWanted] = useState(false);
	const query = useUpstreamCandidates(wanted && !candidates);
	const data = candidates ?? query.data;
	const [input, setInput] = useState(value || "");

	useEffect(() => {
		setInput((current) => (current === (value || "") ? current : value || ""));
	}, [value]);

	const groups = useMemo(() => groupCandidates(data?.items), [data]);
	const dockerDisabled = data?.providers?.docker?.status === "disabled";
	const { refresh, isRefreshing } = query;

	const footer = useMemo<MenuFooterInfo>(
		() => ({ dockerDisabled, onRefresh: candidates ? undefined : refresh, isRefreshing }),
		[dockerDisabled, candidates, refresh, isRefreshing],
	);

	const setValue = (v: string) => {
		setInput(v);
		onChange(v);
	};

	const handleChange = (opt: SingleValue<UpstreamOption>) => {
		if (!opt) {
			setValue("");
			return;
		}
		setValue(opt.value);
		if (opt.candidate && !opt.__isNew__) {
			onSelectCandidate?.(candidatePrefill(opt.candidate), opt.candidate);
		}
	};

	const selected: UpstreamOption | null = value ? { value, label: value } : null;

	return (
		<MenuFooterContext.Provider value={footer}>
			<div className={cn({ "is-invalid": isInvalid })}>
				<CreatableSelect<UpstreamOption, false, GroupBase<UpstreamOption>>
					inputId={id}
					className={cn("react-select-container", { "is-invalid": isInvalid })}
					classNamePrefix="react-select"
					options={groups}
					value={selected}
					inputValue={input}
					// The typed text *is* the value, so it's shown as input text rather than as a
					// selected chip, and stays editable.
					controlShouldRenderValue={false}
					isClearable
					isLoading={!candidates && query.isFetching}
					placeholder={placeholder}
					components={{ Option, MenuList, Input }}
					onMenuOpen={() => setWanted(true)}
					onFocus={() => setWanted(true)}
					onBlur={onBlur}
					onInputChange={(v, meta) => {
						// Ignore the resets react-select does on blur / menu close / select
						if (meta.action === "input-change") {
							setValue(v);
						}
					}}
					onChange={handleChange}
					onCreateOption={(v) => setValue(v.trim())}
					formatCreateLabel={(v) => intl.formatMessage({ id: "upstream.use-value" }, { value: v })}
					isValidNewOption={(v, _selected, options) => {
						const t = v.trim();
						if (!t || t === value) return false;
						return !options.some((o: any) => o.value === t || o.options?.some((i: any) => i.value === t));
					}}
					noOptionsMessage={() => intl.formatMessage({ id: "upstream.no-options" })}
					loadingMessage={() => intl.formatMessage({ id: "upstream.loading" })}
					styles={{
						option: (base) => ({ ...base, height: "100%" }),
						control: (base) =>
							isInvalid ? { ...base, borderColor: "var(--tblr-form-invalid-border-color)" } : base,
					}}
				/>
			</div>
		</MenuFooterContext.Provider>
	);
}
