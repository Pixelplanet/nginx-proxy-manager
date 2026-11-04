import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	attributeToHostFile,
	blameOtherHost,
	blameUnattributed,
	errorPaths,
	mentionsPath,
	regenerateOrDisable,
} from "../lib/nginx-blame.js";

const CERT = "/etc/letsencrypt/live/npm-2/fullchain.pem";
const certError = {
	file: null,
	line: null,
	message: `cannot load certificate "${CERT}": BIO_new_file() failed`,
	output: "",
};
const LOG = "/data/logs/proxy-host-5_access.log";
const LOG_ERROR = {
	file: null,
	line: null,
	message: `open() "${LOG}" failed (13: Permission denied)`,
	output: "",
};

describe("mentionsPath", () => {
	it("matches any directive but not comments", () => {
		assert.equal(mentionsPath(`  ssl_certificate ${CERT};`, CERT), true);
		assert.equal(mentionsPath(`  access_log ${CERT};`, CERT), true);
		assert.equal(mentionsPath(`  # ssl_certificate ${CERT};`, CERT), false);
	});
});

describe("attributeToHostFile", () => {
	it("keeps a parsed file", () => {
		const parsed = { file: "/data/nginx/proxy_host/9.conf", message: `"${CERT}"` };
		assert.equal(attributeToHostFile(parsed, { file: "/data/nginx/proxy_host/1.conf", text: CERT }), parsed);
	});

	it("blames the host being saved when its config mentions the path", () => {
		const own = { file: "/data/nginx/proxy_host/1.conf", text: `access_log ${CERT};` };
		assert.equal(attributeToHostFile(certError, own).file, own.file);
	});

	it("never blames another host by itself", () => {
		const own = { file: "/data/nginx/proxy_host/1.conf", text: "return 200;" };
		assert.equal(attributeToHostFile(certError, own).file, null);
		assert.equal(attributeToHostFile(certError, undefined).file, null);
	});

	it("leaves errors without a path alone", () => {
		const parsed = { file: null, message: "something broke" };
		const own = { file: "/data/nginx/proxy_host/1.conf", text: "x" };
		assert.equal(attributeToHostFile(parsed, own), parsed);
	});
});

describe("errorPaths", () => {
	it("extracts quoted absolute paths", () => {
		assert.deepEqual(errorPaths(LOG_ERROR.message), [LOG]);
		assert.deepEqual(errorPaths("no paths here"), []);
	});
});

