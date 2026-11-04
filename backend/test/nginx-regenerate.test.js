import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createSingleFlight,
	HOST_TYPES,
	hostName,
	locationWarning,
	normaliseHostTypes,
	summarise,
} from "../lib/nginx-regenerate.js";

describe("normaliseHostTypes", () => {
	it("defaults to all host types", () => {
		assert.deepEqual(normaliseHostTypes(), HOST_TYPES);
		assert.deepEqual(normaliseHostTypes([]), HOST_TYPES);
		assert.deepEqual(normaliseHostTypes(null), HOST_TYPES);
	});

	it("keeps known types in a stable order and drops unknown ones", () => {
		assert.deepEqual(normaliseHostTypes(["stream", "proxy_host", "nope"]), ["proxy_host", "stream"]);
	});
});

describe("hostName", () => {
	it("uses the first domain name", () => {
		assert.equal(hostName("proxy_host", { id: 3, domain_names: ["a.example.com", "b.example.com"] }), "a.example.com");
	});

	it("uses the incoming port of a stream", () => {
		assert.equal(hostName("stream", { id: 4, incoming_port: 2222 }), "2222");
	});

	it("falls back to the id", () => {
		assert.equal(hostName("dead_host", { id: 5, domain_names: [] }), "#5");
	});
});

describe("locationWarning", () => {
	it("is null without broken locations", () => {
		assert.equal(locationWarning(undefined), null);
		assert.equal(locationWarning([{ path: "/a", status: "ok" }, { path: "/b", status: "disabled" }]), null);
	});

	it("lists quarantined and unresolved locations", () => {
		const text = locationWarning([
			{ path: "/a", status: "ok" },
			{ path: "/b", status: "quarantined", message: "Disabled because nginx rejected it" },
			{ path: "/c", status: "unresolved", message: null },
		]);
		assert.equal(text, "/b: Disabled because nginx rejected it\n/c: unresolved");
	});
});

describe("summarise", () => {
	it("counts online, offline and failed hosts and collects location warnings", () => {
		const summary = summarise([
			{ hostType: "proxy_host", row: { id: 1, domain_names: ["ok.example.com"] }, meta: { nginx_online: true } },
			{
				hostType: "proxy_host",
				row: { id: 2, domain_names: ["warn.example.com"] },
				meta: {
					nginx_online: true,
					nginx_locations: [{ path: "/x", status: "unresolved", message: "x does not resolve" }],
				},
			},
			{
				hostType: "redirection_host",
				row: { id: 3, domain_names: ["off.example.com"] },
				meta: { nginx_online: false, nginx_err: "unknown directive" },
			},
			{ hostType: "stream", row: { id: 4, incoming_port: 9000 }, error: new Error("certificate missing") },
		]);
		assert.equal(summary.checked, 4);
		assert.equal(summary.regenerated, 2);
		assert.deepEqual(summary.offline, [
			{ host_type: "redirection_host", id: 3, name: "off.example.com", error: "unknown directive" },
		]);
		assert.deepEqual(summary.failed, [{ host_type: "stream", id: 4, name: "9000", error: "certificate missing" }]);
		assert.deepEqual(summary.warnings, [
			{ host_type: "proxy_host", id: 2, name: "warn.example.com", message: "/x: x does not resolve" },
		]);
	});

	it("handles no hosts", () => {
		assert.deepEqual(summarise([]), { checked: 0, regenerated: 0, offline: [], failed: [], warnings: [] });
	});
});

describe("createSingleFlight", () => {
	it("rejects a second call while the first one runs, then allows the next one", async () => {
		const flight = createSingleFlight(() => Object.assign(new Error("busy"), { status: 409 }));
		let release;
		const first = flight.run(() => new Promise((resolve) => (release = resolve)));
		assert.equal(flight.isRunning(), true);
		await assert.rejects(flight.run(async () => "second"), (err) => err.status === 409);
		release("first");
		assert.equal(await first, "first");
		assert.equal(flight.isRunning(), false);
		assert.equal(await flight.run(async () => "third"), "third");
	});

	it("is free again after the call throws", async () => {
		const flight = createSingleFlight(() => new Error("busy"));
		await assert.rejects(
			flight.run(async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.equal(flight.isRunning(), false);
	});
});
