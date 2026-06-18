/**
 * /dag command handler.
 *
 * Subcommands: plan, status, pause, resume, clear.
 */
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeTaskSuccess, ingestPlan, pushNextToEstimate, recommendNextTask, startTask } from "./engine.ts";
import { commitAll, hardReset } from "./git.ts";
import { parsePlanInput } from "./parser.ts";
import { buildFirstTaskPrompt, buildResumePrompt } from "./prompt.ts";
import { clearState, getState, setState } from "./state.ts";
import type { DagState, TaskNode } from "./types.ts";
import { STATUS_ICON } from "./types.ts";
import { runVerification } from "./verify.ts";

/** Compact inline badge for a task's kind. */
function kindBadge(task: TaskNode): string {
	if (task.kind === "spike") return " [探索]";
	if (task.kind === "decompose") return " [拆解]";
	return "";
}

/** Register the /dag command. */
export function registerDagCommand(pi: ExtensionAPI): void {
	pi.registerCommand("dag", {
		description: "Dynamic-DAG 规划与执行管理",
		async handler(args, ctx) {
			await handleDag(args, ctx);
		},
	});
}

async function handleDag(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();

	if (!trimmed || trimmed === "status") {
		showStatus(ctx);
		return;
	}

	if (trimmed === "pause") {
		pauseCurrent(ctx);
		return;
	}

	if (trimmed === "resume") {
		await resumeCurrent(ctx);
		return;
	}

	if (trimmed === "clear") {
		const state = getState();
		if (state && Object.keys(state.tasks).length > 0) {
			const confirmed = await confirmReplaceIfActive(ctx);
			if (!confirmed) return;
		}
		clearState(ctx);
		ctx.ui.notify("DAG 已清除。", "info");
		return;
	}

	if (trimmed === "menu") {
		await showMenu(ctx);
		return;
	}

	// Check for --file or -f
	const fileMatch = /^\s*(?:-f|--file)\s+(.+)/.exec(trimmed);
	if (fileMatch) {
		await ingestFromFile(fileMatch[1].trim(), ctx);
		return;
	}

	// Default: ingest plan text
	if (trimmed.startsWith("plan ")) {
		await ingestFromText(trimmed.slice(5).trim(), ctx);
		return;
	}

	// Assume it's a plan text
	await ingestFromText(trimmed, ctx);
}

async function ingestFromText(text: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parsePlanInput(text);
	if (parsed.length === 0) {
		ctx.ui.notify("无法解析计划输入。请使用 `/dag plan <描述>` 或 `/dag --file <路径>`。", "error");
		return;
	}

	const state = getState();

	// Check for existing active work
	if (
		state &&
		Object.keys(state.tasks).some((id) => state.tasks[id].status !== "DONE" && state.tasks[id].status !== "FAILED")
	) {
		const confirmed = await confirmReplaceIfActive(ctx);
		if (!confirmed) return;
	}

	const ingested = ingestPlan(null, parsed);

	// Check for an init spike (READY, kind=spike) — start it directly, no assessment needed
	const initSpike = Object.values(ingested.tasks).find((t) => t.kind === "spike" && t.spikeForTaskId === null);

	let finalState: typeof ingested;
	if (initSpike && initSpike.status === "READY") {
		// Start the init spike directly
		finalState = startTask(ingested, initSpike.id);
		setState(finalState, ctx);
	} else {
		// No init spike — push first user task to ESTIMATING for assessment
		const pushed = pushNextToEstimate(ingested);
		if (pushed.currentTaskId) {
			finalState = startTask(pushed, pushed.currentTaskId);
			setState(finalState, ctx);
		} else {
			setState(ingested, ctx);
		}
	}

	showStatus(ctx);
}