describe("blameUnattributed", () => {
	const OWN = "/data/nginx/proxy_host/1.conf";
	const A = { file: "/data/nginx/proxy_host/5.conf", text: `access_log ${LOG} proxy;` };
	const MENTION = { file: "/data/nginx/proxy_host/7.conf", text: `# mentions\nadd_header X-Log "${LOG}";` };
	const UNRELATED = { file: "/data/nginx/dead_host/3.conf", text: "return 404;" };
	const fail = (message) => ({ ok: false, parsed: { file: null, line: null, message, output: message } });

	it("heals the host whose removal makes the test pass, after testing without the saved host", async () => {
		const calls = [];
		const out = await blameUnattributed(LOG_ERROR, {
			own: { file: OWN },
			listFiles: () => [{ file: OWN, text: "" }, UNRELATED, A],
			testWithout: async () => {
				calls.push("without-own");
				return fail(LOG_ERROR.message);
			},
			testWithoutCandidate: async (file) => {
				calls.push(file);
				return file === A.file ? { ok: true } : fail(LOG_ERROR.message);
			},
		});
		assert.equal(out.action, "heal");
		assert.deepEqual(out.other, { host_type: "proxy_host", host_id: 5 });
		assert.equal(out.parsed.file, A.file);
		// only hosts that mention the path are tried
		assert.deepEqual(calls, ["without-own", A.file]);
	});

	it("never heals on mere mention", async () => {
		const out = await blameUnattributed(LOG_ERROR, {
			own: { file: OWN },
			listFiles: () => [MENTION, A],
			testWithout: async () => fail(LOG_ERROR.message),
			testWithoutCandidate: async () => fail(LOG_ERROR.message),
		});
		assert.equal(out.action, "global");
	});

	it("picks the candidate that is really at fault, not the first mention", async () => {
		const out = await blameUnattributed(LOG_ERROR, {
			own: { file: OWN },
			listFiles: () => [MENTION, A],
			testWithout: async () => fail(LOG_ERROR.message),
			testWithoutCandidate: async (file) => (file === A.file ? { ok: true } : fail(LOG_ERROR.message)),
		});
		assert.equal(out.other.host_id, 5);
	});

	it("counts a different remaining error as progress", async () => {
		const out = await blameUnattributed(LOG_ERROR, {
			own: { file: OWN },
			listFiles: () => [A],
			testWithout: async () => fail(LOG_ERROR.message),
			testWithoutCandidate: async () => fail('cannot load certificate "/etc/x.pem"'),
		});
		assert.equal(out.action, "heal");
	});

	it("is a conflict of the saved host when the test passes without it", async () => {
		let candidates = 0;
		const out = await blameUnattributed(LOG_ERROR, {
			own: { file: OWN },
			listFiles: () => [A],
			testWithout: async () => ({ ok: true }),
			testWithoutCandidate: async () => {
				candidates++;
				return { ok: true };
			},
		});
		assert.equal(out.action, "conflict");
		assert.equal(candidates, 0);
	});

	it("handles a remaining error that names a file like blameOtherHost", async () => {
		const named = { file: "/data/nginx/stream/2.conf", line: 4, message: "x" };
		const out = await blameUnattributed(LOG_ERROR, {
			own: { file: OWN },
			listFiles: () => [A],
			testWithout: async () => ({ ok: false, parsed: named }),
			testWithoutCandidate: async () => ({ ok: true }),
		});
		assert.equal(out.action, "heal");
		assert.deepEqual(out.other, { host_type: "stream", host_id: 2 });
	});

	it("works without a saved host (reload / boot)", async () => {
		const out = await blameUnattributed(LOG_ERROR, {
			listFiles: () => [A],
			testWithoutCandidate: async () => ({ ok: true }),
		});
		assert.equal(out.action, "heal");
		assert.equal(out.other.host_id, 5);
	});

	it("is global when nothing mentions the path", async () => {
		const out = await blameUnattributed(LOG_ERROR, {
			listFiles: () => [UNRELATED],
			testWithoutCandidate: async () => ({ ok: true }),
		});
		assert.equal(out.action, "global");
	});
});

describe("regenerateOrDisable", () => {
	it("regenerates an enabled host instead of disabling it", async () => {
		let disabled = false;
		const out = await regenerateOrDisable({
			enabled: true,
			depth: 0,
			regenerate: async () => {},
			disable: async () => {
				disabled = true;
			},
		});
		assert.equal(out, "regenerated");
		assert.equal(disabled, false);
	});

	it("disables when the regenerated config still fails, passing the error on", async () => {
		const failure = new Error("host level");
		let got = null;
		const out = await regenerateOrDisable({
			enabled: true,
			depth: 0,
			regenerate: async () => {
				throw failure;
			},
			disable: async (err) => {
				got = err;
			},
		});
		assert.equal(out, "disabled");
		assert.equal(got, failure);
	});

	it("does not regenerate disabled hosts or nested repairs", async () => {
		for (const opts of [
			{ enabled: false, depth: 0 },
			{ enabled: true, depth: 1 },
		]) {
			let regenerated = false;
			const out = await regenerateOrDisable({
				...opts,
				regenerate: async () => {
					regenerated = true;
				},
				disable: async () => {},
			});
			assert.equal(out, "disabled");
			assert.equal(regenerated, false);
		}
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
