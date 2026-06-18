/**
 * The atomic tools the agent may call.
 *
 * Each tool handler:
 *  1. Consumes budget via consumeBudget.
 *  2. On isLastCall, injects ultimatum into tool response.
 *  3. On isExhausted, returns error and triggers handleTaskFailure.
 *  4. On terminal tools, advances state machine.
 */
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { consumeBudget } from "./budget.ts";
import {
	adjustDag,
	applyAssessment,
	completeTaskSuccess,
	decomposeTask,
	handleTaskFailure,
	proposeAdr,
	pushNextToEstimate,
	recommendNextTask,
	startTask,
	submitSpikeResult,
	transitionToVerifying,
} from "./engine.ts";
import { commitAll, hardReset } from "./git.ts";
import { buildCompletionPrompt, buildFirstTaskPrompt, buildNextTaskPrompt } from "./prompt.ts";
import { runDecompositionReview } from "./review.ts";
import { getState, setState } from "./state.ts";
import type { DagState, TaskNode } from "./types.ts";
import { BUDGET_DECOMPOSE_THRESHOLD } from "./types.ts";
import { runVerification } from "./verify.ts";

// ===========================================================================
// Helpers
// ===========================================================================

function textResult(text: string, terminate = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		terminate,
	};
}

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text: `❌ ${text}` }],
		details: { error: text },
		isError: true,
	};
}

function ensureCurrentTask(taskId?: string): TaskNode | null {
	const state = getState();
	if (!state) return null;
	const id = taskId ?? state.currentTaskId;
	if (!id) return null;
	return state.tasks[id] ?? null;
}

async function tryStartNextTask(
	state: DagState,
	ctx: ExtensionContext,
): Promise<{ state: DagState; taskId: string | null; error?: string }> {
	const nextId = recommendNextTask(state);
	if (nextId) {
		return startTask(state, nextId).currentTaskId
			? { state: startTask(state, nextId), taskId: nextId }
			: { state, taskId: nextId, error: "无法启动任务" };
	}
	// Try pushing next CREATED to ESTIMATING
	const pushed = pushNextToEstimate(state);
	if (pushed.currentTaskId) {
		setState(pushed, ctx);
		return { state: pushed, taskId: pushed.currentTaskId };
	}
	return { state, taskId: null };
}

// ===========================================================================
// Register all
// ===========================================================================

/** Register all DAG tools. */
export function registerDagTools(pi: ExtensionAPI): void {
	registerAssessTool(pi);
	registerDecomposeTool(pi);
	registerSubmitTool(pi);
	registerSpikeTool(pi);
	registerAdjustTool(pi);
	registerAdrTool(pi);
}

// ===========================================================================
// assess_task
// ===========================================================================

function registerAssessTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "assess_task",
			label: "Assess Task",
			description: "评估当前任务的复杂度、风险、置信度，以及是否需要进行只读探索。复杂度 ≥ 8 将触发自动拆解。",
			promptSnippet:
				"assess_task(complexity, risk, confidence, is_spike, proposedTargetFiles) — 四维评估 + 目标文件声明",
			parameters: Type.Object({
				complexity: Type.Number({ minimum: -1, maximum: 10, description: "复杂度 1-10，-1 表示需要 Spike 探索" }),
				risk: Type.Number({ minimum: 1, maximum: 10, description: "风险 1-10" }),
				confidence: Type.Number({ minimum: 1, maximum: 10, description: "置信度 1-10" }),
				is_spike: Type.Boolean({ description: "是否需要 Spike 探索" }),
				proposedTargetFiles: Type.Array(Type.String(), { description: "计划修改的文件路径列表" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const state = getState();
				if (!state?.currentTaskId) return errorResult("没有待评估的任务。");

				const task = ensureCurrentTask();
				if (!task || task.status !== "ESTIMATING") return errorResult("当前任务不在评估状态。");

				// Consume budget
				const budget = consumeBudget(state);
				setState(budget.state, ctx);

				const assessment = {
					complexity: params.complexity,
					risk: params.risk,
					confidence: params.confidence,
					is_spike: params.is_spike,
					proposedTargetFiles: params.proposedTargetFiles ?? [],
				};

				const result = applyAssessment(budget.state, state.currentTaskId, assessment);

				if (result.action === "spike") {
					setState(result.state, ctx);
					// Start spike automatically
					const spikeId = Object.values(result.state.tasks).find(
						(t) => t.kind === "spike" && t.spikeForTaskId === state.currentTaskId && t.status === "READY",
					)?.id;
					if (spikeId) {
						const started = startTask(result.state, spikeId);
						setState(started, ctx);
						return textResult(
							`评估结果：需要 Spike 探索。已自动启动探索任务 ${spikeId}。\n\n` +
								buildFirstTaskPrompt(started.tasks[spikeId]),
						);
					}
					return textResult("评估结果：需要 Spike 探索。Spike 任务已创建，等待启动。");
				}

				if (result.action === "decompose") {
					setState(result.state, ctx);
					return textResult(
						`评估结果：复杂度 ${assessment.complexity} ≥ ${BUDGET_DECOMPOSE_THRESHOLD}，需要拆解。\n\n` +
							`请使用 decompose_task 工具提交子任务列表。拆解规则：\n` +
							`1. 每个子任务复杂度 ≤ 5\n` +
							`2. 子任务协作覆盖父任务 100% 需求\n` +
							`3. 明确子任务间的依赖关系\n` +
							`4. 子任务不冗余、不重叠`,
					);
				}

				// Ready to execute — auto-start the task
				const started = await tryStartNextTask(result.state, ctx);
				if (started.error) {
					setState(started.state, ctx);
					return errorResult(started.error);
				}
				setState(started.state, ctx);
				return textResult("评估通过。任务已标记为 RUNNING，请开始执行。完成后调用 submit_task_result(SUCCESS)。");
			},
		}),
	);
}

