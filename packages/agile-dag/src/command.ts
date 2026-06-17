/**
 * /dag command handler.
 *
 * Subcommands:
 *   /dag <plan text>   — ingest a plan and start the DAG.
 *   /dag --file <path> — ingest a plan from a file.
 *   /dag status        — show task tree summary.
 *   /dag pause         — pause the current task.
 *   /dag resume        — resume the current task.
 *   /dag clear         — clear all DAG state.
 *   /dag hello-world   — say hello.
 *   /dag               — interactive menu.
 */
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ingestPlan, isTaskUnblocked, pushNextToEstimate, startExecution } from "./engine.ts";
import { parsePlanInput } from "./parser.ts";
import { buildFirstTaskPrompt, buildNextTaskPrompt, buildResumePrompt } from "./prompt.ts";
import { clearState, getState, setState } from "./state.ts";
import type { DagState, TaskKind } from "./types.ts";

const STATUS_ICON: Record<string, string> = {
	TODO: "□",
	ESTIMATING: "✎",
	READY: "○",
	BLOCKED: "◂",
	IN_PROGRESS: "►",
	DONE: "✓",
	FAILED: "✕",
};

/** Compact inline badge for a task's kind (empty for standard tasks). */
function kindBadge(kind: TaskKind): string {
	switch (kind) {
		case "spike":
			return " [Spike]";
		case "contract":
			return " [Contract]";
		case "bugfix":
			return " [BugFix]";
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
		resumeCurrent(ctx, pi);
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
	ctx.ui.notify(lines.join("\n"), "info");
}

function renderTaskTree(state: DagState, taskId: string, depth: number, lines: string[]): void {
	const task = state.tasks[taskId];
	if (!task) return;
	const indent = "  ".repeat(depth);
	const icon = STATUS_ICON[task.status];
	const badge = kindBadge(task.kind);
	const points = task.storyPoints ? ` (${task.storyPoints}pt)` : "";
	const boundary = task.boundary ? ` [b:${task.boundary}]` : "";
	const marker = taskId === state.currentTaskId ? " ◄" : "";
	lines.push(`${indent}${icon}${badge} ${task.title}${points}${boundary}${marker}`);
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

	if (task.status === "IN_PROGRESS") {
		const newState: DagState = {
			...state,
			tasks: { ...state.tasks, [task.id]: { ...task, status: "READY" as const } },
			currentTaskId: null,
		};
		setState(newState, ctx);
		ctx.ui.notify(`已暂停任务: ${task.title}`, "info");
		return;
	}

	if (task.status === "ESTIMATING") {
		const newState: DagState = {
			...state,
			tasks: { ...state.tasks, [task.id]: { ...task, status: "TODO" as const } },
			currentTaskId: null,
		};
		setState(newState, ctx);
		ctx.ui.notify(`已暂停任务: ${task.title}`, "info");
		return;
	}

	ctx.ui.notify(`任务 ${task.id} 状态为 ${task.status}，无法暂停。`, "warning");
}
function resumeCurrent(ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	const state = getState();
	if (!state) {
		ctx.ui.notify("没有活跃的 DAG。", "warning");
		return;
	}
	if (state.currentTaskId) {
		ctx.ui.notify("已有正在进行的任务。", "info");
		return;
	}

	// First priority: find a READY task (paused from IN_PROGRESS) and restart it.
	for (const task of Object.values(state.tasks)) {
		if (task.status === "READY" && isTaskUnblocked(state, task.id)) {
			const newState = startExecution(state, task.id);
			setState(newState, ctx);
			pi.sendUserMessage(buildResumePrompt(task));
			ctx.ui.notify("已恢复任务执行。", "info");
			return;
		}
	}

	// Second priority: push the next available TODO task to ESTIMATING
	// (handles ESTIMATING→TODO paused tasks from pauseCurrent).
	const estimated = pushNextToEstimate(state);
	if (estimated.currentTaskId) {
		setState(estimated, ctx);
		const nextTask = estimated.tasks[estimated.currentTaskId];
		pi.sendUserMessage(buildNextTaskPrompt(nextTask));
		ctx.ui.notify("已恢复 DAG 执行。", "info");
		return;
	}

	ctx.ui.notify("没有可恢复的任务。所有任务已完成或处于终态。", "warning");
}
async function showHelloWorld(ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify("Hello, World! Agile-DAG v0.79.1 — 多智能体 DAG 任务调度引擎。", "info");
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
	else if (choice === "resume") resumeCurrent(ctx, _pi);
	else if (choice === "clear") {
		clearState(ctx);
		ctx.ui.notify("DAG 状态已清除。", "info");
	}
}
