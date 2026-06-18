/**
 * Verification pipeline.
 *
 * Runs the user-supplied verify command (PI_DYNAMIC_DAG_VERIFY_CMD) in the
 * project cwd. The command is executed through a shell (`sh -c` / `cmd /c`) so
 * it may be any command string with arguments ("npm test", "pytest -x", etc.).
 * Exit code 0 == passed; anything else (incl. timeout/kill) == failed.
 */
import { getApi } from "./state.ts";
import { DAG_VERIFY_CMD_ENV, DAG_VERIFY_TIMEOUT_MS } from "./types.ts";

export interface VerifyResult {
	passed: boolean;
	/** Tail of the combined stdout+stderr, capped for prompt injection. */
	output: string;
}

/** Read and normalize the verify command from the environment. */
export function getVerifyCommand(): string | undefined {
	const cmd = process.env[DAG_VERIFY_CMD_ENV];
	return cmd && cmd.trim().length > 0 ? cmd.trim() : undefined;
}

/**
 * Run the verification command. When PI_DYNAMIC_DAG_VERIFY_CMD is unset the
 * result is a hard failure (verification is mandatory), so the caller must not
 * treat the task as DONE.
 */
export async function runVerification(cwd: string, signal?: AbortSignal): Promise<VerifyResult> {
	const cmd = getVerifyCommand();
	if (!cmd) {
		return { passed: false, output: `${DAG_VERIFY_CMD_ENV} 环境变量未设置` };
	}
	const api = getApi();
	if (!api) return { passed: false, output: "扩展 API 不可用" };
	// Shell-wrap to support arbitrary command strings (spaces, flags, &&).
	const shell = process.platform === "win32" ? "cmd" : "sh";
	const flag = process.platform === "win32" ? "/c" : "-c";
	const r = await api.exec(shell, [flag, cmd], { cwd, signal, timeout: DAG_VERIFY_TIMEOUT_MS });
	const output = (r.stdout + r.stderr).slice(-500);
	return { passed: r.code === 0, output };
}