// ===========================================================================
// decompose_task
// ===========================================================================

function registerDecomposeTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "decompose_task",
			label: "Decompose Task",
			description:
				"提交子任务列表以拆解当前复杂任务。子任务会经过 3 阶段审查（静态校验 → 架构师语义审查 → 拓扑排序），通过后才加入 DAG。",
			promptSnippet:
				"decompose_task(children[{title,description,kind?,boundary?,dependsOn?}], is_sequential?) — 拆解任务（经 3 阶段审查）",
			parameters: Type.Object({
				children: Type.Array(
					Type.Object({
						title: Type.String({ description: "子任务标题" }),
						description: Type.String({ description: "子任务描述" }),
						kind: Type.Optional(Type.String({ description: "standard | contract" })),
						boundary: Type.Optional(Type.String({ description: "操作边界 glob" })),
						dependsOn: Type.Optional(Type.Array(Type.String(), { description: "依赖的其他子任务标题索引" })),
					}),
				),
				is_sequential: Type.Optional(Type.Boolean({ description: "子任务是否顺序执行（默认 true）" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const state = getState();
				if (!state?.currentTaskId) return errorResult("没有待拆解的任务。");

				const task = ensureCurrentTask();
				if (!task) return errorResult("找不到当前任务。");
				if (task.status !== "DECOMPOSING") return errorResult("当前任务不在拆解状态。");

				const children = params.children ?? [];
				if (children.length === 0) return errorResult("子任务列表不能为空。");

				// Run 3-stage review
				const reviewResult = await runDecompositionReview(state, task, children, ctx);

				if (reviewResult.review.status === "REJECTED") {
					setState(reviewResult.state, ctx);

					const retriesLeft = Math.max(0, 2 - reviewResult.state.tasks[task.id].decomposeRetries);
					const blocked = reviewResult.state.tasks[task.id].status === "BLOCKED";

					if (blocked) {
						ctx.ui.notify(`任务 "${task.title}" 拆解已超过最大重试次数，已挂起。请手动处理。`, "error");
						return textResult(
							`❌ 拆解被拒绝（已超过最大重试次数）。\n\n` +
								`失败原因: ${reviewResult.review.failed_criteria}\n` +
								`详情: ${reviewResult.review.reason}\n` +
								`建议: ${reviewResult.review.refinement_suggestion ?? "无"}\n\n` +
								`任务已挂起。请使用 /dag resume 手动恢复或 /dag clear 清除。`,
							true,
						);
					}

					return textResult(
						`❌ 拆解被拒绝（剩余重试 ${retriesLeft} 次）。\n\n` +
							`失败原因: ${reviewResult.review.failed_criteria}\n` +
							`详情: ${reviewResult.review.reason}\n` +
							`建议: ${reviewResult.review.refinement_suggestion ?? "无"}\n\n` +
							`请根据建议修改子任务列表后重试 decompose_task。`,
					);
				}

				// Approved — commit decomposition
				const isSequential = params.is_sequential !== false; // default true
				const updated = decomposeTask(
					state,
					task.id,
					children.map((c) => ({ ...c, kind: (c.kind ?? "standard") as "standard" })),
					isSequential,
				);
				setState(updated, ctx);

				// Try to start the first child task
				const { taskId: nextChildId } = await tryStartNextTask(updated, ctx);
				if (nextChildId) {
					const started = startTask(getState()!, nextChildId);
					if (started.currentTaskId) {
						setState(started, ctx);
					}
				}

				return textResult(`✅ 拆解已通过审查。已创建 ${children.length} 个子任务。`);
			},
		}),
	);
}

