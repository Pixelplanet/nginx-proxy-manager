import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamCheckHint } from "./StatusBadges";

vi.mock("src/context", () => ({ useLocaleState: () => ({ locale: "en" }) }));

describe("UpstreamCheckHint", () => {
	afterEach(() => cleanup());

	it("renders the result as a hint line, not a badge", () => {
		const { container } = render(
			<UpstreamCheckHint
				id="h"
				result={{ host: "app", port: 80, ok: true, code: "ok", ms: 3, message: "", addresses: ["10.0.0.2"] }}
			/>,
		);
		const hint = container.querySelector("#h");
		expect(hint).toHaveClass("form-hint");
		expect(hint).toHaveAttribute("data-check", "ok");
		expect(hint).toHaveTextContent("Reachable (3 ms)");
		expect(hint).toHaveTextContent("10.0.0.2");
		expect(container.querySelector(".badge")).toBeNull();
	});

	it("shows a checking state and nothing without a result", () => {
		const { container, rerender } = render(<UpstreamCheckHint id="h" result={null} isChecking />);
		expect(container.querySelector("#h")).toHaveAttribute("data-check", "checking");
		rerender(<UpstreamCheckHint id="h" result={null} />);
		expect(container.querySelector("#h")).toBeNull();
	});
});
