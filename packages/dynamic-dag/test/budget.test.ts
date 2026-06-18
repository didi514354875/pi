import { describe, expect, it } from "vitest";
import { assignBudget, budgetStatusPrompt, consumeBudget } from "../src/budget.ts";
import type { DagState, TaskNode } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskNode> & Pick<TaskNode, "id">): TaskNode {
	return {
		id: overrides.id,
		title: overrides.title ?? "Test Task",
		description: overrides.description ?? "",
		status: overrides.status ?? "RUNNING",
		kind: overrides.kind ?? "standard",
		complexity: overrides.complexity ?? 1,
		risk: overrides.risk ?? 1,
		confidence: overrides.confidence ?? 8,
		dependsOn: overrides.dependsOn ?? [],
		parentId: overrides.parentId ?? null,
		childrenIds: overrides.childrenIds ?? [],
		context: overrides.context ?? "",
		resultSummary: overrides.resultSummary ?? null,
		iteration: overrides.iteration ?? 1,
		verifyRetries: overrides.verifyRetries ?? 0,
		decomposeRetries: overrides.decomposeRetries ?? 0,
		boundary: overrides.boundary ?? "",
		spikeForTaskId: overrides.spikeForTaskId ?? null,
		proposedTargetFiles: overrides.proposedTargetFiles ?? [],
		budgetRemaining: overrides.budgetRemaining ?? null,
	};
}

function makeState(overrides?: Partial<DagState>): DagState {
	return {
		tasks: overrides?.tasks ?? {},
		rootTaskIds: overrides?.rootTaskIds ?? [],
		currentTaskId: overrides?.currentTaskId ?? null,
		totalIterations: overrides?.totalIterations ?? 0,
		facts: overrides?.facts ?? [],
		adrs: overrides?.adrs ?? [],
		paused: overrides?.paused ?? false,
	};
}

// ---------------------------------------------------------------------------
// assignBudget
// ---------------------------------------------------------------------------

describe("assignBudget", () => {
	it("assigns spike budget for complexity -1", () => {
		const result = assignBudget(-1);
		expect(result.maxToolCalls).toBe(10);
		expect(result.strategy).toBe("spike_readonly");
	});

	it("assigns trivial budget for complexity 1", () => {
		const result = assignBudget(1);
		expect(result.maxToolCalls).toBe(3);
		expect(result.strategy).toBe("trivial");
	});

	it("assigns small budget for complexity 3", () => {
		const result = assignBudget(3);
		expect(result.maxToolCalls).toBe(5);
		expect(result.strategy).toBe("small");
	});

	it("assigns medium budget for complexity 5", () => {
		const result = assignBudget(5);
		expect(result.maxToolCalls).toBe(15);
		expect(result.strategy).toBe("medium");
	});

	it("returns decompose_required for complexity 8", () => {
		const result = assignBudget(8);
		expect(result.maxToolCalls).toBe(0);
		expect(result.strategy).toBe("decompose_required");
	});

	it("returns decompose_required for complexity above threshold", () => {
		const result = assignBudget(10);
		expect(result.strategy).toBe("decompose_required");
	});

	it("falls back to small for unmapped complexity", () => {
		const result = assignBudget(4);
		expect(result.maxToolCalls).toBe(5);
		expect(result.strategy).toBe("small");
	});
});

// ---------------------------------------------------------------------------
// consumeBudget
// ---------------------------------------------------------------------------

describe("consumeBudget", () => {
	it("decrements budget and returns correct remaining", () => {
		const task = makeTask({ id: "T1", budgetRemaining: 5 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = consumeBudget(state);

		expect(result.remaining).toBe(4);
		expect(result.isLastCall).toBe(false);
		expect(result.isExhausted).toBe(false);
		expect(result.state.tasks.T1.budgetRemaining).toBe(4);
	});

	it("returns isLastCall true when budget reaches 1 after decrement", () => {
		const task = makeTask({ id: "T1", budgetRemaining: 2 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = consumeBudget(state);

		expect(result.remaining).toBe(1);
		expect(result.isLastCall).toBe(true);
		expect(result.isExhausted).toBe(false);
	});

	it("returns isExhausted true when budget reaches 0", () => {
		const task = makeTask({ id: "T1", budgetRemaining: 1 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = consumeBudget(state);

		expect(result.remaining).toBe(0);
		expect(result.isLastCall).toBe(false);
		expect(result.isExhausted).toBe(true);
	});

	it("returns isExhausted true when budget goes negative", () => {
		const task = makeTask({ id: "T1", budgetRemaining: 0 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = consumeBudget(state);

		expect(result.remaining).toBe(-1);
		expect(result.isLastCall).toBe(false);
		expect(result.isExhausted).toBe(true);
	});

	it("returns no-op when no current task", () => {
		const state = makeState({ currentTaskId: null });
		const result = consumeBudget(state);

		expect(result.remaining).toBe(0);
		expect(result.isLastCall).toBe(false);
		expect(result.isExhausted).toBe(false);
		expect(result.state).toBe(state);
	});

	it("returns no-op when task has null budget", () => {
		const task = makeTask({ id: "T1", budgetRemaining: null });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = consumeBudget(state);

		expect(result.remaining).toBe(0);
		expect(result.isLastCall).toBe(false);
		expect(result.isExhausted).toBe(false);
		expect(result.state).toBe(state);
	});

	it("returns no-op when currentTaskId points to nonexistent task", () => {
		const state = makeState({ currentTaskId: "T1" });
		const result = consumeBudget(state);

		expect(result.remaining).toBe(0);
		expect(result.state).toBe(state);
	});
});

// ---------------------------------------------------------------------------
// budgetStatusPrompt
// ---------------------------------------------------------------------------

describe("budgetStatusPrompt", () => {
	it("returns remaining budget count when > 1", () => {
		const task = makeTask({ id: "T1", budgetRemaining: 5 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = budgetStatusPrompt(state);

		expect(result).toContain("5");
		expect(result).not.toContain("最后通牒");
		expect(result).not.toContain("已耗尽");
	});

	it("returns last-call ultimatum when budget is 1", () => {
		const task = makeTask({ id: "T1", budgetRemaining: 1 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = budgetStatusPrompt(state);

		expect(result).toContain("最后通牒");
		expect(result).toContain("1");
	});

	it("returns exhausted message when budget is 0", () => {
		const task = makeTask({ id: "T1", budgetRemaining: 0 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = budgetStatusPrompt(state);

		expect(result).toContain("已耗尽");
	});

	it("returns exhausted message when budget is negative", () => {
		const task = makeTask({ id: "T1", budgetRemaining: -1 });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		const result = budgetStatusPrompt(state);

		expect(result).toContain("已耗尽");
	});

	it("returns empty string when no current task", () => {
		const state = makeState({ currentTaskId: null });
		expect(budgetStatusPrompt(state)).toBe("");
	});

	it("returns empty string when task has null budget", () => {
		const task = makeTask({ id: "T1", budgetRemaining: null });
		const state = makeState({ currentTaskId: "T1", tasks: { T1: task } });
		expect(budgetStatusPrompt(state)).toBe("");
	});

	it("returns empty string when currentTaskId points to nonexistent task", () => {
		const state = makeState({ currentTaskId: "T1" });
		expect(budgetStatusPrompt(state)).toBe("");
	});
});
