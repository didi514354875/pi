/**
 * System prompt and task-prompt builders.
 *
 * `buildDagSystemPrompt` is injected via before_agent_start and realizes the
 * context-diet core of the design: the agent sees only its current task and
 * accumulated context, never the full plan or sibling tasks.
 *
 * The prompt is layered to maximize prefix-cache hits:
 *   Tier 1 — static role, workflow rules, and architect preset (never changes).
 *   Tier 2 — low-frequency global blackboard: facts + ADRs.
 *   Tier 3 — high-frequency dynamic current-task block (<500 tokens).
 */
import { DAG_COMPLEXITY_THRESHOLD, type DagState, type TaskNode } from "./types.ts";

// ===========================================================================
// Tier 1 — static rules (cache-friendly: identical across every task)
// ===========================================================================

const ROLE_PERSONA = `# 角色设定
你是一个顶级敏捷开发团队的"执行特工"。
你的核心大脑（状态管理、记忆、依赖规划）已经被外包给了后台的 DAG 调度引擎。
你不需要记住全局目标，你只需要极其专注地完成系统派发给你的【眼前任务】。
不要试图记住全局任务列表。后台会自动推送下一个任务。`;

const ARCHITECT_PRESET = `# 架构师预设准则（宏观开发指导）
- 优先复用现有代码与约定；不引入不必要的抽象或新依赖。
- 修改在源头进行，不保留兼容层、别名或废弃路径。
- 干净切换：迁移所有调用点，不留半成品。
- 不臆造输出：关于代码/工具/测试的声明必须有据可查。
- 越界即失败：严格遵守当前任务的 Boundary Redline（若存在）。
- 你的 submit_task_result(SUCCESS) 不是完成凭证——引擎会运行验证流水线（PI_AGILE_VERIFY_CMD）和 Git 提交来确认。验证失败将自动回滚。`;

const WORKFLOW_RULES = `# 工作流原则（严格遵守）
当你接收到后台发来的新任务时，你必须遵循以下敏捷工作流：

注意：新项目的第一个任务是系统自动派发的【项目初始化探针】。请只读调研根目录/README/依赖文件，把技术栈和核心目录结构作为 facts 提交（每个目录用 evidence_paths 标注路径）。完成后业务任务才会解锁。

1. 评估 (Assess)
- 任何新任务，必须先调用 assess_task 工具，给出 complexity(1-10)/risk(1-10)/confidence(1-10)/is_spike。
- complexity > ${DAG_COMPLEXITY_THRESHOLD} → 强制拆解。
- is_spike=true → 触发只读探针。
- 禁止基于幻觉猜测文件路径！非探针任务（is_spike=false）必须填写 proposed_target_files，且每个路径必须在 Global Facts 的证据路径中能找到来源。
- 不确定目标文件在哪 → 必须 is_spike=true，先派生探针找到文件并存入 Facts，回来才能报具体路径。

2. 拆解 (Decompose)
- 如果系统因 complexity 过高拦截了你，你必须调用 decompose_task，将大任务拆分为一系列 complexity <= 5 的子任务。
- 跨模块需求：第一个子任务应标记 kind="contract"（设计契约），其产出作为下游强制输入上下文。
- 执行中发现任务比预估的复杂，也可以调用 decompose_task 中途拆解。
- 拆解会经过架构师评审节点；若被驳回，按指导意见修正后重新拆解。

3. 探针 (Spike)
- 若你评估 is_spike=true，系统会派生一个只读 Spike 前置任务。Spike 期间禁止 edit/write，只能用 read/search 等只读工具探索。
- 探索完成后调用 submit_spike_result 输出客观事实（key/value/confidence/evidence_paths）。绝对禁止输出 TODO 或主观规划。

4. 执行 (Execute)
- 当任务被系统标记为 READY，你可以自由使用你的其他工具（bash, read, edit, write 等）去解决问题。
- 任务描述末尾若带 <boundary_redline>，只允许触碰其中声明的范围，越界判定失败（硬拦截，编辑越界文件会被系统直接阻止）。

5. 交付 (Submit)
- 任务一旦完成，立即调用 submit_task_result(SUCCESS) 提炼核心结论（≤200字）。
- 系统将自动运行验证（PI_AGILE_VERIFY_CMD）和 Git 提交。验证失败会自动回滚并重试。
- 不要自行假设完成——验证通过才算 DONE。
- 失败时用 status=FAILED 提交错误摘要；引擎会自动回滚并重试。
- 若重构了底层接口等导致旧事实无效，在 submit_task_result(SUCCESS) 时设 invalidate_facts 使相关 facts 失效。
- 遇重大技术选型，可随时调用 propose_adr 写入全局架构决策黑板，后续任务将默认携带该规则。
- 不要自己去猜下一步做什么！提交后，后台的 DAG 算法会自动把下一个最优任务喂给你。`;
// ===========================================================================
// Tier 2 — low-frequency global blackboard (facts + ADRs)
// ===========================================================================

function renderFacts(state: DagState): string {
	if (state.facts.length === 0) return "";
	const lines = state.facts.map((f) => {
		const tag = f.status === "EXPIRED" ? " [失效]" : f.status === "CONFLICT" ? " [冲突]" : "";
		const ev = f.evidencePaths.length > 0 ? ` (证据: ${f.evidencePaths.join(",")})` : "";
		return `- ${f.key} = ${f.value}${ev}${tag}`;
	});
	return `<global_facts>\n${lines.join("\n")}\n</global_facts>\n`;
}
function renderAdrs(state: DagState): string {
	if (state.adrs.length === 0) return "";
	const lines = state.adrs.map((a) => `- [${a.id}] ${a.title}: ${a.decision}`).join("\n");
	return `<global_adrs>\n${lines}\n</global_adrs>\n`;
}

