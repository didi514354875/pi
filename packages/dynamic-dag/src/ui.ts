/**
 * Statusline and widget rendering.
 *
 * `updateStatus` is called after every state mutation via the `setState` seam.
 * Statusline works in all modes; the widget is guarded by `ctx.hasUI`.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countTasks, finishedCount } from "./engine.ts";
import type { DagState, TaskNode } from "./types.ts";
import { STATUS_ICON } from "./types.ts";

const COMPLETION_DISPLAY_MS = 8000;

/** Refresh the statusline (and widget when UI is available). */
export async function updateStatus(ctx: ExtensionContext): Promise<void> {
	const state = currentDagState();
	if (!state) {
		ctx.ui.setStatus("dynamic-dag", undefined);
		if (ctx.hasUI) ctx.ui.setWidget("dynamic-dag", undefined);
		return;
	}

	const total = countTasks(state);
	const done = finishedCount(state);
	const current = state.currentTaskId ? state.tasks[state.currentTaskId] : undefined;

	if (current) {
		const budget = current.budgetRemaining !== null ? ` [预算:${current.budgetRemaining}]` : "";
		const paused = state.paused ? " ⏸" : "";
		ctx.ui.setStatus("dynamic-dag", `dag ${done}/${total} · ${current.id} ${current.status}${budget}${paused}`);
	} else {
		const allDone = done >= total;
		if (allDone) {
			ctx.ui.setStatus("dynamic-dag", "dag complete");
			if (ctx.hasUI) ctx.ui.setWidget("dynamic-dag", undefined);
			setTimeout(() => {
				ctx.ui.setStatus("dynamic-dag", undefined);
			}, COMPLETION_DISPLAY_MS);
			return;
		}
		const paused = state.paused ? " ⏸" : "";
		ctx.ui.setStatus("dynamic-dag", `dag ${done}/${total}${paused}`);
	}

	if (ctx.hasUI) {
		ctx.ui.setWidget("dynamic-dag", renderTree(state));
	}
}

/** Render root tasks + one level of expanded current branch. */
function renderTree(state: DagState): string[] {
	const lines: string[] = [];
	const current = state.currentTaskId ? state.tasks[state.currentTaskId] : undefined;

	for (const rootId of state.rootTaskIds) {
		const task = state.tasks[rootId];
		if (!task) continue;
		const icon = STATUS_ICON[task.status];
		const budget = task.budgetRemaining !== null ? ` [${task.budgetRemaining}]` : "";
		lines.push(`${icon} ${task.title}${budget}`);

		const shouldExpandChildren = current && (task.id === current.id || isAncestorOf(state, task.id, current.id));

		if (shouldExpandChildren) {
			const children = Object.values(state.tasks).filter((t) => t.parentId === task.id);
			for (const child of children) {
				const childIcon = STATUS_ICON[child.status];
				const childBudget = child.budgetRemaining !== null ? ` [${child.budgetRemaining}]` : "";
				lines.push(`  ${childIcon} ${child.title}${childBudget}`);
			}
		}
	}

	return lines;
}

/** Is `ancestorId` a transitive parent of `descendantId`? */
function isAncestorOf(state: DagState, ancestorId: string, descendantId: string): boolean {
	let node: TaskNode | undefined = state.tasks[descendantId];
	while (node?.parentId) {
		if (node.parentId === ancestorId) return true;
		node = state.tasks[node.parentId];
	}
	return false;
}

// Import cycle seam: set by index.ts after state module is wired.
let currentDagState: () => DagState | undefined = () => undefined;

export function setDagStateGetter(fn: () => DagState | undefined): void {
	currentDagState = fn;
}
