import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { UpstreamCandidate, UpstreamCandidates } from "src/api/backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { candidatePrefill, groupCandidates, UpstreamField } from "./UpstreamField";

vi.mock("src/hooks", () => ({
	useUpstreamCandidates: () => ({ data: undefined, isFetching: false, refresh: vi.fn(), isRefreshing: false }),
}));

const candidate = (c: Partial<UpstreamCandidate>): UpstreamCandidate => ({
	host: "x",
	label: "x",
	source: "history",
	ports: [],
	hintPort: null,
	hintScheme: null,
	network: null,
	state: null,
	ip: null,
	usedBy: 0,
	...c,
});

const items: UpstreamCandidate[] = [
	candidate({ host: "old-app", label: "old-app", source: "history", ports: [3000], usedBy: 2 }),
	candidate({
		host: "app",
		label: "app (container)",
		source: "docker",
		ports: [8080, 9090],
		hintPort: 9090,
		hintScheme: "https",
		state: "running",
		network: "npm_default",
	}),
	candidate({ host: "db-ui", label: "db-ui", source: "dns", ports: [8081] }),
];

const data = (dockerStatus: "ok" | "disabled" = "ok"): UpstreamCandidates => ({
	providers: {
		docker: { status: dockerStatus, message: null },
		dns: { status: "ok", message: null },
		history: { status: "ok", message: null },
	},
	items,
	generatedAt: "2026-11-04T10:00:00Z",
});

function Harness({
	candidates,
	onChange,
	onSelectCandidate,
}: {
	candidates: UpstreamCandidates;
	onChange?: (v: string) => void;
	onSelectCandidate?: (...args: any[]) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<>
			<UpstreamField
				id="host"
				value={value}
				candidates={candidates}
				onChange={(v) => {
					setValue(v);
					onChange?.(v);
				}}
				onSelectCandidate={onSelectCandidate}
			/>
			<output data-testid="value">{value}</output>
		</>
	);
}

const openMenu = () => {
	const input = document.getElementById("host") as HTMLInputElement;
	fireEvent.focus(input);
	fireEvent.keyDown(input, { key: "ArrowDown", code: "ArrowDown" });
	return input;
};

describe("UpstreamField helpers", () => {
	it("groups candidates by source in a fixed order and drops empty groups", () => {
		const groups = groupCandidates(items);
		expect(groups.map((g) => g.label)).toEqual(["Docker containers", "Discovered on network", "Used before"]);
		expect(groups[0].options.map((o) => o.value)).toEqual(["app"]);
		expect(groupCandidates([items[0]]).map((g) => g.label)).toEqual(["Used before"]);
		expect(groupCandidates([])).toEqual([]);
	});

	it("prefills the hinted port and scheme, else a single port", () => {
		expect(candidatePrefill(items[1])).toEqual({ port: 9090, scheme: "https" });
		expect(candidatePrefill(items[0])).toEqual({ port: 3000 });
		expect(candidatePrefill(candidate({ ports: [80, 443] }))).toEqual({});
	});
});

describe("UpstreamField", () => {
	afterEach(() => cleanup());

	it("shows grouped options with ports and state", () => {
		render(<Harness candidates={data()} />);
		openMenu();
		expect(screen.getByText("Docker containers")).toBeInTheDocument();
		expect(screen.getByText("Discovered on network")).toBeInTheDocument();
		expect(screen.getByText("Used before")).toBeInTheDocument();
		expect(screen.getByText("running")).toBeInTheDocument();
		expect(screen.getByText(/Ports: 8080, 9090/)).toBeInTheDocument();
	});

	it("selecting a candidate sets the host and reports the prefill", () => {
		const onSelect = vi.fn();
		render(<Harness candidates={data()} onSelectCandidate={onSelect} />);
		openMenu();
		fireEvent.click(screen.getByText("app"));
		expect(screen.getByTestId("value")).toHaveTextContent("app");
		expect(onSelect).toHaveBeenCalledWith(
			{ port: 9090, scheme: "https" },
			expect.objectContaining({ host: "app" }),
		);
	});

	it("keeps the picked host visible after selecting and after leaving the field", () => {
		render(<Harness candidates={data()} />);
		const input = openMenu();
		fireEvent.click(screen.getByText("app"));
		expect(input.value).toBe("app");
		expect(input.style.opacity).not.toBe("0");
		fireEvent.blur(input);
		expect(input.value).toBe("app");
		expect(input.style.opacity).not.toBe("0");
	});

	it("keeps a created value visible after pressing Enter", () => {
		render(<Harness candidates={data()} />);
		const input = openMenu();
		fireEvent.change(input, { target: { value: "my-service" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		expect(screen.getByTestId("value")).toHaveTextContent("my-service");
		expect(input.value).toBe("my-service");
		expect(input.style.opacity).not.toBe("0");
		fireEvent.blur(input);
		expect(input.value).toBe("my-service");
		expect(input.style.opacity).not.toBe("0");
	});

	it("keeps free text verbatim, including host/path and IPs", () => {
		const onChange = vi.fn();
		const onSelect = vi.fn();
		render(<Harness candidates={data()} onChange={onChange} onSelectCandidate={onSelect} />);
		const input = openMenu();
		fireEvent.change(input, { target: { value: "10.0.0.1/sub/path" } });
		expect(onChange).toHaveBeenLastCalledWith("10.0.0.1/sub/path");
		expect(screen.getByTestId("value")).toHaveTextContent("10.0.0.1/sub/path");
		// still there after leaving the field
		fireEvent.blur(input);
		expect(input.value).toBe("10.0.0.1/sub/path");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("explains how to enable Docker discovery when it's disabled", () => {
		render(<Harness candidates={data("disabled")} />);
		openMenu();
		expect(screen.getByTestId("docker-disabled-hint")).toHaveTextContent("NPM_DOCKER_DISCOVERY=true");
	});

	it("doesn't show the Docker hint when discovery works", () => {
		render(<Harness candidates={data("ok")} />);
		openMenu();
		expect(screen.queryByTestId("docker-disabled-hint")).toBeNull();
	});
});