// ===========================================================================
// Tier 3 — high-frequency dynamic current-task block
// ===========================================================================

function kindBadge(task: TaskNode): string {
	switch (task.kind) {
		case "spike":
			return "【Spike 探针：只读模式，禁止 edit/write，完成后调用 submit_spike_result 输出客观事实】";
		case "contract":
			return "【契约节点：你的产出将作为下游任务的强制输入上下文】";
		default:
			return "";
	}
}

function boundaryBlock(task: TaskNode): string {
	if (!task.boundary || task.boundary.trim().length === 0) return "";
	return `<boundary_redline>只允许修改/接触：${task.boundary}。越界判定失败。</boundary_redline>\n`;
}

function buildTaskBlock(task: TaskNode): string {
	const badge = kindBadge(task);
	const verifyingHint = task.status === "VERIFYING" ? "【系统正在验证中…】\n" : "";
	const contextBlock =
		task.context && task.context.trim().length > 0
			? `<task_context>\n${task.context}\n</task_context>`
			: "<task_context>（无前置上下文）</task_context>";

	return `<current_task>
${verifyingHint}${badge ? `${badge}\n` : ""}${task.title}
</current_task>
<task_id>${task.id}</task_id>
<task_kind>${task.kind}</task_kind>
<task_status>${task.status}</task_status>
<task_description>
${task.description}
</task_description>
${contextBlock}
${boundaryBlock(task)}`;
}

/**
 * Build the system-prompt suffix injected before each agent start.
 *
 * Order matters for KV-cache: Tier 1 (static) first, Tier 2 (low-frequency
 * blackboard) second, Tier 3 (per-task dynamic) last.
 */
export function buildDagSystemPrompt(state: DagState, task: TaskNode): string {
	const tier2 = `${renderFacts(state)}${renderAdrs(state)}`;
	const tier3 = buildTaskBlock(task);
	return `\n\n${ROLE_PERSONA}\n\n${ARCHITECT_PRESET}\n\n${WORKFLOW_RULES}\n\n${tier2}${tier3}`;
}

/** Build the first-task prompt sent after plan ingestion. */
export function buildFirstTaskPrompt(task: TaskNode): string {
	const badge = kindBadge(task);
	if (task.kind === "spike") {
		return `Agile-DAG 模式已激活。后端 DAG 引擎已接管任务状态管理。

【当前分配给你的 Spike 探针任务】：${task.title}
【任务ID】：${task.id}
${badge ? `${badge}\n` : ""}
【任务描述】：${task.description}
${boundaryBlock(task)}
请以只读模式（仅 read/search 等，禁止 edit/write）探索项目骨架。完成后调用 submit_spike_result（注意参数含 confidence、evidence_paths）输出客观事实，每个事实用 evidence_paths 标注其来源文件路径。`;
	}
	return `Agile-DAG 模式已激活。后端 DAG 引擎已接管任务状态管理。

【当前分配给你的新任务】：${task.title}
【任务ID】：${task.id}
【任务类型】：${task.kind}${badge ? `\n${badge}` : ""}
【任务描述】：${task.description}
${boundaryBlock(task)}
你必须先调用 assess_task 评估（complexity/risk/confidence/is_spike/proposed_target_files）。complexity > ${DAG_COMPLEXITY_THRESHOLD} 的任务会被强制要求拆解；黑盒任务可设 is_spike=true 触发 Spike 探针。不确定目标文件时先 is_spike=true。`;
}

/** Build a resume-execution prompt for a paused but already-scored task. */
export function buildResumePrompt(task: TaskNode): string {
	const badge = kindBadge(task);
	return `[恢复执行] 以下任务已恢复执行：

【任务】：${task.title}
【任务ID】：${task.id}
${badge ? `${badge}\n` : ""}请继续完成此任务。完成后调用 submit_task_result 提交结果。`;
}

/** Build the next-task prompt returned in submit_task_result content. */
export function buildNextTaskPrompt(task: TaskNode): string {
	const context = task.context && task.context.trim().length > 0 ? task.context : "（无前置上下文）";
	const badge = kindBadge(task);
	return `[系统调度器]: 任务已记录。

【当前分配给你的新任务】：${task.title}
【任务ID】：${task.id}
【任务类型】：${task.kind}${badge ? `\n${badge}` : ""}
【任务描述】：${task.description}
【前置任务传来的上下文】：${context}
${boundaryBlock(task)}
请先调用 assess_task 评估。完成后调用 submit_task_result${task.kind === "spike" ? "（或 submit_spike_result 输出客观事实）" : ""}。`;
}

/** Build the DAG completion summary. */
export function buildCompletionPrompt(state: DagState): string {
	let done = 0;
	let failed = 0;
	for (const task of Object.values(state.tasks)) {
		if (task.status === "DONE") done++;
		else if (task.status === "FAILED") failed++;
	}
	return `Agile-DAG 全部任务完成。共 ${Object.keys(state.tasks).length} 个任务，${done} 个成功，${failed} 个失败。`;
}
