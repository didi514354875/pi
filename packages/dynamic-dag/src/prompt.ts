/**
 * System prompt and task-prompt builders.
 *
 * Implements the design spec's 3-tier KV-cache optimization:
 *   Tier 1 — static rules (cache-friendly: identical across every task)
 *   Tier 2 — low-frequency global blackboard (facts + ADRs)
 *   Tier 3 — high-frequency dynamic current-task block (<500 tokens)
 *
 * Per-role variants: Decomposer, Executor, Spiker, Architect.
 */
import { budgetStatusPrompt } from "./budget.ts";
import { DAG_VERIFY_CMD_ENV, type DagState, type TaskNode } from "./types.ts";

// ===========================================================================
// Tier 1 — static rules (cache-friendly: identical across every task)
// ===========================================================================

const ROLE_PERSONA = `# 角色设定

你是 Dynamic-DAG 系统中的一个**无状态工人 (Stateless Worker)**。你不需要记住全局任务列表、计划进度或之前的执行历史。后台的确定状态机会自动推送下一个最优任务给你。

你的职责是**完成当前任务，然后提交结果**。不要尝试规划未来步骤。`;

const WORKFLOW_RULES = `# 工作流原则（严格遵守）

1. **单任务聚焦**：当前提示中只包含一个任务。你只需要完成它。
2. **工具调用有限**：你有工具调用预算限制。每次调用工具都会消耗预算。预算耗尽后你只能提交结果。
3. **提交后停止**：调用 \`submit_task_result\` 后，你的工作就完成了。后台会自动推送下一个任务。
4. **不要自己规划**：不要尝试猜测下一步做什么。提交后，后台的 DAG 算法会自动选择最优任务。
5. **验证是强制性的**：\`submit_task_result(SUCCESS)\` 不是完成凭证——引擎会运行验证流水线（${DAG_VERIFY_CMD_ENV} 环境变量）来确认。验证失败将自动回滚。`;

const SPIKE_WORKFLOW_RULES = `# Spike 探索规则

你当前处于**只读模式**。你可以：
- 读取文件、搜索代码、查看项目结构
- 调用 \`spike_submit\` 提交收集到的事实

你**不能**：
- 修改、创建或删除任何文件
- 调用任何写入工具

目标：收集关于项目结构、技术栈、依赖关系的客观事实，写入全局事实库。`;

const DECOMPOSER_RULES = `# 任务拆解规则

你的职责是将复杂任务拆解为 $\\le 5$ 分的小任务。拆解时遵循：

1. **可解性**：每个子任务在划定的读写范围内是否具备工具可行性。
2. **完备性**：所有子任务的交付物聚合后是否能够 100% 覆盖父任务需求。
3. **非冗余性**：子任务间是否职责重合，是否存在多余、无意义的重复操作。
4. **I/O 契约有效性**：下游所需的 inputs 在前置任务的 outputs 中已被正确定义。

使用 \`decompose_task\` 工具提交拆解结果。拆解会经过 3 阶段审查（静态校验 → 架构师语义审查 → 拓扑排序），不通过会返回修改意见。`;

// ===========================================================================
// Tier 2 — low-frequency global blackboard (facts + ADRs)
// ===========================================================================

function renderFacts(state: DagState): string {
	if (state.facts.length === 0) return "";

	const validFacts = state.facts.filter((f) => f.status !== "EXPIRED");
	if (validFacts.length === 0) return "";

	const lines = ["## 全局事实库 (Global Facts)", ""];
	for (const fact of validFacts) {
		const conflict = fact.status === "CONFLICT" ? " [冲突]" : "";
		lines.push(`- **${fact.key}**: ${fact.value}${conflict} (置信度: ${fact.confidence.toFixed(1)})`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderAdrs(state: DagState): string {
	if (state.adrs.length === 0) return "";

	const lines = ["## 全局架构决策记录 (ADR)", ""];
	for (const adr of state.adrs) {
		lines.push(`- **${adr.title}**: ${adr.decision}`);
	}
	lines.push("");
	return lines.join("\n");
}

// ===========================================================================
// Tier 3 — high-frequency dynamic current-task block
// ===========================================================================

function kindBadge(task: TaskNode): string {
	switch (task.kind) {
		case "spike":
			return " [只读探索]";
		case "decompose":
			return " [任务拆解]";
		default:
			return "";
	}
}

function boundaryBlock(task: TaskNode): string {
	if (!task.boundary) return "";
	return `\n**操作边界**: 只能在以下文件范围内进行修改: \`${task.boundary}\``;
}

function buildTaskBlock(task: TaskNode): string {
	const badge = kindBadge(task);
	const boundary = boundaryBlock(task);

	let block = `## 当前任务: ${task.title}${badge}\n\n${task.description}${boundary}\n`;

	if (task.complexity > 0) {
		block += `\n- 复杂度: ${task.complexity}/10 | 风险: ${task.risk}/10 | 置信度: ${task.confidence}/10`;
	}

	if (task.context) {
		block += `\n\n### 上下文\n${task.context}`;
	}

	return block;
}

// ===========================================================================
// Prompt builders
// ===========================================================================

/** Build the system-prompt suffix injected before each agent start. */
export function buildDagSystemPrompt(state: DagState, task: TaskNode): string {
	const parts: string[] = [];

	// Tier 1 — static rules
	parts.push(ROLE_PERSONA);
	parts.push(WORKFLOW_RULES);

	if (task.kind === "spike") {
		parts.push(SPIKE_WORKFLOW_RULES);
	} else if (task.kind === "decompose") {
		parts.push(DECOMPOSER_RULES);
	}

	// Tier 2 — global blackboard
	const factsStr = renderFacts(state);
	if (factsStr) parts.push(factsStr);

	const adrsStr = renderAdrs(state);
	if (adrsStr) parts.push(adrsStr);

	// Tier 3 — dynamic current-task block
	const budgetStr = budgetStatusPrompt(state);
	if (budgetStr) parts.push(`\n${budgetStr}`);

	parts.push(buildTaskBlock(task));

	return parts.join("\n\n");
}

/** Build the first-task prompt sent after plan ingestion. */
export function buildFirstTaskPrompt(task: TaskNode): string {
	return `开始第一个任务：**${task.title}**

${task.description}

使用 \`assess_task\` 工具评估此任务的复杂度（1-10）、风险（1-10）、置信度（1-10），以及是否需要进行 Spike 探索。`;
}

/** Build a resume-execution prompt for a paused but already-scored task. */
export function buildResumePrompt(task: TaskNode): string {
	return `恢复执行任务：**${task.title}**

${task.description}

此任务已评估：复杂度 ${task.complexity} | 风险 ${task.risk} | 置信度 ${task.confidence}
请从上次中断的地方继续。`;
}

/** Build the next-task prompt returned in submit_task_result content. */
export function buildNextTaskPrompt(task: TaskNode): string {
	const badge = kindBadge(task);
	return `下一个任务：**${task.title}**${badge}

${task.description}`;
}

/** Build the DAG completion summary. */
export function buildCompletionPrompt(state: DagState): string {
	const total = Object.keys(state.tasks).length;
	const done = Object.values(state.tasks).filter((t) => t.status === "DONE").length;
	const failed = Object.values(state.tasks).filter((t) => t.status === "FAILED").length;

	return `## 🎉 DAG 执行完成

- 总任务数: ${total}
- 成功: ${done}
- 失败: ${failed}

所有任务已完成。感谢使用 Dynamic-DAG！`;
}
