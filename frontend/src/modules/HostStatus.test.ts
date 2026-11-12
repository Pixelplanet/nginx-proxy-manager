import { describe, expect, it } from "vitest";
import { isVariableHost, locationHostPart } from "./HostStatus";

describe("isVariableHost", () => {
	it("finds forward hosts with nginx variables like the backend", () => {
		for (const host of ["$backend", " $backend ", "app-$stage", "$svc.internal", "a$x$y"]) {
			expect(isVariableHost(host)).toBe(true);
		}
		expect(isVariableHost(locationHostPart("app-$stage/api"))).toBe(true);
	});

	it("leaves out plain hosts and values that can't be written into nginx config", () => {
		for (const host of ["app", "", null, undefined, "app-$x;", "$x y", "app-$" + "{stage}"]) {
			expect(isVariableHost(host)).toBe(false);
		}
	});
});
