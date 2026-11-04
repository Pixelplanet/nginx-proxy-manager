import { spawn } from "node:child_process";

/**
 * Runs a shell command in the Cypress node process.
 * Replacement for cy.exec(), which was removed in Cypress 16.
 *
 * Yields the same shape cy.exec() did: { code, exitCode, stdout, stderr },
 * with one trailing newline stripped from stdout and stderr.
 *
 * @param   {object}  options
 * @param   {string}  options.command                    Run with `sh -c`
 * @param   {bool}    [options.failOnNonZeroExit=true]   Reject when the exit code is not 0
 * @param   {number}  [options.timeout=50000]            Kill the command after this many ms
 * @param   {string}  [options.cwd]                      Defaults to the Cypress project root
 * @returns {Promise<object>}
 */
export const exec = ({ command, failOnNonZeroExit = true, timeout = 50000, cwd }) => {
	return new Promise((resolve, reject) => {
		if (typeof command !== "string" || command === "") {
			reject(new Error("exec: command must be a non-empty string"));
			return;
		}

		// Own process group, so a timeout also kills what the shell started
		const child = spawn("sh", ["-c", command], { cwd, env: process.env, detached: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeout);

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const exitCode = code === null ? 1 : code;
			const result = {
				code: exitCode,
				exitCode: exitCode,
				stdout: stdout.replace(/\n$/, ""),
				stderr: stderr.replace(/\n$/, ""),
			};

			if (timedOut) {
				reject(new Error(`exec: timed out after ${timeout}ms: ${command}`));
				return;
			}
			if (failOnNonZeroExit && (exitCode !== 0 || signal)) {
				reject(
					new Error(
						`exec: exit code ${exitCode}${signal ? ` (${signal})` : ""}: ${command}\n${result.stderr}`,
					),
				);
				return;
			}
			resolve(result);
		});
	});
};

export default (config) => {
	return {
		exec: (options) => exec({ cwd: config.projectRoot, ...options }),
	};
};
