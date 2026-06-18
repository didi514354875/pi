/**
 * The atomic tools the agent may call (v3.1).
 *
 * The agent has no free-form planning tool. It can only:
 *  - assess_task:        self-assess complexity/risk/confidence/is_spike
 *  - decompose_task:     split an over-complex task into children (fill-in),
 *                        gated by an Architect review
 *  - submit_task_result: report a result (SUCCESS → verify gate; FAILED → reset;
 *                        FAILED_NEED_SPIKE → derive spike)
 *  - submit_spike_result: close a Spike probe and harvest Key-Value facts
 *  - propose_adr:         write a standing architecture decision to the blackboard
 *
 * The engine owns the transaction boundary: submit_task_result(SUCCESS) runs
 * the verification pipeline, commits on pass, resets on fail. The agent never
 * decides "done" — verification does.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reviewDecomposition } from "./architect.ts";
import {
	applyAssessment,
	completeTaskSuccess,
	decomposeTask,
	deriveSpike,
	handleTaskFailure,
	proposeAdr,
	pushNextToAssess,
	recommendNextTask,
	startTask,
	submitSpikeResult,
	transitionToVerifying,
} from "./engine.ts";
import { findFactForPath, toPosix } from "./facts.ts";
import { commitAll, hardReset, isWorkspaceClean } from "./git.ts";
import { buildCompletionPrompt, buildNextTaskPrompt, buildResumePrompt } from "./prompt.ts";
import { getState, setState } from "./state.ts";
import type { DagState, TaskNode } from "./types.ts";
import { runVerification } from "./verify.ts";

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

/**
 * Select and start the next task.
 *
 * Prefers a READY task (recommendNextTask). Before starting it, the workspace
 * must be clean — a dirty tree hard-blocks task start (the agent must clean up
 * and `/dag resume`). With no READY task, the next CREATED task is pushed for
 * assessment. Returns the started task id, or null with an `error` on block.
 */
async function tryStartNextTask(
	state: DagState,
	ctx: { cwd: string; signal?: AbortSignal },
): Promise<{ state: DagState; taskId: string | null; error?: string }> {
	const nextId = recommendNextTask(state);
	if (!nextId) {
		const assessing = pushNextToAssess(state);
		return { state: assessing, taskId: assessing.currentTaskId };
	}
	const clean = await isWorkspaceClean(ctx.cwd, ctx.signal);
	if (!clean) {
		return {
			state,
			taskId: null,
			error: "工作区不干净（有未提交改动）。请清理后用 /dag resume 恢复。",
		};
	}
	const started = startTask(state, nextId);
	return { state: started, taskId: nextId };
}

/** Register all DAG tools. */
export function registerDagTools(pi: ExtensionAPI): void {
	registerAssessTool(pi);
	registerDecomposeTool(pi);
	registerSubmitTool(pi);
	registerSpikeTool(pi);
	registerAdrTool(pi);
}

function registerAssessTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "assess_task",
			label: "Assess Task",
			description:
				"评估当前任务的复杂度/风险/信心/是否探针。必须对每个新任务先调用此工具。complexity > 8 会强制要求拆解。is_spike=true 触发只读探针（黑盒任务）。非探针任务必须填写 proposed_target_files 且每个路径必须在 Facts 证据路径中有来源（Proof of Knowledge）。",
			promptSnippet:
				"assess_task(task_id, complexity, risk, confidence, is_spike, proposed_target_files, reasoning) — 四维评估 + 目标文件声明",
			parameters: Type.Object({
				task_id: Type.String({ description: "当前分配给你的任务ID" }),
				complexity: Type.Integer({
					description: "复杂度 1-10 (1=极简, 10=极其模糊)",
					minimum: 1,
					maximum: 10,
				}),
				risk: Type.Integer({ description: "风险 1-10 (1=无风险, 10=高危)", minimum: 1, maximum: 10 }),
				confidence: Type.Integer({
					description: "信心 1-10 (1=完全没把握, 10=非常确定)",
					minimum: 1,
					maximum: 10,
				}),
				is_spike: Type.Boolean({
					description: "是否为 Spike 探针（黑盒任务，触发只读探索）",
				}),
				proposed_target_files: Type.Array(Type.String(), {
					description:
						"计划修改的文件全路径（Proof of Knowledge）。非探针任务必填且每个路径必须在 Facts 中有来源；不确定则 is_spike=true。",
				}),
				reasoning: Type.String({ description: "一句话说明评估理由" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { task_id, complexity, risk, confidence, is_spike, proposed_target_files, reasoning } = params;

				const state = getState();
				if (!state || task_id !== state.currentTaskId) {
					return errorResult(`任务 ${task_id} 不是当前分配给你的任务。`);
				}

				const task = state.tasks[task_id];
				if (!task || task.status !== "CREATED") {
					return errorResult(`任务 ${task_id} 不在待评估状态（当前状态: ${task?.status ?? "未知"}）。`);
				}

				if (complexity < 1 || complexity > 10 || risk < 1 || risk > 10 || confidence < 1 || confidence > 10) {
					return errorResult("complexity/risk/confidence 必须在 1-10 范围内。");
				}

				// Guard: day-zero init spike that somehow is CREATED instead of RUNNING.
				if (task.kind === "spike") {
					const started = startTask(state, task_id);
					setState(started, ctx);
					return textResult(
						"Spike 探针已启动。请以只读模式（仅 read/search 等，禁止 edit/write）探索。完成后调用 submit_spike_result。",
					);
				}

				// ---- Proof of Knowledge gate (v3.2) ----
				if (!is_spike) {
					if (!proposed_target_files || proposed_target_files.length === 0) {
						return errorResult(
							"非探针任务必须声明 proposed_target_files。若不确定目标文件，设 is_spike=true 先派生探针。",
						);
					}
					for (const f of proposed_target_files) {
						const posix = toPosix(f);
						const supported = findFactForPath(state, posix);
						if (!supported) {
							return errorResult(
								`文件 ${f} 无事实依据（不在任何 Spike 事实的证据路径中）。禁止基于幻觉猜测路径。请先 is_spike=true 派生探针。`,
							);
						}
					}
				}
				// ---- end Proof gate ----

				// Persist reasoning into task context so downstream sees the evaluation rationale.
				const stateWithReasoning: DagState = {
					...state,
					tasks: {
						...state.tasks,
						[task_id]: {
							...task,
							context: `${task.context}\n[assess]: ${reasoning}`.slice(0, 500),
						},
					},
				};
				const { state: newState, action } = applyAssessment(stateWithReasoning, task_id, {
					complexity,
					risk,
					confidence,
					isSpike: is_spike,
					proposedTargetFiles: proposed_target_files ?? [],
				});

				if (action === "spike") {
					const spiked = deriveSpike(newState, task_id);
					const started = await tryStartNextTask(spiked, ctx);
					setState(started.state, ctx);
					if (started.error) return errorResult(started.error);
					if (!started.taskId) return textResult("探针已派生，但没有可执行的任务。");
					const spikeTask = started.state.tasks[started.taskId];
					return textResult(
						`任务 ${task_id} 已冻结（黑盒）。系统已派生只读探针 **${started.taskId}**（"${spikeTask.title}"）并开始执行。\n\n请以只读模式（仅 read/search 等，禁止 edit/write）探索相关代码与环境。完成后调用 submit_spike_result，task_id 必须填 **${started.taskId}**（探针任务 ID），而非原任务 ID。\n\n输出格式：submit_spike_result(task_id="${started.taskId}", facts=[{key:"数据库",value:"MySQL",evidence_paths:["app/db.py"],confidence:0.9},...])`,
					);
				}

				if (action === "decompose") {
					setState(newState, ctx);
					return textResult(
						`警告：任务太复杂(complexity=${complexity}>8)！请立即调用 decompose_task 将任务 ${task_id} 拆解为 complexity <= 5 的子任务。`,
					);
				}

				// action === "ready"
				const started = await tryStartNextTask(newState, ctx);
				if (started.error) {
					// Dirty workspace: persist the READY transition (so /dag resume can
					// start it once cleaned) but report the block to the agent.
					setState(started.state, ctx);
					return errorResult(started.error);
				}
				setState(started.state, ctx);
				if (!started.taskId) {
					return textResult("评估通过。没有立即可执行的后续任务。请用 /dag status 查看进度。");
				}
				return textResult(
					"评估通过。系统已将任务标记为可执行（RUNNING），请开始执行。完成后调用 submit_task_result(SUCCESS)。",
				);
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
				'将一个过于复杂的任务拆解为多个子任务。当 assess_task 返回 complexity > 8 时必须调用。执行中发现任务比预估的复杂，也可以调用此工具中途拆解。子任务至少 2 个。若有跨模块需求，第一个子任务应标记为 kind="contract"（设计契约），其产出将作为下游任务的强制输入上下文。',
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

				if (task.status !== "CREATED" && task.status !== "RUNNING") {
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
					`拆解成功。已生成 ${childCount} 个子任务。\n第一个子任务：**${firstChild?.id ?? "?"}**（${firstChild?.title ?? "?"}），已推给你评估。请先对此子任务调用 assess_task。`,
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
				"提交当前任务的结果。SUCCESS 会进入验证流水线（PI_AGILE_VERIFY_CMD）：通过则自动 Git commit 并 DONE；失败则自动回滚（git reset + clean）并重试。FAILED 直接回滚并重试/失败。FAILED_NEED_SPIKE 派生只读探针。不要自行假设完成——验证通过才算 DONE。",
			promptSnippet:
				"submit_task_result(task_id, status, result_summary, invalidate_facts?) — 提交结果，引擎验证后决定 DONE",
			parameters: Type.Object({
				task_id: Type.String({ description: "当前任务ID" }),
				status: Type.Union([Type.Literal("SUCCESS"), Type.Literal("FAILED"), Type.Literal("FAILED_NEED_SPIKE")], {
					description: "SUCCESS=完成（将进入验证）; FAILED=失败; FAILED_NEED_SPIKE=遇到未知需探针",
				}),
				result_summary: Type.String({
					description: "核心结论或产出物（≤200字，作为下一个任务的上下文）",
				}),
				invalidate_facts: Type.Optional(
					Type.Array(Type.String(), {
						description: "本任务 SUCCESS 后需失效的 fact key 列表（如重构了底层接口使旧事实失效）。留空=不失效。",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { task_id, status, result_summary, invalidate_facts } = params;

				const task = ensureCurrentTask(task_id);
				if (!task) {
					return errorResult(`任务 ${task_id} 不是当前正在执行的任务。`);
				}
				if (task.status !== "RUNNING") {
					return errorResult(`任务 ${task_id} 不在执行状态（当前状态: ${task.status}）。只能提交正在执行的任务。`);
				}

				const state = getState();
				if (!state) return errorResult("DAG 状态丢失。");

				// Record the summary on the task node so completeTaskSuccess can propagate it.
				const summary = result_summary.slice(0, 200);

				if (status === "FAILED_NEED_SPIKE") {
					const spiked = deriveSpike(
						{ ...state, tasks: { ...state.tasks, [task_id]: { ...task, resultSummary: summary } } },
						task_id,
					);
					const started = await tryStartNextTask(spiked, ctx);
					setState(started.state, ctx);
					if (started.error) return errorResult(started.error);
					if (!started.taskId) return textResult("探针已派生，但没有可执行的任务。");
					const spikeTask = started.state.tasks[started.taskId];
					return textResult(
						`任务 ${task_id} 已冻结（需探针澄清）。系统已派生只读探针 **${started.taskId}**（"${spikeTask.title}"）并开始执行。\n\n请以只读模式探索。完成后调用 submit_spike_result，task_id 填 **${started.taskId}**。`,
					);
				}

				if (status === "FAILED") {
					await hardReset(ctx.cwd, ctx.signal);
					const {
						state: newState,
						nextTaskId,
						isComplete,
					} = handleTaskFailure(getState() ?? state, task_id, summary);
					setState(newState, ctx);
					if (isComplete) return textResult(buildCompletionPrompt(newState), true);
					if (nextTaskId) {
						const nextTask = newState.tasks[nextTaskId];
						if (nextTask) return textResult(buildNextTaskPrompt(nextTask));
					}
					return textResult(
						`任务 ${task_id} 已失败并回滚。任务将重试（或已达重试上限终止）。没有立即可执行的后续任务。`,
					);
				}

				// status === "SUCCESS" — enter the verification gate.
				const verifying = transitionToVerifying(
					{ ...state, tasks: { ...state.tasks, [task_id]: { ...task, resultSummary: summary } } },
					task_id,
				);
				setState(verifying, ctx);

				const verifyResult = await runVerification(ctx.cwd, ctx.signal);
				if (verifyResult.passed) {
					const committed = await commitAll(
						ctx.cwd,
						`feat(dag): ${task_id} ${task.title.slice(0, 60)}`,
						ctx.signal,
					);
					if (!committed) {
						// Git commit failed for a non-"nothing to commit" reason — treat as verify failure.
						await hardReset(ctx.cwd, ctx.signal);
						const {
							state: newState,
							nextTaskId,
							isComplete,
						} = handleTaskFailure(getState() ?? verifying, task_id, `git commit 失败`);
						setState(newState, ctx);
						if (isComplete) return textResult(buildCompletionPrompt(newState), true);
						if (nextTaskId) {
							const nextTask = newState.tasks[nextTaskId];
							if (nextTask) return textResult(buildNextTaskPrompt(nextTask));
						}
						return textResult("Git 提交失败，已回滚。任务将重试。");
					}
					const {
						state: newState,
						nextTaskId,
						isComplete,
					} = completeTaskSuccess(getState() ?? verifying, task_id, invalidate_facts);
					setState(newState, ctx);
					if (isComplete) return textResult(buildCompletionPrompt(newState), true);
					if (nextTaskId) {
						const nextTask = newState.tasks[nextTaskId];
						if (nextTask) return textResult(buildNextTaskPrompt(nextTask));
					}
					return textResult(`任务 ${task_id} 验证通过并已提交。没有立即可执行的后续任务。`);
				}

				// Verification failed — roll back and retry (or terminal-fail).
				await hardReset(ctx.cwd, ctx.signal);
				const {
					state: newState,
					nextTaskId,
					isComplete,
				} = handleTaskFailure(getState() ?? verifying, task_id, verifyResult.output);
				setState(newState, ctx);
				if (isComplete) return textResult(buildCompletionPrompt(newState), true);
				if (nextTaskId) {
					const nextTask = newState.tasks[nextTaskId];
					if (nextTaskId === task_id) {
						// Same task id: failure was under the retry cap — the engine
						// re-queued it RUNNING. Tell the agent to fix and resubmit.
						return textResult(
							`验证失败，已回滚。任务 ${task_id} 将重试。\n验证输出: ${verifyResult.output}\n\n${buildResumePrompt(nextTask)}`,
						);
					}
					if (nextTask) {
						return textResult(buildNextTaskPrompt(nextTask));
					}
				}
				return textResult(
					`验证失败，已回滚: ${verifyResult.output}\n任务 ${task_id} 将重试（或已达重试上限终止）。`,
				);
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
				"提交 Spike 探针任务的客观事实（Key-Value）。绝对禁止输出 ToDo List、计划或主观推断——只能输出客观事实（如 数据库=MySQL、框架=FastAPI）。事实将写入全局黑板，冻结的原任务随后解锁重新评估。Spike 是只读探针，跳过验证和 Git 提交。",
			promptSnippet:
				"submit_spike_result(task_id, facts[{key,value,confidence?,evidence_paths?}]) — 提交探针客观事实（禁止 TODO）",
			parameters: Type.Object({
				task_id: Type.String({ description: "当前 Spike 探针任务ID" }),
				facts: Type.Array(
					Type.Object({
						key: Type.String({ description: "事实键，如 “数据库” 或 “auth_framework”" }),
						value: Type.String({ description: "事实值，如 “MySQL” 或 “FastAPI”" }),
						confidence: Type.Optional(Type.Number({ description: "信心值 0.0-1.0，默认 0.8" })),
						evidence_paths: Type.Optional(Type.Array(Type.String(), { description: "支撑此事实的文件路径列表" })),
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
				if (task.status !== "RUNNING") {
					return errorResult(`任务 ${task_id} 不在执行状态（当前状态: ${task.status}）。`);
				}

				const state = getState();
				if (!state) return errorResult("DAG 状态丢失。");

				// Convert to SpikeFactInput[] for submitSpikeResult.
				const spikeFacts = facts.map((f: Record<string, unknown>) => ({
					key: f.key as string,
					value: f.value as string,
					confidence: (f.confidence as number | undefined) ?? 0.8,
					evidencePaths: ((f.evidence_paths as string[]) ?? []) as string[],
				}));

				const { state: newState, nextTaskId, isComplete } = submitSpikeResult(state, task_id, spikeFacts);
				setState(newState, ctx);

				// Day-zero init spike: no original task to unlock.
				if (task.spikeForTaskId === null) {
					if (isComplete) {
						return textResult("项目初始化探针完成，骨架事实已录入。第一个业务任务现已解锁。", true);
					}
					if (nextTaskId) {
						const nextTask = newState.tasks[nextTaskId];
						if (nextTask) {
							return textResult(
								`项目初始化探针完成，骨架事实已录入。第一个业务任务现已解锁。\n\n${buildNextTaskPrompt(nextTask)}`,
							);
						}
					}
					return textResult("项目初始化探针完成。没有立即可执行的后续任务。请用 /dag status 查看进度。");
				}

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
