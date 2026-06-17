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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

	// Spike read-only enforcement: hard-block edit/write during a Spike probe.
	// bash is intentionally NOT blocked (cannot deterministically classify
	// read vs. write); the prompt redline covers it.
	pi.on("tool_call", async (event, _ctx) => {
		const state = getState();
		if (!state || !state.currentTaskId) return;
		const task = state.tasks[state.currentTaskId];
		if (!task || task.kind !== "spike") return;
		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason:
					"Spike 任务为只读模式，禁止 edit/write。请使用 read/search 等只读工具完成探索，完成后调用 submit_spike_result 输出客观事实。",
			};
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const state = getState();
		if (!state || !state.currentTaskId) return;
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;

		const task = state.tasks[state.currentTaskId];
		if (!task || task.status !== "IN_PROGRESS") return;

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
