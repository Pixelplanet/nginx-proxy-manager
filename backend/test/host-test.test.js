import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTestResult, buildTestTargets, hasQuarantinedLocation, mergeTargetResults } from "../lib/host-test.js";

describe("buildTestTargets", () => {
	it("checks the main target and the enabled locations of a proxy host, also when it is disabled", () => {
		const targets = buildTestTargets("proxy_host", {
			id: "npm-dry-run",
			enabled: false,
			forward_host: "app",
			forward_port: 8080,
			forward_scheme: "http",
			locations: [
				{ path: "/api", forward_host: "api/v1", forward_port: 9000, forward_scheme: "https" },
				{ path: "/off", forward_host: "off", forward_port: 1, enabled: false },
				{ path: "/var", forward_host: "$backend", forward_port: 80 },
			],
		});
		assert.deepEqual(targets, [
			{ location_index: null, host: "app", port: 8080, scheme: "http" },
			{ location_index: 0, path: "/api", host: "api", port: 9000, scheme: "https" },
		]);
	});

	it("checks the target of a TCP stream only", () => {
		assert.deepEqual(
			buildTestTargets("stream", {
				forwarding_host: "db",
				forwarding_port: 5432,
				tcp_forwarding: true,
			}),
			[{ location_index: null, host: "db", port: 5432, scheme: null }],
		);
		assert.deepEqual(
			buildTestTargets("stream", { forwarding_host: "dns", forwarding_port: 53, tcp_forwarding: false }),
			[],
		);
	});

	it("has nothing to check for redirection and 404 hosts", () => {
		assert.deepEqual(buildTestTargets("redirection_host", { forward_domain_name: "example.com" }), []);
		assert.deepEqual(buildTestTargets("dead_host", {}), []);
		assert.deepEqual(buildTestTargets("proxy_host", null), []);
	});

	it("checks at most 20 targets", () => {
		const locations = Array.from({ length: 30 }, (_, i) => ({
			path: `/p${i}`,
			forward_host: `h${i}`,
			forward_port: 80,
		}));
		const targets = buildTestTargets("proxy_host", { forward_host: "app", forward_port: 80, locations });
		assert.equal(targets.length, 20);
	});
});

describe("mergeTargetResults", () => {
	it("adds the location of each target to its result", () => {
		const merged = mergeTargetResults(
			[
				{ location_index: null, host: "app", port: 80 },
				{ location_index: 1, path: "/api", host: "api", port: 81 },
			],
			[
				{ host: "app", port: 80, ok: true, code: "ok" },
				{ host: "api", port: 81, ok: false, code: "tcp_refused" },
			],
		);
		assert.deepEqual(merged, [
			{ host: "app", port: 80, ok: true, code: "ok", location_index: null, path: null },
			{ host: "api", port: 81, ok: false, code: "tcp_refused", location_index: 1, path: "/api" },
		]);
	});
});

describe("buildTestResult", () => {
	it("is ok when nginx accepts the host", () => {
		const result = buildTestResult({
			meta: {
				nginx_online: true,
				nginx_locations: [{ index: 0, path: "/a", status: "unresolved", mode: "dynamic", message: "x" }],
			},
			error: null,
			locations: null,
		});
		assert.equal(result.ok, true);
		assert.equal(result.nginx_online, true);
		assert.equal(result.nginx_err, null);
		assert.equal(result.nginx_details, null);
		assert.equal(result.nginx_locations.length, 1);
		assert.deepEqual(result.upstreams, []);
		assert.deepEqual(result.warnings, []);
	});

	it("is not ok when a location would be quarantined, the host stays online", () => {
		const result = buildTestResult({
			meta: {
				nginx_online: true,
				nginx_locations: [{ index: 0, path: "/a", status: "quarantined", mode: null, message: "bad" }],
			},
			error: null,
		});
		assert.equal(result.ok, false);
		assert.equal(result.nginx_online, true);
	});

	it("reports a host level rejection with its details and the location states", () => {
		const error = new Error("Advanced configuration: unknown directive.");
		error.details = { kind: "nginx_config", scope: "host" };
		const result = buildTestResult({
			meta: null,
			error,
			locations: [{ index: 0, path: "/a", status: "ok", mode: "static", message: null }],
		});
		assert.equal(result.ok, false);
		assert.equal(result.nginx_online, false);
		assert.equal(result.nginx_err, "Advanced configuration: unknown directive.");
		assert.deepEqual(result.nginx_details, { kind: "nginx_config", scope: "host" });
		assert.equal(result.nginx_locations.length, 1);
	});

	it("reports a render failure without details", () => {
		const result = buildTestResult({ meta: null, error: new Error("template error"), locations: null });
		assert.equal(result.ok, false);
		assert.equal(result.nginx_details, null);
		assert.deepEqual(result.nginx_locations, []);
	});
});

describe("hasQuarantinedLocation", () => {
	it("only counts quarantined locations", () => {
		assert.equal(hasQuarantinedLocation(undefined), false);
		assert.equal(hasQuarantinedLocation([{ status: "disabled" }, { status: "unresolved" }]), false);
		assert.equal(hasQuarantinedLocation([{ status: "ok" }, { status: "quarantined" }]), true);
	});
});
