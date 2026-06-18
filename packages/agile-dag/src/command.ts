/**
 * /dag command handler (v3.1).
 *
 * Subcommands:
 *   /dag <plan text>   — ingest a plan and start the DAG.
 *   /dag --file <path> — ingest a plan from a file.
 *   /dag status        — show task tree summary.
 *   /dag pause         — pause the current task.
 *   /dag resume        — resume the current task (re-runs VERIFYING pipeline).
 *   /dag clear         — clear all DAG state.
 *   /dag hello-world   — say hello.
 *   /dag               — interactive menu.
 */
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeTaskSuccess, ingestPlan, isTaskUnblocked, pushNextToAssess, startTask } from "./engine.ts";
import { commitAll, hardReset } from "./git.ts";
import { parsePlanInput } from "./parser.ts";
import { buildFirstTaskPrompt, buildNextTaskPrompt, buildResumePrompt } from "./prompt.ts";
import { clearState, getState, setState } from "./state.ts";
import type { DagState, TaskKind, TaskNode } from "./types.ts";
import { STATUS_ICON } from "./types.ts";
import { runVerification } from "./verify.ts";

/** Compact inline badge for a task's kind (empty for standard tasks). */
function kindBadge(kind: TaskKind): string {
	switch (kind) {
		case "spike":
			return " [Spike]";
		case "contract":
			return " [Contract]";
		default:
			return "";
	}
}

/** Register the /dag command. */
export function registerDagCommand(pi: ExtensionAPI): void {
	pi.registerCommand("dag", {
		description: "Agile-DAG 计划管理: 状态、暂停、恢复、清除、导入计划",
		async handler(args, ctx) {
			await handleDag(args, ctx, pi);
		},
	});
}

async function handleDag(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const trimmed = args.trim();

	if (trimmed.length === 0) {
		await showMenu(ctx, pi);
		return;
	}

	if (trimmed === "status") {
		showStatus(ctx);
		return;
	}

	if (trimmed === "pause") {
		pauseCurrent(ctx);
		return;
	}

	if (trimmed === "resume") {
		await resumeCurrent(ctx, pi);
		return;
	}

	if (trimmed === "hello-world") {
		await showHelloWorld(ctx);
		return;
	}

	if (trimmed === "clear") {
		clearState(ctx);
		ctx.ui.notify("DAG 状态已清除。", "info");
		return;
	}

	if (trimmed.startsWith("--file ")) {
		const filePath = trimmed.slice("--file ".length).trim();
		await ingestFromFile(filePath, ctx, pi);
		return;
	}

	// Treat everything else as plan text.
	await ingestFromText(trimmed, ctx, pi);
}

async function ingestFromText(text: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const parsed = parsePlanInput(text);
	if (parsed.length === 0) {
		ctx.ui.notify("无法解析计划输入。请提供任务描述或 Plan: 开头的列表。", "error");
		return;
	}

	if (!(await confirmReplaceIfActive(ctx))) return;

	const state = ingestPlan(null, parsed);
	setState(state, ctx);

	const firstTask = state.currentTaskId ? state.tasks[state.currentTaskId] : undefined;
	if (firstTask) {
		ctx.ui.notify(`已创建 ${parsed.length} 个任务。DAG 模式已激活。`, "info");
		pi.sendUserMessage(buildFirstTaskPrompt(firstTask));
	}
}

async function ingestFromFile(filePath: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	let content: string;
	try {
		content = await readFile(filePath, "utf-8");
	} catch {
		ctx.ui.notify(`无法读取文件: ${filePath}`, "error");
		return;
	}
	await ingestFromText(content, ctx, pi);
}

