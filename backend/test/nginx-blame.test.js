import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributeToHostFile, blameOtherHost, referencesInSslDirective } from "../lib/nginx-blame.js";

const CERT = "/etc/letsencrypt/live/npm-2/fullchain.pem";
const certError = {
	file: null,
	line: null,
	message: `cannot load certificate "${CERT}": BIO_new_file() failed`,
	output: "",
};

describe("referencesInSslDirective", () => {
	it("matches ssl_* directives only", () => {
		assert.equal(referencesInSslDirective(`  ssl_certificate ${CERT};`, CERT), true);
		assert.equal(referencesInSslDirective(`  access_log ${CERT};`, CERT), false);
		assert.equal(referencesInSslDirective(`  # ssl_certificate ${CERT};`, CERT), false);
	});
});

describe("attributeToHostFile", () => {
	const other = { file: "/data/nginx/proxy_host/2.conf", text: `ssl_certificate ${CERT};` };

	it("keeps a parsed file", () => {
		const parsed = { file: "/data/nginx/proxy_host/9.conf", message: `"${CERT}"` };
		assert.equal(attributeToHostFile(parsed, { listFiles: () => [other] }), parsed);
	});

	it("blames the host being saved when its config mentions the path", () => {
		const own = { file: "/data/nginx/proxy_host/1.conf", text: `access_log ${CERT};` };
		const out = attributeToHostFile(certError, { own, listFiles: () => [other] });
		assert.equal(out.file, own.file);
	});

	it("blames another host only through its own ssl_* directive", () => {
		const own = { file: "/data/nginx/proxy_host/1.conf", text: "return 200;" };
		assert.equal(attributeToHostFile(certError, { own, listFiles: () => [other] }).file, other.file);

		const logOnly = { file: "/data/nginx/proxy_host/3.conf", text: `access_log ${CERT};` };
		assert.equal(attributeToHostFile(certError, { own, listFiles: () => [logOnly] }).file, null);
	});

	it("leaves errors without a path alone", () => {
		const parsed = { file: null, message: "something broke" };
		assert.equal(attributeToHostFile(parsed, { listFiles: () => [other] }), parsed);
	});
});

describe("blameOtherHost", () => {
	const parsed = { file: "/data/nginx/proxy_host/2.conf", line: 3, message: "duplicate default server" };

	it("is a conflict of the saved host when the other file passes without it", async () => {
		const out = await blameOtherHost(parsed, async () => ({ ok: true }));
		assert.equal(out.action, "conflict");
		assert.equal(out.parsed, parsed);
	});

	it("heals the host whose file still fails", async () => {
		const alone = { file: "/data/nginx/dead_host/4.conf", line: 1, message: "unknown directive" };
		const out = await blameOtherHost(parsed, async () => ({ ok: false, parsed: alone }));
		assert.equal(out.action, "heal");
		assert.deepEqual(out.other, { host_type: "dead_host", host_id: 4 });
		assert.equal(out.parsed, alone);
	});

	it("is global when the remaining failure is no host file", async () => {
		const alone = { file: "/data/nginx/custom/http.conf", line: 1, message: "x" };
		const out = await blameOtherHost(parsed, async () => ({ ok: false, parsed: alone }));
		assert.equal(out.action, "global");
	});
});
