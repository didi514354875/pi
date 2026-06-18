/**
 * Persistence helpers — read/write DagState to/from session custom entries.
 *
 * Uses `appendEntry` (writes a CustomEntry, never sent to LLM) and restores
 * from `sessionManager.getBranch()` on session_start. Exact pattern from the
 * canonical tools extension.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DAG_STATE_ENTRY_TYPE, type DagState, isTaskActive } from "./types.ts";

/**
 * Restore the latest DAG state from the session branch, if any incomplete one exists.
 * Only restores states that have at least one active (unfinished) task.
 */
export function restoreFromBranch(ctx: ExtensionContext): DagState | undefined {
	const branch = ctx.sessionManager.getBranch();
	let restored: DagState | undefined;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === DAG_STATE_ENTRY_TYPE) {
			const data = entry.data as DagState | undefined;
			if (data && typeof data === "object" && "tasks" in data) {
				restored = data;
			}
		}
	}
	if (!restored) return undefined;
	if (!hasActiveWork(restored)) return undefined;
	return restored;
}

function hasActiveWork(state: DagState): boolean {
	for (const task of Object.values(state.tasks)) {
		if (isTaskActive(task.status)) return true;
	}
	return false;
}