async function confirmReplaceIfActive(ctx: ExtensionCommandContext): Promise<boolean> {
	const existing = getState();
	if (!existing) return true;
	return ctx.ui.confirm("替换当前 DAG？", "已有一个活跃的 DAG。导入新计划将替换它。");
}
function showStatus(ctx: ExtensionCommandContext): void {
	const state = getState();
	if (!state) {
		ctx.ui.notify("没有活跃的 DAG。用 /dag <plan> 创建。", "info");
		return;
	}

	const lines: string[] = [];
	for (const rootId of state.rootTaskIds) {
		renderTaskTree(state, rootId, 0, lines);
	}
	// Fact statistics.
	if (state.facts.length > 0) {
		const valid = state.facts.filter((f) => f.status === "VALID").length;
		const expired = state.facts.filter((f) => f.status === "EXPIRED").length;
		const conflict = state.facts.filter((f) => f.status === "CONFLICT").length;
		lines.push(`\nFacts: ${state.facts.length} (valid: ${valid}, expired: ${expired}, conflict: ${conflict})`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function renderTaskTree(state: DagState, taskId: string, depth: number, lines: string[]): void {
	const task = state.tasks[taskId];
	if (!task) return;
	const indent = "  ".repeat(depth);
	const icon = STATUS_ICON[task.status];
	const badge = kindBadge(task.kind);
	const complexity = task.complexity > 0 ? ` (c:${task.complexity}` : "";
	const riskConf = complexity ? `/r:${task.risk}/conf:${task.confidence})` : "";
	const retries = task.retryCount > 0 ? ` #${task.retryCount}` : "";
	const boundary = task.boundary ? ` [b:${task.boundary}]` : "";
	const marker = taskId === state.currentTaskId ? " ◄" : "";
	lines.push(`${indent}${icon}${badge} ${task.title}${complexity}${riskConf}${retries}${boundary}${marker}`);
	const children = Object.values(state.tasks)
		.filter((t) => t.parentId === taskId)
		.sort((a, b) => a.id.localeCompare(b.id));
	for (const child of children) renderTaskTree(state, child.id, depth + 1, lines);
}

function pauseCurrent(ctx: ExtensionCommandContext): void {
	const state = getState();
	if (!state || !state.currentTaskId) {
		ctx.ui.notify("没有正在执行的任务。", "warning");
		return;
	}
	const task = state.tasks[state.currentTaskId];
	if (!task) return;

	if (task.status === "RUNNING" || task.status === "VERIFYING") {
		const newState: DagState = {
			...state,
			tasks: { ...state.tasks, [task.id]: { ...task, status: "READY" as const } },
			currentTaskId: null,
		};
		setState(newState, ctx);
		ctx.ui.notify(`已暂停任务: ${task.title}`, "info");
		return;
	}

	if (task.status === "CREATED") {
		// Un-assess: drop currentTaskId so the task re-enters the queue.
		const newState: DagState = { ...state, currentTaskId: null };
		setState(newState, ctx);
		ctx.ui.notify(`已暂停任务: ${task.title}`, "info");
		return;
	}

	ctx.ui.notify(`任务 ${task.id} 状态为 ${task.status}，无法暂停。`, "warning");
}
async function resumeCurrent(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const state = getState();
	if (!state) {
		ctx.ui.notify("没有活跃的 DAG。", "warning");
		return;
	}
	if (state.currentTaskId) {
		ctx.ui.notify("已有正在进行的任务。", "info");
		return;
	}

	// First priority: a task stuck in VERIFYING — re-run the verify pipeline.
	const verifying = Object.values(state.tasks).find((t) => t.status === "VERIFYING");
	if (verifying) {
		await resumeVerifyingTask(ctx, pi, verifying);
		return;
	}

	// Second priority: a READY task (paused from RUNNING/VERIFYING) — restart it.
	for (const task of Object.values(state.tasks)) {
		if (task.status === "READY" && isTaskUnblocked(state, task.id)) {
			const newState = startTask(state, task.id);
			setState(newState, ctx);
			pi.sendUserMessage(buildResumePrompt(task));
			ctx.ui.notify("已恢复任务执行。", "info");
			return;
		}
	}

	// Third priority: push the next available CREATED task to assessment.
	const assessed = pushNextToAssess(state);
	if (assessed.currentTaskId) {
		setState(assessed, ctx);
		const nextTask = assessed.tasks[assessed.currentTaskId];
		pi.sendUserMessage(buildNextTaskPrompt(nextTask));
		ctx.ui.notify("已恢复 DAG 执行。", "info");
		return;
	}

	ctx.ui.notify("没有可恢复的任务。所有任务已完成或处于终态。", "warning");
}

/**
 * Resume a task left in VERIFYING (e.g. pi was interrupted mid-verify): re-run
 * the verification pipeline and branch on pass/fail exactly like submit_task_result.
 */
async function resumeVerifyingTask(ctx: ExtensionCommandContext, pi: ExtensionAPI, task: TaskNode): Promise<void> {
	const verifyResult = await runVerification(ctx.cwd, ctx.signal);
	const state = getState();
	if (!state) return;

	if (verifyResult.passed) {
		const committed = await commitAll(ctx.cwd, `feat(dag): ${task.id} ${task.title.slice(0, 60)}`, ctx.signal);
		if (!committed) {
			await hardReset(ctx.cwd, ctx.signal);
			ctx.ui.notify(`任务 ${task.id} 验证后 Git 提交失败，已回滚。请检查后重试。`, "warning");
			return;
		}
		// Use the engine's success transition (handles fact invalidation, context
		// propagation, parent resolution, and next-task selection).
		const { state: successState, nextTaskId, isComplete } = completeTaskSuccess(state, task.id, []);
		setState(successState, ctx);
		if (isComplete) {
			ctx.ui.notify(`任务 ${task.id} 验证通过并已提交。全部任务完成。`, "info");
			return;
		}
		if (nextTaskId && successState.tasks[nextTaskId]) {
			const nextTask = successState.tasks[nextTaskId];
			if (nextTask.status === "RUNNING") {
				pi.sendUserMessage(buildNextTaskPrompt(nextTask));
			} else {
				// Next task is READY (startTask not called — dirty workspace).
				pi.sendUserMessage(buildResumePrompt(nextTask));
			}
			ctx.ui.notify(`任务 ${task.id} 验证通过并已提交。`, "info");
			return;
		}
		ctx.ui.notify(`任务 ${task.id} 验证通过并已提交。`, "info");
		return;
	}

	await hardReset(ctx.cwd, ctx.signal);
	ctx.ui.notify(
		`任务 ${task.id} 验证失败，已回滚: ${verifyResult.output}。请用 submit_task_result 重试或调整。`,
		"warning",
	);
}

async function showHelloWorld(ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify("Hello, World! Agile-DAG v3.1.0 — 状态卸载 + Git 事务 + 验证流水线。", "info");
}

async function showMenu(ctx: ExtensionCommandContext, _pi: ExtensionAPI): Promise<void> {
	const state = getState();
	if (!state) {
		ctx.ui.notify("没有活跃的 DAG。用 /dag <plan> 创建计划。", "info");
		return;
	}

	const choice = await ctx.ui.select("Agile-DAG", ["status", "pause", "resume", "clear", "cancel"]);
	if (!choice || choice === "cancel") return;

	if (choice === "status") showStatus(ctx);
	else if (choice === "pause") pauseCurrent(ctx);
	else if (choice === "resume") await resumeCurrent(ctx, _pi);
	else if (choice === "clear") {
		clearState(ctx);
		ctx.ui.notify("DAG 状态已清除。", "info");
	}
}
