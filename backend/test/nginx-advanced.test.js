import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findForbiddenFileDirective, tokenize } from "../lib/nginx-advanced.js";

describe("tokenize", () => {
	it("splits statements, handles quotes and comments", () => {
		assert.deepEqual(tokenize('access_log "/a b" main; # error_log /x;\nlocation /p { include x; }'), [
			["access_log", "/a b", "main"],
			["location", "/p"],
			["include", "x"],
		]);
	});
});

describe("findForbiddenFileDirective", () => {
	const rejected = [
		"access_log /data/nginx/proxy_host/5.conf;",
		"access_log /data/nginx/custom/http.conf combined;",
		'error_log "/etc/nginx/conf.d/x.conf" warn;',
		"access_log /data/logs/../nginx/proxy_host/2.conf;",
		"access_log logs/x.log;",
		"location /x {\n  error_log /etc/nginx/nginx.conf;\n}",
		"include /data/nginx/proxy_host/2.conf;",
		"include /data/nginx/stream/*.conf;",
		"include /data/nginx/default_host/site.conf;",
		"include /data//nginx/redirection_host/1.conf;",
		"include '/data/nginx/dead_host/3.conf';",
	];
	for (const text of rejected) {
		it(`rejects ${text}`, () => {
			const out = findForbiddenFileDirective(text);
			assert.ok(out, text);
			assert.match(out.reason, /not allowed|must not/);
		});
	}

	const allowed = [
		"",
		"access_log off;",
		"access_log /data/logs/custom_access.log proxy;",
		"error_log /data/logs/custom_error.log warn;",
		"access_log syslog:server=10.0.0.1 combined;",
		"error_log stderr;",
		"access_log /dev/stdout;",
		"access_log $logpath;",
		"include /data/nginx/custom/snippet.conf;",
		"include /snippets/auth.conf;",
		"include conf.d/include/ssl-ciphers.conf;",
		"root /data/nginx/proxy_host;",
		"alias /data/nginx/;",
		"# access_log /data/nginx/proxy_host/5.conf;",
		'add_header X-Path "access_log /data/nginx/proxy_host/5.conf";',
		"proxy_pass http://backend;",
	];
	for (const text of allowed) {
		it(`allows ${text || "(empty)"}`, () => {
			assert.equal(findForbiddenFileDirective(text), null);
		});
	}
});
