/**
 * Event hook registrations.
 *
 * - session_start:      restore DAG state from the session branch.
 * - session_shutdown:   clear in-memory state.
 * - before_agent_start: inject the 3-tier DAG system prompt (context isolation).
 * - tool_call:          enforce Spike read-only mode, budget tracking, boundary enforcement.
 * - agent_end:          pause the task if the agent stopped on error/abort.
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
		if (!state?.currentTaskId) return event;
		const task = state.tasks[state.currentTaskId];
		if (!task) return event;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildDagSystemPrompt(state, task)}`,
		};
	});

	/**
	 * Tool-call interceptor:
	 * - Budget exhaustion: block all tools except submit_task_result / spike_submit.
	 * - Spike read-only mode: block edit/write/create/delete tools.
	 * - Boundary enforcement: block file writes outside the task's boundary glob.
	 */
	pi.on("tool_call", async (event, ctx) => {
		const state = getState();
		if (!state?.currentTaskId) return;
		const task = state.tasks[state.currentTaskId];
		if (!task) return;

		// Budget consumption: block if exhausted
		if (task.budgetRemaining !== null && task.budgetRemaining <= 0) {
			// Only submit_task_result and spike_submit are allowed with zero budget
			const allowedZeroBudget = new Set(["submit_task_result", "spike_submit"]);
			if (!allowedZeroBudget.has(event.toolName)) {
				return {
					block: true,
					reason: "工具调用预算已耗尽。只能调用 submit_task_result 或 spike_submit。",
				};
			}
		}

		// Spike read-only enforcement: block edit/write tools
		const writeToolPatterns = [/^(write|edit|create|delete|remove|move|rename|replace|modify|update)/i];
		if (task.kind === "spike") {
			for (const pattern of writeToolPatterns) {
				if (pattern.test(event.toolName)) {
					return {
						block: true,
						reason: "Spike 探索任务处于只读模式。禁止调用写入工具。",
					};
				}
			}
		}

		// Boundary enforcement for file writes
		if (task.boundary && task.boundary.trim().length > 0) {
			const writeTools = new Set(["write", "edit", "create_file", "replace_in_file"]);
			if (writeTools.has(event.toolName)) {
				const input = event.input as { path?: string; file_path?: string; target?: string };
				const rawPath = input.file_path ?? input.path ?? input.target;
				if (rawPath && typeof rawPath === "string") {
					const absPath = resolve(ctx.cwd, rawPath);
					const relPath = relative(ctx.cwd, absPath).split(sep).join("/");
					if (!relPath.startsWith("..") && !isPathInBoundary(relPath, task.boundary)) {
						return {
							block: true,
							reason: `路径 "${rawPath}" 不在任务边界内 (边界: ${task.boundary})。`,
						};
					}
				}
			}
		}
	});

	/**
	 * If the agent stopped due to error/abort without calling a terminal tool,
	 * pause the task and notify the user.
	 */
	pi.on("agent_end", async (event, ctx) => {
		const state = getState();
		if (!state?.currentTaskId) return;
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;

		const task = state.tasks[state.currentTaskId];
		if (!task) return;

		// Only care about mid-execution tasks
		const midExecutionStates = new Set(["RUNNING", "SPIKING", "DECOMPOSING", "ESTIMATING"]);
		if (!midExecutionStates.has(task.status)) return;

		// If the agent stopped due to error/abort, pause the task
		const lastAssistant = findLastAssistantMessage(event.messages);
		if (lastAssistant && (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error")) {
			const tasks = { ...state.tasks };
			tasks[task.id] = {
				...task,
				status:
					task.status === "RUNNING" || task.status === "ESTIMATING" || task.status === "SPIKING"
						? ("BLOCKED" as const)
						: task.status,
			};
			setState({ ...state, tasks, currentTaskId: null, paused: true }, ctx);
			ctx.ui.notify(`任务 "${task.title}" 在未提交结果的情况下停止。已暂停。使用 /dag resume 恢复。`, "warning");
		}
	});
}

function findLastAssistantMessage(messages: { role: string }[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as AssistantMessage;
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}
