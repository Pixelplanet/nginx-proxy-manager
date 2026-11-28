import type { ProxyLocation, UpstreamCandidate, UpstreamSuggestion } from "src/api/backend";
import { describe, expect, it, vi } from "vitest";
import { locationFromCandidate, locationPickFill, locationSuggestions, suggestionTarget } from "./LocationSuggestions";

vi.mock("src/hooks", () => ({ useUpstreamCandidates: () => ({ data: undefined }) }));

const suggestion = (s: Partial<UpstreamSuggestion> = {}): UpstreamSuggestion => ({
	domainNames: [],
	forwardScheme: "http",
	forwardHost: "x",
	forwardPort: null,
	allowWebsocketUpgrade: false,
	blockExploits: false,
	cachingEnabled: false,
	http2Support: false,
	ignoredDomains: [],
	locationPath: null,
	locationForwardPath: null,
	ignoredPaths: [],
	existingHostId: null,
	existingHostType: null,
	...s,
});

const docker = (
	host: string,
	s: Partial<UpstreamSuggestion>,
	c: Partial<UpstreamCandidate> = {},
): UpstreamCandidate => ({
	host,
	kind: "container",
	owner: null,
	source: "docker",
	ports: [8080],
	hintPort: 8080,
	hintScheme: null,
	network: "npm_default",
	state: "running",
	ip: null,
	usedBy: 0,
	suggestion: suggestion({ forwardHost: host, ...s }),
	...c,
});

const api = docker("shop-api", { domainNames: ["shop.example.com"], locationPath: "/api/", locationForwardPath: "/" });
const loc = (path: string): ProxyLocation => ({
	path,
	advancedConfig: "",
	forwardScheme: "http",
	forwardHost: "app",
	forwardPort: 80,
});

describe("locationFromCandidate", () => {
	it("builds the custom location from the labels", () => {
		expect(locationFromCandidate(api)).toEqual({
			path: "/api/",
			advancedConfig: "",
			forwardScheme: "http",
			forwardHost: "shop-api/",
			forwardPort: 8080,
			accessListId: 0,
		});
		// no npm.forward_path: the request path is passed on unchanged
		const kept = docker("be", { locationPath: "/api/" }, { hintPort: 443, ports: [443] });
		expect(locationFromCandidate(kept)).toMatchObject({
			forwardHost: "be",
			forwardPort: 443,
			forwardScheme: "https",
		});
		// no known port: left empty for the user
		expect(
			locationFromCandidate(docker("p", { locationPath: "/p/" }, { hintPort: null, ports: [] })).forwardPort,
		).toBe("");
	});

	it("shows where the location forwards to", () => {
		expect(suggestionTarget(locationFromCandidate(api))).toBe("http://shop-api:8080/");
		expect(suggestionTarget({ ...loc("/a"), forwardHost: "be" })).toBe("http://be:80");
	});
});

describe("locationSuggestions", () => {
	const web = docker("shop-web", { domainNames: ["shop.example.com"] });

	it("offers containers with npm.path whose npm.domain names match the host's", () => {
		const other = docker("blog-api", { domainNames: ["blog.example.com"], locationPath: "/api/" });
		const got = locationSuggestions([web, api, other], ["Shop.Example.com"], []);
		expect(got.map((s) => s.candidate.host)).toEqual(["shop-api"]);
		expect(got[0].location.path).toBe("/api/");
		expect(locationSuggestions([api], [], [])).toEqual([]);
		expect(locationSuggestions([api], undefined, [])).toEqual([]);
		expect(locationSuggestions(undefined, ["shop.example.com"], [])).toEqual([]);
	});

	it("offers each container once, under its compose service alias", () => {
		const alias = { ...api, host: "api", kind: "compose_service" as const, owner: "shop-api" };
		expect(locationSuggestions([api, alias], ["shop.example.com"], []).map((s) => s.candidate.host)).toEqual([
			"api",
		]);
		expect(locationSuggestions([alias, api], ["shop.example.com"], []).map((s) => s.candidate.host)).toEqual([
			"api",
		]);
		// two containers may both want the path: both are offered, the user picks one
		const second = docker("shop-api-2", { domainNames: ["shop.example.com"], locationPath: "/api/" });
		expect(locationSuggestions([api, second], ["shop.example.com"], [])).toHaveLength(2);
	});

	it("leaves out paths the form already has, as nginx compares them", () => {
		expect(locationSuggestions([api], ["shop.example.com"], [loc("/api/")])).toEqual([]);
		expect(locationSuggestions([api], ["shop.example.com"], [loc("^~ /api/")])).toEqual([]);
		expect(locationSuggestions([api], ["shop.example.com"], [loc(" /api/ ")])).toEqual([]);
		expect(locationSuggestions([api], ["shop.example.com"], [loc("/api"), loc("")])).toHaveLength(1);
		const regex = docker("img", { domainNames: ["shop.example.com"], locationPath: "~* \\.png$" });
		expect(locationSuggestions([regex], ["shop.example.com"], [loc("~*   \\.png$")])).toEqual([]);
	});

	it("never suggests DNS or history entries", () => {
		expect(locationSuggestions([{ ...api, source: "dns" }], ["shop.example.com"], [])).toEqual([]);
	});
});

describe("locationPickFill", () => {
	it("fills an empty path and the forward path", () => {
		expect(locationPickFill(api, { path: "", forwardHost: "" }, { path: "" })).toEqual({
			changes: { path: "/api/", forwardHost: "shop-api/" },
			picked: { path: "/api/", forwardPath: "/" },
		});
	});

	it("keeps a path the user typed, also the path part of the forward host", () => {
		const { changes, picked } = locationPickFill(api, { path: "/v2/", forwardHost: "old/x/" }, { path: "" });
		expect(changes).toEqual({ forwardHost: "shop-api/x/" });
		expect(picked).toEqual({});
		// a saved path is the user's too: changing it would move the location
		expect(locationPickFill(api, { path: "/old/", forwardHost: "old" }, { path: "/old/" }).changes).toEqual({
			forwardHost: "shop-api/",
		});
	});

	it("replaces what an earlier pick filled in, and resets it for a container without npm.path", () => {
		const first = locationPickFill(api, { path: "", forwardHost: "" }, { path: "" });
		const next = docker("v2", { locationPath: "/v2/", locationForwardPath: "/api/" });
		expect(locationPickFill(next, { path: "/api/", forwardHost: "shop-api/" }, { path: "" }, first.picked)).toEqual(
			{
				changes: { path: "/v2/", forwardHost: "v2/api/" },
				picked: { path: "/v2/", forwardPath: "/api/" },
			},
		);
		// a plain container: the path goes back to the saved one, the host is the pick's alone
		const plain = docker("plain", {});
		expect(
			locationPickFill(plain, { path: "/api/", forwardHost: "shop-api/" }, { path: "" }, first.picked),
		).toEqual({
			changes: { path: "" },
			picked: {},
		});
		// a path the user changed after the pick is theirs
		expect(
			locationPickFill(next, { path: "/mine/", forwardHost: "shop-api/" }, { path: "" }, first.picked).changes,
		).toEqual({ forwardHost: "v2/api/" });
	});
});
