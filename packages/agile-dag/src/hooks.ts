/**
 * Event hook registrations.
 *
 * - session_start:      restore DAG state from the session branch.
 * - session_shutdown:   state is persisted on every mutation; clear in-memory state.
 * - before_agent_start: inject the 3-tier DAG system prompt (context isolation).
 * - tool_call:          enforce Spike read-only mode by blocking edit/write.
 * - agent_end:          pause the task if the agent stopped on error/abort.
 *
 * The engine advances only via submit_task_result / submit_spike_result. There
 * is no continuation re-push: if the agent yields early without submitting, the
 * user can recover with /dag resume.
 */

import { relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPathInBoundary } from "./boundary.ts";
import { restoreFromBranch } from "./persist.ts";
import { buildDagSystemPrompt } from "./prompt.ts";
import { getState, setState } from "./state.ts";

/** Register all DAG event hooks. */
export function registerDagHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const restored = restoreFromBranch(ctx);
		setState(restored, ctx);
	});

	pi.on("session_shutdown", async () => {
		setState(undefined);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const state = getState();
		if (!state || !state.currentTaskId) return event;

		const task = state.tasks[state.currentTaskId];
		if (!task) return event;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildDagSystemPrompt(state, task)}`,
		};
	});

	/**
	 * Tool-call interceptor (v3.2):
	 *
	 * 1. Spike tasks → hard-block edit/write (read-only mode).
	 * 2. RUNNING standard/contract tasks → block edit/write whose target path
	 *    falls outside the task's `boundary` glob.
	 *
	 * bash is intentionally NOT blocked (cannot deterministically classify
	 * read vs. write); the prompt redline covers this gap.
	 */
	pi.on("tool_call", async (event, ctx) => {
		const state = getState();
		if (!state || !state.currentTaskId) return;
		const task = state.tasks[state.currentTaskId];
		if (!task) return;

		// --- 1. Spike read-only enforcement (v3.1) ---
		if (task.kind === "spike" && (event.toolName === "edit" || event.toolName === "write")) {
			return {
				block: true,
				reason:
					"Spike 任务为只读模式，禁止 edit/write。请使用 read/search 等只读工具完成探索，完成后调用 submit_spike_result 输出客观事实。",
			};
		}

		// --- 2. Boundary hard-block (v3.2) — only for RUNNING non-spike tasks ---
		if (task.status !== "RUNNING") return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		// tasks without a boundary are unrestricted (boundary="" or empty).
		if (!task.boundary || task.boundary.trim().length === 0) return;

		const input = event.input as { path?: string; file_path?: string };
		const rawPath = input.path ?? input.file_path;
		if (!rawPath) return;

		// Normalise to a relative posix path (picomatch expects posix separators).
		const absPath = resolve(ctx.cwd, rawPath);
		const relPath = relative(ctx.cwd, absPath).split(sep).join("/");

		if (!isPathInBoundary(relPath, task.boundary)) {
			return {
				block: true,
				reason:
					`越界：${rawPath} 不在任务边界内（允许：${task.boundary || "无限制"}）。` +
					"若需扩大范围，请先 submit_task_result(FAILED_NEED_SPIKE) 或重新拆解。",
			};
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const state = getState();
		if (!state || !state.currentTaskId) return;
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;

		const task = state.tasks[state.currentTaskId];
		if (!task || task.status !== "RUNNING") return;

		// If the agent stopped due to error/abort, pause the task rather than
		// looping on a broken turn. The user can /dag resume to retry.
		const lastAssistant = findLastAssistantMessage(event.messages);
		if (lastAssistant && (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error")) {
			const paused: typeof state = {
				...state,
				tasks: { ...state.tasks, [task.id]: { ...task, status: "READY" as const } },
				currentTaskId: null,
			};
			setState(paused, ctx);
			ctx.ui.notify(`任务因 ${lastAssistant.stopReason} 暂停: ${task.title}`, "warning");
			return;
		}

		// No continuation re-push: the engine advances only on submit_*.
	});
}

function findLastAssistantMessage(messages: { role: string }[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			return messages[i] as AssistantMessage;
		}
	}
	return undefined;
}