// ===========================================================================
// submit_task_result
// ===========================================================================

function registerSubmitTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "submit_task_result",
			label: "Submit Task Result",
			description:
				"提交任务执行结果。SUCCESS → 验证流水线 → Git 提交；FAILED → 重试或级联失败。这是终端工具，调用后无需继续。",
			promptSnippet: "submit_task_result(result, summary?, invalidate_fact_keys?) — 提交结果，引擎验证后决定 DONE",
			parameters: Type.Object({
				result: Type.String({ description: "SUCCESS 或 FAILED" }),
				summary: Type.Optional(Type.String({ description: "任务结果摘要（传递给后续任务）" })),
				invalidate_fact_keys: Type.Optional(Type.Array(Type.String(), { description: "需要标记为过时的事实 key" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const state = getState();
				if (!state?.currentTaskId) return errorResult("没有正在执行的任务。");

				const task = ensureCurrentTask();
				if (!task) return errorResult("找不到当前任务。");
				if (task.status !== "RUNNING") return errorResult("当前任务不在执行状态。");

				const result = (params.result ?? "").toUpperCase().trim();

				if (result === "SUCCESS") {
					// Transition to VERIFYING
					const verifying = transitionToVerifying(state, task.id);
					setState(verifying, ctx);

					// Run verification
					const verifyResult = await runVerification(ctx.cwd);

					if (verifyResult.passed) {
						// Commit and complete
						await commitAll(ctx.cwd, `feat(dynamic-dag): ${task.id} ${task.title}`);
						const completed = completeTaskSuccess(getState()!, task.id, params.invalidate_fact_keys);
						setState(completed.state, ctx);

						if (completed.isComplete) {
							return textResult(buildCompletionPrompt(completed.state), true);
						}

						// Start next task
						const { error } = await tryStartNextTask(completed.state, ctx);
						if (error) return textResult(error);

						if (completed.nextTaskId) {
							const nextTask = getState()?.tasks[completed.nextTaskId];
							return textResult(
								`✅ 任务完成（验证通过）。\n\n${nextTask ? buildNextTaskPrompt(nextTask) : "无更多任务。"}`,
							);
						}

						return textResult("✅ 任务完成（验证通过）。无更多就绪任务，等待调度。");
					}

					// Verification failed
					await hardReset(ctx.cwd);
					const failed = handleTaskFailure(getState()!, task.id, `验证失败: ${verifyResult.output}`);
					setState(failed.state, ctx);

					if (failed.isComplete) {
						return textResult(`❌ 验证失败，所有任务已终止。\n\n${verifyResult.output}`, true);
					}

					return textResult(`❌ 验证失败（将重试）。\n\n${verifyResult.output}`);
				}

				// Self-reported FAILED
				await hardReset(ctx.cwd);
				const failed = handleTaskFailure(state, task.id, params.summary ?? "代理自报失败");
				setState(failed.state, ctx);

				if (failed.isComplete) {
					return textResult(`❌ 任务失败，级联终止。\n\n${params.summary ?? ""}`, true);
				}

				return textResult(`❌ 任务失败（将重试）。\n\n${params.summary ?? ""}`);
			},
		}),
	);
}

// ===========================================================================
// spike_submit
// ===========================================================================

function registerSpikeTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "spike_submit",
			label: "Submit Spike Result",
			description: "提交 Spike 探索收集到的事实。事实会合并到全局知识图谱，Spike 任务完成。",
			promptSnippet: "spike_submit(facts[{key,value,confidence,evidence_paths}]) — 提交探针客观事实",
			parameters: Type.Object({
				facts: Type.Array(
					Type.Object({
						key: Type.String({ description: "语义 key，如 'auth_library' 或文件路径" }),
						value: Type.String({ description: "值，如 'PyJWT' 或文件描述" }),
						confidence: Type.Number({ minimum: 0, maximum: 1, description: "置信度 0-1" }),
						evidence_paths: Type.Array(Type.String(), { description: "证据文件路径" }),
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const state = getState();
				if (!state) return errorResult("DAG 状态不可用。");
				const task = ensureCurrentTask();
				if (!task || task.kind !== "spike") return errorResult("当前任务不是 Spike 探索。");

				const facts = (params.facts ?? []).map((f) => ({
					key: f.key,
					value: f.value,
					confidence: f.confidence,
					evidencePaths: f.evidence_paths ?? [],
				}));

				const result = submitSpikeResult(state, task.id, facts);
				setState(result.state, ctx);

				if (result.isComplete) {
					return textResult(buildCompletionPrompt(result.state), true);
				}

				if (result.nextTaskId) {
					const nextTask = result.state.tasks[result.nextTaskId];
					if (nextTask && nextTask.status === "READY") {
						const started = startTask(result.state, result.nextTaskId);
						setState(started, ctx);
						return textResult(
							`✅ Spike 探索完成。已收集 ${facts.length} 条事实。\n\n` +
								(nextTask ? buildNextTaskPrompt(nextTask) : ""),
						);
					}
					if (nextTask && nextTask.status === "ESTIMATING") {
						return textResult(
							`✅ Spike 探索完成。已收集 ${facts.length} 条事实。\n\n` +
								buildNextTaskPrompt(nextTask) +
								"\n\n请使用 assess_task 评估此任务。",
						);
					}
				}

				return textResult(`✅ Spike 探索完成。已收集 ${facts.length} 条事实。`);
			},
		}),
	);
}

// ===========================================================================
// request_dag_adjustment
// ===========================================================================

function registerAdjustTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "request_dag_adjustment",
			label: "Request DAG Adjustment",
			description:
				"请求在运行时调整 DAG：添加新任务、删除未开始的任务、或将当前任务拆分为子任务。宿主会验证并提交或拒绝。",
			promptSnippet: "request_dag_adjustment(action, task_id?, parent_id?, tasks?, reason) — 运行时调整 DAG",
			parameters: Type.Object({
				action: Type.String({ description: "add | remove | split" }),
				task_id: Type.Optional(Type.String({ description: "remove: 要删除的任务 id" })),
				parent_id: Type.Optional(Type.String({ description: "split: 要拆分的任务 id" })),
				tasks: Type.Optional(
					Type.Array(
						Type.Object({
							title: Type.String({ description: "任务标题" }),
							description: Type.String({ description: "任务描述" }),
							kind: Type.Optional(Type.String({ description: "standard | spike" })),
							boundary: Type.Optional(Type.String({ description: "操作边界 glob" })),
							dependsOn: Type.Optional(Type.Array(Type.String(), { description: "依赖任务 id" })),
						}),
					),
				),
				reason: Type.String({ description: "调整原因" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const state = getState();
				if (!state) return errorResult("DAG 状态不可用。");

				// Consume budget
				const budget = consumeBudget(state);
				setState(budget.state, ctx);

				if (budget.isExhausted) {
					return errorResult("工具调用预算已耗尽。只能提交最终结果。");
				}

				const adjResult = adjustDag(budget.state, {
					action: params.action as "add" | "remove" | "split",
					taskId: params.task_id,
					parentId: params.parent_id,
					tasks: params.tasks?.map((t) => ({
						title: t.title,
						description: t.description,
						kind: t.kind as "standard" | "spike" | undefined,
						boundary: t.boundary,
						dependsOn: t.dependsOn ?? [],
					})),
					reason: params.reason,
				});

				setState(adjResult.state, ctx);

				if (!adjResult.result.accepted) {
					return textResult(`❌ DAG 调整被拒绝: ${adjResult.result.reason}`);
				}

				return textResult(
					`✅ DAG 调整已应用: ${adjResult.result.reason}\n` +
						(adjResult.result.newTaskIds ? `新建任务: ${adjResult.result.newTaskIds.join(", ")}` : ""),
				);
			},
		}),
	);
}

// ===========================================================================
// propose_adr
// ===========================================================================

function registerAdrTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "propose_adr",
			label: "Propose ADR",
			description: "记录全局架构决策，会被注入到后续所有任务的提示中。",
			promptSnippet: "propose_adr(title, decision) — 记录全局架构决策",
			parameters: Type.Object({
				title: Type.String({ description: "决策标题" }),
				decision: Type.String({ description: "决策内容" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const state = getState();
				if (!state) return errorResult("DAG 状态不可用。");

				const updated = proposeAdr(state, params.title, params.decision);
				setState(updated, ctx);

				return textResult(`✅ 已记录架构决策: **${params.title}**`);
			},
		}),
	);
}
