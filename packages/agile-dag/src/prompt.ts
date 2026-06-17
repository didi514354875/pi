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
import { DAG_POKER_THRESHOLD, type DagState, type TaskNode } from "./types.ts";

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
- 越界即失败：严格遵守当前任务的 Boundary Redline（若存在）。`;

const WORKFLOW_RULES = `# 工作流原则（严格遵守）
当你接收到后台发来的新任务时，你必须遵循以下敏捷工作流：

1. 第一步：敏捷扑克评估 (Play Poker)
   - 任何新任务，必须先调用 play_agile_poker 工具打分。
   - 点数规则：1(极简), 2, 3(常规), 5(偏复杂), 8(庞大), 13(极其模糊)。
   - 特殊牌：-1 = Spike 探针卡。任务处于黑盒状态时打 -1，触发只读探索。
   - 红线警告：点数 >= ${DAG_POKER_THRESHOLD} 的任务属于"史诗任务(Epic)"，你绝对不能直接执行！

2. 第二步：强制拆解 (Decompose)
   - 如果系统因点数过高拦截了你，你必须调用 decompose_task，将大任务拆分为一系列点数 <= 5 的子任务。
   - 跨模块需求：第一个子任务应标记 kind="contract"（设计契约），其产出作为下游强制输入上下文。
   - 执行中发现任务比预估的复杂，也可以调用 decompose_task 中途拆解。
   - 拆解会经过架构师评审节点；若被驳回，按指导意见修正后重新拆解。

3. 第三步：探针与事实 (Spike & Facts)
   - 若你打出了 -1，系统会派生一个只读 Spike 前置任务。Spike 期间禁止 edit/write，只能用 read/search 等只读工具探索。
   - 探索完成后调用 submit_spike_result 输出客观事实 Key-Value（如 数据库=MySQL）。绝对禁止输出 TODO 或主观规划。

4. 第四步：专注执行 (Execute)
   - 当任务被系统标记为 READY，你可以自由使用你的其他工具（bash, read, edit, write 等）去解决问题。
   - 任务描述末尾若带 <boundary_redline>，只允许触碰其中声明的范围，越界判定失败。

5. 第五步：打勾交付 (Submit)
   - 任务一旦完成，立即调用 submit_task_result 提炼核心结论（≤200字）。
   - 失败时用 status=FAILED 提交错误摘要；引擎会在干净上下文中派生修复任务。
   - 遇重大技术选型，可随时调用 propose_adr 写入全局架构决策黑板，后续任务将默认携带该规则。
   - 不要自己去猜下一步做什么！提交后，后台的 DAG 算法会自动把下一个最优任务喂给你。`;

// ===========================================================================
// Tier 2 — low-frequency global blackboard (facts + ADRs)
// ===========================================================================

function renderFacts(state: DagState): string {
	const entries = Object.entries(state.facts);
	if (entries.length === 0) return "";
	const lines = entries.map(([k, v]) => `- ${k} = ${v}`).join("\n");
	return `<global_facts>\n${lines}\n</global_facts>\n`;
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
		case "bugfix":
			return "【Bug 修复：在干净上下文中修复失败任务的错误】";
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
	const contextBlock =
		task.context && task.context.trim().length > 0
			? `<task_context>\n${task.context}\n</task_context>`
			: "<task_context>（无前置上下文）</task_context>";

	return `<current_task>
${badge ? `${badge}\n` : ""}${task.title}
</current_task>
<task_id>${task.id}</task_id>
<task_kind>${task.kind}</task_kind>
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
	return `Agile-DAG 模式已激活。后端 DAG 引擎已接管任务状态管理。

【当前分配给你的新任务】：${task.title}
【任务ID】：${task.id}
【任务类型】：${task.kind}${badge ? `\n${badge}` : ""}
【任务描述】：${task.description}
${boundaryBlock(task)}
你必须先调用 play_agile_poker 评估复杂度。点数 >= ${DAG_POKER_THRESHOLD} 的任务会被强制要求拆解；黑盒任务可打 -1 触发 Spike 探针。`;
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
请先调用 play_agile_poker 评估。完成后调用 submit_task_result${task.kind === "spike" ? "（或 submit_spike_result 输出客观事实）" : ""}。`;
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