async function ingestFromFile(filePath: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const text = await readFile(filePath, "utf-8");
		await ingestFromText(text, ctx);
	} catch (err) {
		ctx.ui.notify(`无法读取文件 "${filePath}": ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function confirmReplaceIfActive(ctx: ExtensionCommandContext): Promise<boolean> {
	// In command context, we just proceed (interactive confirmation not available via commands)
	ctx.ui.notify("已有活动的 DAG 状态。新计划将替换现有状态。", "warning");
	return true;
}

function showStatus(ctx: ExtensionCommandContext): void {
	const state = getState();
	if (!state || Object.keys(state.tasks).length === 0) {
		ctx.ui.notify("没有活动的 DAG。使用 `/dag plan <描述>` 创建。", "info");
		return;
	}

	const total = Object.keys(state.tasks).length;
	const done = Object.values(state.tasks).filter((t) => t.status === "DONE" || t.status === "FAILED").length;
	const lines: string[] = [];

	lines.push(`动态 DAG 状态: ${done}/${total} 完成`);
	if (state.paused) lines.push("⚡ DAG 已暂停");
	lines.push("");

	// Render task tree
	for (const rootId of state.rootTaskIds) {
		renderTaskTree(state, rootId, 0, lines);
	}

	// Show facts count
	if (state.facts.length > 0) {
		lines.push("");
		lines.push(`全局事实: ${state.facts.length} 条`);
	}

	// Show ADRs
	if (state.adrs.length > 0) {
		lines.push(`架构决策: ${state.adrs.length} 条`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

function renderTaskTree(state: DagState, taskId: string, depth: number, lines: string[]): void {
	const task = state.tasks[taskId];
	if (!task) return;

	const indent = "  ".repeat(depth);
	const icon = STATUS_ICON[task.status];
	const badge = kindBadge(task);
	const budget = task.budgetRemaining !== null ? ` [预算:${task.budgetRemaining}]` : "";

	lines.push(`${indent}${icon} ${task.title}${badge}${budget}`);

	// Show children
	const children = Object.values(state.tasks).filter((t) => t.parentId === taskId);
	for (const child of children) {
		renderTaskTree(state, child.id, depth + 1, lines);
	}
}

function pauseCurrent(ctx: ExtensionCommandContext): void {
	const state = getState();
	if (!state?.currentTaskId) {
		ctx.ui.notify("没有正在执行的任务。", "warning");
		return;
	}

	const tasks = { ...state.tasks };
	const task = tasks[state.currentTaskId];
	if (task && task.status !== "DONE" && task.status !== "FAILED") {
		tasks[state.currentTaskId] = { ...task, status: "BLOCKED" as const };
	}

	setState({ ...state, tasks, currentTaskId: null, paused: true }, ctx);
	ctx.ui.notify(`已暂停任务 "${task?.title ?? state.currentTaskId}"。使用 /dag resume 恢复。`, "info");
}

async function resumeCurrent(ctx: ExtensionCommandContext): Promise<void> {
	const state = getState();
	if (!state) {
		ctx.ui.notify("没有活动的 DAG。", "warning");
		return;
	}

	// Check for paused task

	if (state.currentTaskId) {
		const task = state.tasks[state.currentTaskId];
		if (task?.status === "VERIFYING") {
			await resumeVerifyingTask(ctx, task);
			return;
		}
	}

	// Try to start next ready task
	const nextId = recommendNextTask(getState()!);
	if (nextId) {
		const started = startTask(getState()!, nextId);
		setState(started, ctx);
		ctx.ui.notify(buildResumePrompt(started.tasks[nextId]), "info");
		return;
	}

	// Push next CREATED to ESTIMATING
	const unpaused = { ...getState()!, paused: false };
	setState(unpaused, ctx);
	const pushed = pushNextToEstimate(unpaused);
	setState(pushed, ctx);

	if (pushed.currentTaskId) {
		const task = pushed.tasks[pushed.currentTaskId];
		const started = startTask(getState()!, pushed.currentTaskId);
		setState(started, ctx);
		ctx.ui.notify(buildFirstTaskPrompt(task), "info");
		return;
	}

	ctx.ui.notify("没有可恢复的任务。所有任务已完成。", "info");
}

async function resumeVerifyingTask(ctx: ExtensionCommandContext, task: TaskNode): Promise<void> {
	ctx.ui.notify(`恢复验证任务: ${task.title}`, "info");

	const verifyResult = await runVerification(ctx.cwd);

	if (verifyResult.passed) {
		await commitAll(ctx.cwd, `feat(dynamic-dag): ${task.id} ${task.title}`);
		const completed = completeTaskSuccess(getState()!, task.id);
		setState(completed.state, ctx);
		ctx.ui.notify(`✅ 验证通过。任务 "${task.title}" 已完成。`, "info");
	} else {
		await hardReset(ctx.cwd);
		ctx.ui.notify(`❌ 验证失败: ${verifyResult.output}`, "error");
	}
}

async function showMenu(ctx: ExtensionCommandContext): Promise<void> {
	const lines = [
		"Dynamic-DAG 命令菜单:",
		"  /dag plan <描述>  — 摄入新计划",
		"  /dag --file <路径> — 从文件读取计划",
		"  /dag status        — 显示当前状态",
		"  /dag pause         — 暂停当前任务",
		"  /dag resume        — 恢复暂停的任务",
		"  /dag clear         — 清除 DAG 状态",
	];
	ctx.ui.notify(lines.join("\n"), "info");
}
