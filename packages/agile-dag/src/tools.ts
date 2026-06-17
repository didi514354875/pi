/**
 * The atomic tools the agent may call.
 *
 * The agent has no free-form planning tool. It can only:
 *  - play_agile_poker:     score the current task's complexity (multiple choice)
 *  - decompose_task:       split an over-complex task into children (fill-in),
 *                          gated by an Architect review
 *  - submit_task_result:   report a result and receive the next task (fill-in)
 *  - submit_spike_result:  close a Spike probe and harvest Key-Value facts
 *  - propose_adr:          write a standing architecture decision to the blackboard
 *
 * submit_task_result / submit_spike_result return content is the primary drive
 * mechanism: it carries the next task prompt, pushing the DAG forward.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reviewDecomposition } from "./architect.ts";
import {
	applyPokerScore,
	createSpikeTask,
	decomposeTask,
	proposeAdr,
	startExecution,
	submitResult,
	submitSpikeResult,
} from "./engine.ts";
import { buildCompletionPrompt, buildNextTaskPrompt } from "./prompt.ts";
import { getState, setState } from "./state.ts";
import { DAG_POKER_THRESHOLD, isStoryPoints, type TaskNode } from "./types.ts";

function textResult(text: string, terminate = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		terminate,
	};
}

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { error: text },
		isError: true,
	};
}

function ensureCurrentTask(taskId: string): TaskNode | null {
	const state = getState();
	if (!state) return null;
	if (taskId !== state.currentTaskId) return null;
	if (!state.currentTaskId) return null;
	const task = state.tasks[state.currentTaskId];
	if (!task) return null;
	return task;
}

/** Register all DAG tools. */
export function registerDagTools(pi: ExtensionAPI): void {
	registerPokerTool(pi);
	registerDecomposeTool(pi);
	registerSubmitTool(pi);
	registerSpikeTool(pi);
	registerAdrTool(pi);
}

function registerPokerTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "play_agile_poker",
			label: "Agile Poker",
			description:
				"评估当前任务的复杂度。你必须对分配给你的每个新任务先调用此工具打分。点数只能从 [1, 2, 3, 5, 8, 13, -1] 中选择。-1 = 探针卡(Spike)：任务处于黑盒状态，触发只读探索。点数 >= 8 的任务会被强制要求拆解。",
			promptSnippet: "play_agile_poker(task_id, story_points, reasoning) — 评估当前任务复杂度 (-1=Spike)",
			parameters: Type.Object({
				task_id: Type.String({ description: "当前分配给你的任务ID" }),
				story_points: Type.Integer({
					description: "复杂度点数: 1, 2, 3, 5, 8, 13, 或 -1 (Spike 探针)",
				}),
				reasoning: Type.String({ description: "一句话说明为什么打这个分数" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { task_id, story_points, reasoning } = params;
				if (!isStoryPoints(story_points)) {
					return errorResult(`无效的点数 ${story_points}。只能从 [1, 2, 3, 5, 8, 13, -1] 中选择。`);
				}

				const state = getState();
				if (!state || task_id !== state.currentTaskId) {
					return errorResult(`任务 ${task_id} 不是当前分配给你的任务。`);
				}

				const task = state.tasks[task_id];
				if (!task || task.status !== "ESTIMATING") {
					return errorResult(`任务 ${task_id} 不在评估状态（当前状态: ${task?.status ?? "未知"}）。`);
				}

				// Reasoning is required by the schema but only used as a forced CoT trace;
				// it is not persisted in the task node (keeps context lean).
				void reasoning;

				const { state: newState, action } = applyPokerScore(state, task_id, story_points);

				if (action === "spike") {
					const spiked = createSpikeTask(newState, task_id);
					setState(spiked, ctx);
					const spikeId = spiked.currentTaskId;
					return textResult(
						`任务 ${task_id} 已冻结（黑盒）。系统已派生一个只读探针前置任务 **${spikeId}**（"Spike: ${state.tasks[task_id].title}"）。\n\n请以只读模式（仅 read/search 等，禁止 edit/write）探索相关代码与环境。完成后调用 submit_spike_result 提交事实，task_id 必须填 **${spikeId}**（探针任务 ID），而非原任务 ID。\n\n输出格式：submit_spike_result(task_id="${spikeId}", facts=[{key:"数据库",value:"MySQL"},...])`,
					);
				}

				if (action === "decompose") {
					setState(newState, ctx);
					return textResult(
						`警告：任务太复杂(点数${story_points}≥${DAG_POKER_THRESHOLD})！请立即调用 decompose_task 将任务 ${task_id} 拆解为点数 <= 5 的子任务。`,
					);
				}

				const executing = startExecution(newState, task_id);
				setState(executing, ctx);
				return textResult("评估通过。系统已将任务标记为可执行，请开始执行。完成后调用 submit_task_result。");
			},
		}),
	);
}

function registerDecomposeTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "decompose_task",
			label: "Decompose Task",
			description:
				'将一个过于复杂的任务拆解为多个子任务。当 play_agile_poker 返回点数 >= 8 时必须调用。执行中发现任务比预估的复杂，也可以调用此工具中途拆解。子任务至少 2 个。若有跨模块需求，第一个子任务应标记为 kind="contract"（设计契约），其产出将作为下游任务的强制输入上下文。',
			promptSnippet:
				"decompose_task(target_task_id, sub_tasks[{title,description,kind?,boundary?}], is_sequential) — 拆解任务（经架构师评审）",
			parameters: Type.Object({
				target_task_id: Type.String({ description: "要拆解的父任务ID" }),
				sub_tasks: Type.Array(
					Type.Object({
						title: Type.String({ description: "子任务标题" }),
						description: Type.String({ description: "子任务描述/目标" }),
						kind: Type.Optional(
							Type.Union([Type.Literal("standard"), Type.Literal("contract")], {
								description: "standard=普通任务；contract=设计契约节点，产出作为下游强制输入",
							}),
						),
						boundary: Type.Optional(
							Type.String({
								description: "DoD 边界红线，如 “只允许修改 app/routes.py”。留空=无限制",
							}),
						),
					}),
					{ minItems: 2 },
				),
				is_sequential: Type.Boolean({ description: "子任务是串行(有先后依赖)还是并行" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { target_task_id, sub_tasks, is_sequential } = params;

				const state = getState();
				if (!state) {
					return errorResult("没有活跃的 DAG。请先用 /dag 创建计划。");
				}

				const task = state.tasks[target_task_id];
				if (!task) {
					return errorResult(`任务 ${target_task_id} 不存在。`);
				}
				if (target_task_id !== state.currentTaskId) {
					return errorResult(
						`任务 ${target_task_id} 不是当前正在评估或执行的任务（当前任务ID: ${state.currentTaskId ?? "无"}）。`,
					);
				}

				if (task.status !== "ESTIMATING" && task.status !== "IN_PROGRESS") {
					return errorResult(
						`任务 ${target_task_id} 当前状态为 ${task.status}，无法拆解。只能拆解正在评估或正在执行的任务。`,
					);
				}

				// Architect review gate — fail-open on any infrastructure error.
				const review = await reviewDecomposition(ctx, task, sub_tasks);
				if (!review.approved) {
					return errorResult(`架构师驳回：${review.guidance}`);
				}

				const newState = decomposeTask(state, target_task_id, sub_tasks, is_sequential);
				setState(newState, ctx);

				const childCount = Object.values(newState.tasks).filter((t) => t.parentId === target_task_id).length;
				const firstChild = newState.currentTaskId ? newState.tasks[newState.currentTaskId] : undefined;
				return textResult(
					`拆解成功。已生成 ${childCount} 个子任务。\n第一个子任务：**${firstChild?.id ?? "?"}**（${firstChild?.title ?? "?"}），已推给你评估。请先对此子任务调用 play_agile_poker。`,
				);
			},
		}),
	);
}

function registerSubmitTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "submit_task_result",
			label: "Submit Task Result",
			description:
				"提交当前任务的执行结果。提交后后台 DAG 引擎会自动选择下一个最优任务并推给你。status 只能是 SUCCESS 或 FAILED。",
			promptSnippet:
				"submit_task_result(task_id, status, result_summary, need_new_tasks) — 提交结果，接收下一个任务",
			parameters: Type.Object({
				task_id: Type.String({ description: "当前任务ID" }),
				status: Type.String({ description: "SUCCESS 或 FAILED" }),
				result_summary: Type.String({ description: "核心结论或产出物（≤200字，作为下一个任务的上下文）" }),
				need_new_tasks: Type.Boolean({
					description: "是否发现需要新工具或补充任务。为 true 时系统不会自动推送下一个任务。",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { task_id, status, result_summary, need_new_tasks } = params;

				if (status !== "SUCCESS" && status !== "FAILED") {
					return errorResult(`无效的状态 ${status}。只能是 SUCCESS 或 FAILED。`);
				}

				const task = ensureCurrentTask(task_id);
				if (!task) {
					return errorResult(`任务 ${task_id} 不是当前正在执行的任务。`);
				}

				if (task.status !== "IN_PROGRESS") {
					return errorResult(`任务 ${task_id} 不在执行状态（当前状态: ${task.status}）。只能提交正在执行的任务。`);
				}

				const state = getState();
				if (!state) {
					return errorResult("DAG 状态丢失。");
				}

				const {
					state: newState,
					nextTaskId,
					isComplete,
				} = submitResult(state, task_id, status, result_summary, need_new_tasks);
				setState(newState, ctx);

				if (isComplete) {
					return textResult(buildCompletionPrompt(newState), true);
				}

				if (nextTaskId) {
					const nextTask = newState.tasks[nextTaskId];
					if (nextTask) {
						return textResult(buildNextTaskPrompt(nextTask));
					}
				}

				if (need_new_tasks) {
					return textResult(
						"任务已记录。你标记了需要新任务或工具。请说明你需要的补充任务或工具，或调用 decompose_task 拆解当前范围。",
					);
				}

				return textResult("任务已记录。没有立即可执行的后续任务。请用 /dag status 查看进度。");
			},
		}),
	);
}

function registerSpikeTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "submit_spike_result",
			label: "Submit Spike Result",
			description:
				"提交 Spike 探针任务的客观事实（Key-Value）。绝对禁止输出 ToDo List、计划或主观推断——只能输出客观事实（如 数据库=MySQL、框架=FastAPI）。事实将写入全局黑板，冻结的原任务随后解锁重新评估。",
			promptSnippet: "submit_spike_result(task_id, facts[{key,value}]) — 提交探针客观事实（禁止 TODO）",
			parameters: Type.Object({
				task_id: Type.String({ description: "当前 Spike 探针任务ID" }),
				facts: Type.Array(
					Type.Object({
						key: Type.String({ description: "事实键，如 “数据库” 或 “auth_framework”" }),
						value: Type.String({ description: "事实值，如 “MySQL” 或 “FastAPI”" }),
					}),
					{ minItems: 1 },
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { task_id, facts } = params;

				const task = ensureCurrentTask(task_id);
				if (!task) {
					return errorResult(`任务 ${task_id} 不是当前正在执行的任务。`);
				}
				if (task.kind !== "spike") {
					return errorResult(`任务 ${task_id} 不是 Spike 探针任务（kind=${task.kind}）。`);
				}
				if (task.status !== "IN_PROGRESS") {
					return errorResult(`任务 ${task_id} 不在执行状态（当前状态: ${task.status}）。`);
				}

				const state = getState();
				if (!state) return errorResult("DAG 状态丢失。");

				const factRecord: Record<string, string> = {};
				for (const f of facts) factRecord[f.key] = f.value;

				const { state: newState, nextTaskId, isComplete } = submitSpikeResult(state, task_id, factRecord);
				setState(newState, ctx);

				if (isComplete) {
					return textResult(buildCompletionPrompt(newState), true);
				}

				if (nextTaskId) {
					const nextTask = newState.tasks[nextTaskId];
					if (nextTask) {
						return textResult(
							`探针事实已记录并写入全局黑板。原任务已解锁，请结合新事实重新评估。\n\n${buildNextTaskPrompt(nextTask)}`,
						);
					}
				}

				return textResult("探针事实已记录并写入全局黑板。没有立即可执行的后续任务。请用 /dag status 查看进度。");
			},
		}),
	);
}

function registerAdrTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "propose_adr",
			label: "Propose ADR",
			description:
				"将一条架构决策记录（ADR）写入全局黑板。用于重大技术选型（如引入新库、敲定规范）。后续所有任务都会默认携带此规则。",
			promptSnippet: "propose_adr(title, decision) — 记录全局架构决策",
			parameters: Type.Object({
				title: Type.String({ description: "决策标题，如 “统一鉴权方案”" }),
				decision: Type.String({
					description: "架构决策内容，后续所有任务默认携带此规则",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { title, decision } = params;
				const state = getState();
				if (!state) return errorResult("没有活跃的 DAG。请先用 /dag 创建计划。");

				const newState = proposeAdr(state, title, decision);
				setState(newState, ctx);
				return textResult("ADR 已写入全局黑板，后续任务将携带此规则。");
			},
		}),
	);
}
