import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DnsDiscoveryUnavailable, discoverDns, ownIpv4Subnets } from "../lib/upstream/dns-discovery.js";

const notFound = () => Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });

/**
 * Fake embedded DNS modelled on what Docker actually answered on this host:
 *   .1 (gateway) -> host's own name, own IP -> [], containers -> "<name>.<network>", free -> ENOTFOUND
 */
const fakeDockerDns = ({ ptr, forward }) => {
	const queried = [];
	return {
		queried,
		reverse: async (ip) => {
			queried.push(ip);
			if (ip in ptr) {
				return ptr[ip];
			}
			throw notFound();
		},
		resolve4: async (name) => {
			if (name in forward) {
				return forward[name];
			}
			throw notFound();
		},
	};
};

const interfaces = {
	lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
	eth0: [
		{ address: "172.24.0.4", family: "IPv4", internal: false, cidr: "172.24.0.4/16" },
		{ address: "fe80::1", family: "IPv6", internal: false, cidr: "fe80::1/64" },
	],
};

describe("dns discovery", () => {
	it("is unavailable off a user-defined network", async () => {
		await assert.rejects(
			discoverDns({ nameservers: ["192.168.1.1"], interfaces, gateways: [] }),
			(err) => err instanceof DnsDiscoveryUnavailable && /user-defined Docker network/.test(err.message),
		);
	});

	it("finds containers, skips self and gateway, verifies forward", async () => {
		const resolver = fakeDockerDns({
			ptr: {
				"172.24.0.1": ["Ubuntu-2404-noble-amd64-base", "Ubuntu-2404-noble-amd64-base.local"],
				"172.24.0.2": ["npmx-up-app.npmx-up-net."],
				"172.24.0.3": ["npmx-up-db.npmx-up-net."],
				"172.24.0.4": [],
				// stale PTR: forward lookup points elsewhere -> ignored
				"172.24.0.6": ["ghost.npmx-up-net."],
			},
			forward: {
				"npmx-up-app": ["172.24.0.2"],
				"npmx-up-db": ["172.24.0.3"],
				ghost: ["172.24.0.99"],
				// the gateway's ".local" name doesn't resolve through embedded DNS
			},
		});
		const result = await discoverDns({
			nameservers: ["127.0.0.11"],
			interfaces,
			gateways: ["172.24.0.1"],
			resolver,
		});
		assert.deepEqual(
			result.items.map((i) => [i.host, i.network, i.ip, i.source]),
			[
				["npmx-up-app", "npmx-up-net", "172.24.0.2", "dns"],
				["npmx-up-db", "npmx-up-net", "172.24.0.3", "dns"],
			],
		);
		assert.equal(resolver.queried.includes("172.24.0.1"), false, "gateway skipped");
		assert.equal(resolver.queried.includes("172.24.0.4"), false, "own IP skipped");
		assert.equal(result.items[0].label, "npmx-up-app (on npmx-up-net)");
		assert.deepEqual(result.items[0].ports, []);
	});

	it("stops after a run of misses on a /16", async () => {
		const resolver = fakeDockerDns({ ptr: { "172.24.0.2": ["a.net"] }, forward: { a: ["172.24.0.2"] } });
		const result = await discoverDns({
			nameservers: ["127.0.0.11"],
			interfaces,
			gateways: [],
			resolver,
			limits: { concurrency: 16, maxConsecutiveMisses: 32 },
		});
		assert.equal(result.items.length, 1);
		assert.ok(result.scanned <= 48, `scanned ${result.scanned}`);
		assert.equal(result.truncated, false);
	});

	it("respects the address cap and deadline", async () => {
		const ptr = {};
		const forward = {};
		for (let i = 2; i < 250; i++) {
			ptr[`172.24.0.${i}`] = [`c${i}.net`];
			forward[`c${i}`] = [`172.24.0.${i}`];
		}
		const capped = await discoverDns({
			nameservers: ["127.0.0.11"],
			interfaces,
			gateways: [],
			resolver: fakeDockerDns({ ptr, forward }),
			limits: { maxAddresses: 40 },
		});
		assert.equal(capped.scanned, 40);
		assert.equal(capped.truncated, true);

		const slow = {
			reverse: () => new Promise((resolve) => setTimeout(() => resolve([]), 50)),
			resolve4: async () => [],
		};
		const started = Date.now();
		const timed = await discoverDns({
			nameservers: ["127.0.0.11"],
			interfaces,
			gateways: [],
			resolver: slow,
			limits: { deadlineMs: 200 },
		});
		assert.equal(timed.truncated, true);
		assert.ok(Date.now() - started < 1000);
	});

	it("lists only external IPv4 interfaces", () => {
		assert.deepEqual(ownIpv4Subnets(interfaces), [{ cidr: "172.24.0.4/16", address: "172.24.0.4", iface: "eth0" }]);
	});
});
