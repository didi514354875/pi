/**
 * Tool-call budget enforcement.
 *
 * Provides the budget matrix mapping complexity → max tool calls, the consume
 * function that decrements and returns flags, and the ultimatum prompt injector.
 */
import { BUDGET_DECOMPOSE_THRESHOLD, BUDGET_MATRIX, type DagState } from "./types.ts";

// ===========================================================================
// Budget assignment
// ===========================================================================

export interface BudgetAssignment {
	maxToolCalls: number;
	strategy: string;
}

/**
 * Look up the budget tier for a given complexity score.
 * Returns null if complexity >= decompose threshold (should never execute directly).
 */
export function assignBudget(complexity: number): BudgetAssignment {
	if (complexity >= BUDGET_DECOMPOSE_THRESHOLD) {
		return { maxToolCalls: 0, strategy: "decompose_required" };
	}
	const tier = BUDGET_MATRIX[complexity];
	if (tier) return tier;
	// Fallback for unmapped scores: treat as small
	return { maxToolCalls: 5, strategy: "small" };
}

// ===========================================================================
// Budget consumption
// ===========================================================================

export interface BudgetConsumption {
	/** Updated state with the budget decremented. */
	state: DagState;
	/** Remaining calls after this decrement. */
	remaining: number;
	/** This was the penultimate call (budget now = 1). */
	isLastCall: boolean;
	/** Budget is exhausted (remaining = 0). */
	isExhausted: boolean;
}

/**
 * Consume one tool call from the current task's budget.
 * If no task is running or budget is null, returns a no-op with isExhausted = false.
 */
export function consumeBudget(state: DagState): BudgetConsumption {
	const taskId = state.currentTaskId;
	if (!taskId) {
		return { state, remaining: 0, isLastCall: false, isExhausted: false };
	}

	const task = state.tasks[taskId];
	if (!task || task.budgetRemaining === null) {
		return { state, remaining: 0, isLastCall: false, isExhausted: false };
	}

	const remaining = task.budgetRemaining - 1;
	const updatedTask = {
		...task,
		budgetRemaining: remaining,
	};

	const tasks = { ...state.tasks, [taskId]: updatedTask };

	return {
		state: { ...state, tasks },
		remaining,
		isLastCall: remaining === 1,
		isExhausted: remaining <= 0,
	};
}

// ===========================================================================
// Ultimatum prompt injector
// ===========================================================================

/**
 * Build the budget status line injected into Tier 3 of the prompt.
 * Returns empty string when no budget is active.
 */
export function budgetStatusPrompt(state: DagState): string {
	const taskId = state.currentTaskId;
	if (!taskId) return "";

	const task = state.tasks[taskId];
	if (!task || task.budgetRemaining === null) return "";

	const remaining = task.budgetRemaining;

	if (remaining <= 0) {
		return (
			"⚠️ **工具调用预算已耗尽！** 你只能调用 `submit_task_result(FAILED)` 提交失败。" + "任何其他工具调用将被拦截。"
		);
	}

	if (remaining === 1) {
		return (
			"⚠️ **最后通牒：仅剩 1 次工具调用。** 你必须在此次调用中通过 `submit_task_result` 提交最终结果。" +
			"成功则提交 SUCCESS，失败则提交 FAILED。"
		);
	}

	return `🔧 剩余工具调用预算: **${remaining}** 次`;
}
