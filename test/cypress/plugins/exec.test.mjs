// Run with: node --test cypress/plugins/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import execTask, { exec } from "./exec.mjs";

describe("exec task", () => {
	it("yields the cy.exec() result shape", async () => {
		const res = await exec({ command: "printf 'a\\nb\\n'; printf 'err\\n' >&2" });
		assert.deepEqual(res, { code: 0, exitCode: 0, stdout: "a\nb", stderr: "err" });
	});

	it("rejects on a non-zero exit code by default", async () => {
		await assert.rejects(exec({ command: "echo oops >&2; exit 3" }), /exit code 3: .*\noops$/);
	});

	it("resolves with the exit code when failOnNonZeroExit is false", async () => {
		const res = await exec({ command: "echo out; exit 2", failOnNonZeroExit: false });
		assert.equal(res.exitCode, 2);
		assert.equal(res.code, 2);
		assert.equal(res.stdout, "out");
	});

	it("kills the command after the timeout", async () => {
		const started = Date.now();
		await assert.rejects(exec({ command: "sleep 5", timeout: 200, failOnNonZeroExit: false }), /timed out after 200ms/);
		assert.ok(Date.now() - started < 3000);
	});

	it("rejects an empty command", async () => {
		await assert.rejects(exec({ command: "" }), /non-empty string/);
	});

	it("runs in the Cypress project root unless cwd is given", async () => {
		const tasks = execTask({ projectRoot: "/" });
		assert.equal((await tasks.exec({ command: "pwd" })).stdout, "/");
		assert.equal((await tasks.exec({ command: "pwd", cwd: "/tmp" })).stdout, "/tmp");
	});
});
