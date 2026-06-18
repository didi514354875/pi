/**
 * Persistence helpers — read/write DagState to/from session custom entries.
 *
 * Uses `appendEntry` (writes a CustomEntry, never sent to LLM) and restores
 * from `sessionManager.getBranch()` on session_start. Exact pattern from the
 * canonical tools extension.
 *
 * v3.1: sessions persisted before the rewrite (tasks carrying `storyPoints`
 * and the old status values TODO/ESTIMATING/IN_PROGRESS) cannot be migrated
 * losslessly, so they are discarded — the user starts a fresh DAG.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeState } from "./engine.ts";
import { DAG_STATE_ENTRY_TYPE, type DagState, isTaskActive } from "./types.ts";

/** A task shape that may carry legacy v3.0 fields (storyPoints/fixDepth). */
type LegacyTaskNode = Partial<Record<"storyPoints" | "fixDepth" | "complexity" | "retryCount", unknown>>;

/** A facts shape that may carry the legacy v3.1 `Record<string,string>` form. */
type LegacyFacts = Record<string, unknown>;

/** Restore the latest DAG state from the session branch, if any incomplete one exists. */
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
	if (isLegacyFormat(restored)) return undefined;
	if (hasActiveWork(restored)) {
		return normalizeState(restored);
	}
	return undefined;
}

/**
 * Is this a pre-v3.2 state? Detected by:
 *  - any task carrying `storyPoints` without `complexity` (v3.0), or a retired status.
 *  - `facts` being a `Record<string,string>` (object, not array) — the v3.1 blackboard.
 *  - any fact array element missing the v3.2 `id`/`status`/`evidencePaths` fields.
 *
 * v3.1 Record-facts and partial fact elements cannot be migrated losslessly
 * (Record entries carry no provenance/confidence), so they are discarded.
 */
function isLegacyFormat(state: DagState): boolean {
	const retiredStatuses = new Set(["TODO", "ESTIMATING", "IN_PROGRESS"]);
	for (const task of Object.values(state.tasks as Record<string, LegacyTaskNode & { status?: unknown }>)) {
		if (task.storyPoints !== undefined && task.complexity === undefined) return true;
		if (typeof task.status === "string" && retiredStatuses.has(task.status)) return true;
	}
	// v3.2 facts must be a Fact[]. A plain object is the v3.1 Record<string,string>.
	const facts = state.facts as unknown;
	if (!Array.isArray(facts)) {
		// Object (non-array) facts → legacy v3.1 Record form. Empty object {} is still legacy shape.
		if (facts !== undefined && typeof facts === "object") return true;
		return true; // undefined / null / other — treat as legacy (unrecoverable).
	}
	for (const f of facts as LegacyFacts[]) {
		if (typeof f.id !== "string") return true;
		if (typeof f.status !== "string") return true;
		if (!Array.isArray(f.evidencePaths)) return true;
	}
	return false;
}

function hasActiveWork(state: DagState): boolean {
	for (const task of Object.values(state.tasks)) {
		if (isTaskActive(task.status)) return true;
	}
	return false;
}
