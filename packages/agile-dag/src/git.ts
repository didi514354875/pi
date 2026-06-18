/**
 * Git transaction operations.
 *
 * Git is the DAG's transaction boundary: a clean workspace is required before a
 * task starts; a passed verification triggers a commit; a failed verification
 * (or agent self-reported FAILED) triggers a hard reset + clean. All operations
 * run in `ctx.cwd` (the user's project, NOT the pi repo) with a bounded timeout.
 */
import { getApi } from "./state.ts";
import { DAG_GIT_TIMEOUT_MS } from "./types.ts";

/**
 * Is the working tree clean (no staged, unstaged, or untracked non-ignored
 * changes)? Used as the hard gate before starting a task.
 */
export async function isWorkspaceClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
	const api = getApi();
	if (!api) return false;
	const r = await api.exec("git", ["status", "--porcelain"], {
		cwd,
		signal,
		timeout: DAG_GIT_TIMEOUT_MS,
	});
	return r.code === 0 && r.stdout.trim().length === 0;
}

/**
 * Stage all changes (adds, modifies, deletes) and commit. "Nothing to commit"
 * (e.g. a pure-contract task with no file output) is treated as success.
 * Returns true on successful commit (or nothing-to-commit), false otherwise.
 */
export async function commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<boolean> {
	const api = getApi();
	if (!api) return false;
	await api.exec("git", ["add", "-A"], { cwd, signal, timeout: DAG_GIT_TIMEOUT_MS });
	const r = await api.exec("git", ["commit", "-m", message], {
		cwd,
		signal,
		timeout: DAG_GIT_TIMEOUT_MS,
	});
	if (r.code === 0) return true;
	const combined = r.stdout + r.stderr;
	return /nothing to commit|no changes/i.test(combined);
}

/**
 * Hard-reset the working tree to HEAD and remove untracked non-ignored files.
 * Called after a verification failure to roll back the task's partial work.
 * Ignored files (.env, node_modules, build output) are preserved.
 */
export async function hardReset(cwd: string, signal?: AbortSignal): Promise<void> {
	const api = getApi();
	if (!api) return;
	await api.exec("git", ["reset", "--hard", "HEAD"], { cwd, signal, timeout: DAG_GIT_TIMEOUT_MS });
	await api.exec("git", ["clean", "-fd"], { cwd, signal, timeout: DAG_GIT_TIMEOUT_MS });
}
