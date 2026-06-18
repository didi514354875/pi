import { describe, expect, it } from "vitest";
import {
	type Assessment,
	adjustDag,
	applyAssessment,
	completeTaskSuccess,
	countTasks,
	decomposeTask,
	deriveSpike,
	finishedCount,
	handleTaskFailure,
	ingestPlan,
	isDagComplete,
	isTaskUnblocked,
	type ParsedTask,
	proposeAdr,
	pushNextToEstimate,
	recommendNextTask,
	startTask,
	submitSpikeResult,
	transitionToVerifying,
} from "../src/engine.ts";
import { DAG_MAX_VERIFY_RETRIES, type DagMutation, type DagState, type Fact } from "../src/types.ts";

// ===========================================================================
// Test helpers
// ===========================================================================

function emptyState(): DagState {
	return {
		tasks: {},
		rootTaskIds: [],
		currentTaskId: null,
		totalIterations: 0,
		facts: [],
		adrs: [],
		paused: false,
	};
}

function makePlan(n: number): ParsedTask[] {
	return Array.from({ length: n }, (_, i) => ({
		title: `Task ${i + 1}`,
		description: `Description ${i + 1}`,
		dependsOn: [],
		key: `T${i}`,
	}));
}

/**
 * Calls ingestPlan with a seed fact so the day-zero init spike is skipped.
 * Tests that don't test init-spike behavior use this to avoid the extra task.
 */
function seedState(planCount: number): DagState {
	const state: DagState = {
		tasks: {},
		rootTaskIds: [],
		currentTaskId: null,
		totalIterations: 0,
		facts: [
			{
				id: "F_seed",
				key: ".",
				value: "seed",
				source: "INIT",
				confidence: 0.9,
				evidencePaths: [],
				status: "VALID",
				createdAt: 0,
				updatedAt: 0,
			},
		],
		adrs: [],
		paused: false,
	};
	const ingested = ingestPlan(state, makePlan(planCount));
	// pushNextToEstimate to advance the first task to ESTIMATING for tests that
	// need assessment-ready state.
	return pushNextToEstimate(ingested);
}

/**
 * Full pipeline: seed → score → get a READY task.
 */
function seedAndScore(planCount: number, overrides?: Partial<Assessment>): { state: DagState; taskId: string } {
	const state = seedState(planCount);
	const taskId = state.currentTaskId!;
	const { state: scored } = applyAssessment(state, taskId, {
		complexity: 3,
		risk: 3,
		confidence: 8,
		is_spike: false,
		proposedTargetFiles: [],
		...overrides,
	});
	return { state: scored, taskId };
}

// ===========================================================================
// ingestPlan
// ===========================================================================

describe("ingestPlan", () => {
	it("creates root tasks from a single parsed task (no init spike when facts exist)", () => {
		const state: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "x",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const result = ingestPlan(state, makePlan(1));
		expect(countTasks(result)).toBe(1);
		expect(result.rootTaskIds).toHaveLength(1);
		expect(result.tasks[result.rootTaskIds[0]].status).toBe("CREATED");
		expect(result.currentTaskId).toBeNull();
	});

	it("creates N root tasks, all CREATED, currentTaskId null", () => {
		const state: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "x",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const result = ingestPlan(state, makePlan(3));
		expect(countTasks(result)).toBe(3);
		const statuses = result.rootTaskIds.map((id) => result.tasks[id].status);
		expect(statuses[0]).toBe("CREATED");
		expect(statuses[1]).toBe("CREATED");
		expect(statuses[2]).toBe("CREATED");
		expect(result.currentTaskId).toBeNull();
	});

	it("injects a day-zero init spike when facts are empty", () => {
		const state = ingestPlan(null, makePlan(2));
		expect(countTasks(state)).toBe(3); // 1 spike + 2 business
		const spikeTask = Object.values(state.tasks).find((t) => t.kind === "spike");
		expect(spikeTask).toBeDefined();
		expect(spikeTask!.status).toBe("READY");
		// Business tasks are CREATED
		const bizTasks = Object.values(state.tasks).filter((t) => t.kind === "standard");
		expect(bizTasks).toHaveLength(2);
		expect(bizTasks[0].status).toBe("CREATED");
		expect(bizTasks[1].status).toBe("CREATED");
	});

	it("skips init spike when facts already exist", () => {
		const state: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "x",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const result = ingestPlan(state, makePlan(2));
		expect(countTasks(result)).toBe(2);
		expect(result.tasks[result.rootTaskIds[0]].kind).toBe("standard");
	});

	it("resolves dependsOn keys to generated ids", () => {
		const plan: ParsedTask[] = [
			{ title: "A", description: "A", dependsOn: [], key: "T0" },
			{ title: "B", description: "B", dependsOn: ["T0"], key: "T1" },
		];
		const state: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "x",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const result = ingestPlan(state, plan);
		const taskB = result.tasks[result.rootTaskIds[1]];
		expect(taskB.dependsOn).toContain(result.rootTaskIds[0]);
	});
});

// ===========================================================================
// pushNextToEstimate
// ===========================================================================

describe("pushNextToEstimate", () => {
	it("moves first CREATED task to ESTIMATING and sets currentTaskId", () => {
		const state: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "x",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const ingested = ingestPlan(state, makePlan(2));
		const pushed = pushNextToEstimate(ingested);
		const firstId = pushed.rootTaskIds[0];
		expect(pushed.tasks[firstId].status).toBe("ESTIMATING");
		expect(pushed.currentTaskId).toBe(firstId);
	});

	it("does nothing when no CREATED tasks exist", () => {
		const state: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "x",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const pushed = pushNextToEstimate(state);
		expect(pushed.currentTaskId).toBeNull();
	});
});

// ===========================================================================
// applyAssessment
// ===========================================================================

describe("applyAssessment", () => {
	it("routes to ready when complexity < threshold and not a spike", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const {
			state: result,
			action,
			budget,
		} = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		});
		expect(action).toBe("ready");
		expect(result.tasks[taskId].status).toBe("READY");
		expect(result.tasks[taskId].complexity).toBe(3);
		expect(result.tasks[taskId].confidence).toBe(8);
		expect(result.tasks[taskId].budgetRemaining).toBeGreaterThan(0);
		expect(budget).toBeDefined();
		expect(budget!.strategy).toBe("small");
	});

	it("routes to decompose when complexity >= threshold", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: result, action } = applyAssessment(state, taskId, {
			complexity: 9,
			risk: 5,
			confidence: 5,
			is_spike: false,
			proposedTargetFiles: [],
		});
		expect(action).toBe("decompose");
		expect(result.tasks[taskId].status).toBe("DECOMPOSING");
	});

	it("routes to spike when is_spike is true", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: result, action } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 5,
			is_spike: true,
			proposedTargetFiles: [],
		});
		expect(action).toBe("spike");
		// Parent is BLOCKED
		expect(result.tasks[taskId].status).toBe("BLOCKED");
		// A spike child was derived
		const spikeChild = Object.values(result.tasks).find((t) => t.kind === "spike" && t.spikeForTaskId === taskId);
		expect(spikeChild).toBeDefined();
		expect(spikeChild!.status).toBe("READY");
	});

	it("no-ops when task is not in ESTIMATING status", () => {
		const state: DagState = {
			...emptyState(),
			tasks: {
				T_fake: {
					id: "T_fake",
					title: "x",
					description: "x",
					status: "CREATED",
					kind: "standard",
					complexity: 0,
					risk: 0,
					confidence: 0,
					dependsOn: [],
					parentId: null,
					childrenIds: [],
					context: "",
					resultSummary: null,
					iteration: 0,
					verifyRetries: 0,
					decomposeRetries: 0,
					boundary: "",
					spikeForTaskId: null,
					proposedTargetFiles: [],
					budgetRemaining: null,
				},
			},
		};
		const { state: result, action } = applyAssessment(state, "T_fake", {
			complexity: 3,
			risk: 3,
			confidence: 5,
			is_spike: false,
			proposedTargetFiles: [],
		});
		expect(action).toBe("ready");
		expect(result).toBe(state);
	});
});

// ===========================================================================
// decomposeTask
// ===========================================================================

describe("decomposeTask", () => {
	it("creates children, blocks parent, wires sequential deps", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		const result = decomposeTask(
			state,
			parentId,
			[
				{ title: "Child 1", description: "c1" },
				{ title: "Child 2", description: "c2" },
			],
			true,
		);

		expect(result.tasks[parentId].status).toBe("BLOCKED");
		expect(result.tasks[parentId].childrenIds).toHaveLength(2);

		const child1Id = result.tasks[parentId].childrenIds[0];
		const child2Id = result.tasks[parentId].childrenIds[1];

		expect(result.tasks[child1Id].status).toBe("CREATED");
		expect(result.tasks[child1Id].parentId).toBe(parentId);
		expect(result.tasks[child2Id].status).toBe("CREATED");
		expect(result.tasks[child2Id].parentId).toBe(parentId);

		// Sequential: child2 depends on child1
		expect(result.tasks[child2Id].dependsOn).toContain(child1Id);
	});

	it("does not wire sequential deps when isSequential is false", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		const result = decomposeTask(
			state,
			parentId,
			[
				{ title: "Child 1", description: "c1" },
				{ title: "Child 2", description: "c2" },
			],
			false,
		);

		const child2Id = result.tasks[parentId].childrenIds[1];
		expect(result.tasks[child2Id].dependsOn).not.toContain(result.tasks[parentId].childrenIds[0]);
	});

	it("is a no-op for non-existent parent", () => {
		const state = seedState(1);
		const result = decomposeTask(state, "T_nope", [{ title: "C1", description: "c1" }], false);
		expect(result).toBe(state);
	});

	it("resets currentTaskId to null", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		const result = decomposeTask(state, parentId, [{ title: "C1", description: "c1" }], false);
		expect(result.currentTaskId).toBeNull();
	});
});

// ===========================================================================
// startTask
// ===========================================================================

describe("startTask", () => {
	it("transitions READY → RUNNING and increments iteration", () => {
		const { state, taskId } = seedAndScore(1);
		const result = startTask(state, taskId);

		expect(result.tasks[taskId].status).toBe("RUNNING");
		expect(result.tasks[taskId].iteration).toBe(1);
		expect(result.currentTaskId).toBe(taskId);
	});

	it("does nothing for non-READY task", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		// Task is ESTIMATING, not READY
		const result = startTask(state, taskId);
		expect(result).toBe(state);
	});
});

// ===========================================================================
// transitionToVerifying + completeTaskSuccess
// ===========================================================================

describe("completeTaskSuccess", () => {
	it("VERIFYING → DONE and sets isComplete for single task", () => {
		const { state, taskId } = seedAndScore(1);
		const executing = startTask(state, taskId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskId]: { ...executing.tasks[taskId], resultSummary: "done" } },
		};
		const verifying = transitionToVerifying(withSummary, taskId);
		expect(verifying.tasks[taskId].status).toBe("VERIFYING");
		expect(verifying.tasks[taskId].budgetRemaining).toBeNull();

		const { state: newState, isComplete } = completeTaskSuccess(verifying, taskId);
		expect(newState.tasks[taskId].status).toBe("DONE");
		expect(newState.tasks[taskId].resultSummary).toBe("done");
		expect(isComplete).toBe(true);
	});

	it("propagates resultSummary from children to BLOCKED parent", () => {
		const { state, taskId: parentId } = seedAndScore(1, { complexity: 9 });
		// parent is DECOMPOSING, decompose it
		const decomposed = decomposeTask(state, parentId, [{ title: "C1", description: "c1" }], false);

		const childId = decomposed.tasks[parentId].childrenIds[0];
		const pushed = pushNextToEstimate(decomposed);
		const s1 = applyAssessment(pushed, childId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		}).state;
		const executing = startTask(s1, childId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [childId]: { ...executing.tasks[childId], resultSummary: "child done" } },
		};
		const { state: newState } = completeTaskSuccess(transitionToVerifying(withSummary, childId), childId);

		// resolveCompletedParents propagated child resultSummary to parent
		expect(newState.tasks[parentId].status).toBe("DONE");
		expect(newState.tasks[parentId].context).toContain("child done");
	});

	it("auto-completes BLOCKED parent when all children done", () => {
		const { state, taskId: parentId } = seedAndScore(1, { complexity: 9 });
		// parent is DECOMPOSING, decompose it
		const decomposed = decomposeTask(
			state,
			parentId,
			[
				{ title: "C1", description: "c1" },
				{ title: "C2", description: "c2" },
			],
			true,
		);

		const child1Id = decomposed.tasks[parentId].childrenIds[0];
		const child2Id = decomposed.tasks[parentId].childrenIds[1];

		// Push C1 to assessment, score, execute, complete
		let s = pushNextToEstimate(decomposed);
		s = applyAssessment(s, child1Id, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		}).state;
		s = startTask(s, child1Id);
		s = { ...s, tasks: { ...s.tasks, [child1Id]: { ...s.tasks[child1Id], resultSummary: "c1 done" } } };
		s = completeTaskSuccess(transitionToVerifying(s, child1Id), child1Id).state;

		// C2 should now be ESTIMATING (pushed by selectNextToDrive)
		expect(s.tasks[child2Id].status).toBe("ESTIMATING");

		// Complete C2
		s = applyAssessment(s, child2Id, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		}).state;
		s = startTask(s, child2Id);
		s = { ...s, tasks: { ...s.tasks, [child2Id]: { ...s.tasks[child2Id], resultSummary: "c2 done" } } };
		const { state: final, isComplete } = completeTaskSuccess(transitionToVerifying(s, child2Id), child2Id);

		expect(isComplete).toBe(true);
		expect(final.tasks[parentId].status).toBe("DONE");
		expect(final.tasks[parentId].context).toContain("c1 done");
		expect(final.tasks[parentId].context).toContain("c2 done");
	});
});

// ===========================================================================
// handleTaskFailure
// ===========================================================================

describe("handleTaskFailure", () => {
	it("retry under cap → task re-queued as READY with failure context", () => {
		const { state, taskId } = seedAndScore(1);
		const executing = startTask(state, taskId);
		const verifying = transitionToVerifying(executing, taskId);
		const { state: newState, nextTaskId } = handleTaskFailure(verifying, taskId, "verify failed");

		const failed = newState.tasks[taskId];
		expect(failed.status).toBe("READY");
		expect(failed.verifyRetries).toBe(1);
		expect(failed.context).toContain("[verify-fail #1]");
		expect(failed.context).toContain("verify failed");
		expect(nextTaskId).toBe(taskId); // selectNextToDrive picks it
	});

	it("terminal fail over cap → FAILED + cascade to dependents", () => {
		const plan: ParsedTask[] = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const base: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "seed",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const state = ingestPlan(base, plan);
		const pushed = pushNextToEstimate(state);
		const aId = pushed.currentTaskId!;
		const bId = Object.values(pushed.tasks).find((t) => t.title === "B")!.id;
		const { state: scored } = applyAssessment(pushed, aId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, aId);
		const atCap: DagState = {
			...executing,
			tasks: { ...executing.tasks, [aId]: { ...executing.tasks[aId], verifyRetries: DAG_MAX_VERIFY_RETRIES } },
		};
		const verifying = transitionToVerifying(atCap, aId);
		const { state: newState, isComplete } = handleTaskFailure(verifying, aId, "fatal");

		expect(newState.tasks[aId].status).toBe("FAILED");
		expect(newState.tasks[aId].verifyRetries).toBeGreaterThan(DAG_MAX_VERIFY_RETRIES);
		expect(newState.tasks[bId].status).toBe("FAILED");
		expect(newState.tasks[bId].resultSummary).toContain("级联失败");
		expect(isComplete).toBe(true);
	});
});

// ===========================================================================
// recommendNextTask
// ===========================================================================

describe("recommendNextTask", () => {
	it("spike task beats high-downstream task (W_SPIKE=100 dominates)", () => {
		const plan: ParsedTask[] = [
			{ title: "Spike", description: "s", dependsOn: [], key: "T0" },
			{ title: "Std", description: "x", dependsOn: [], key: "T1" },
			{ title: "D1", description: "d", dependsOn: ["T1"], key: "T2" },
			{ title: "D2", description: "d", dependsOn: ["T1"], key: "T3" },
			{ title: "D3", description: "d", dependsOn: ["T1"], key: "T4" },
			{ title: "D4", description: "d", dependsOn: ["T1"], key: "T5" },
			{ title: "D5", description: "d", dependsOn: ["T1"], key: "T6" },
		];
		const state = ingestPlan(null, plan);
		const spikeId = Object.values(state.tasks).find((t) => t.title === "Spike")!.id;
		const stdId = Object.values(state.tasks).find((t) => t.title === "Std")!.id;

		// Push both through assessment
		let s = pushNextToEstimate(state);
		s = applyAssessment(s, s.currentTaskId!, {
			complexity: 5,
			risk: 5,
			confidence: 5,
			is_spike: true,
			proposedTargetFiles: [],
		}).state;
		// Now the spike assessment blocked the parent and derived a READY spike child.
		// Find that spike child and make it READY.
		const spikeChild = Object.values(s.tasks).find((t) => t.kind === "spike" && t.spikeForTaskId === spikeId);
		// After is_spike assessment, the original is BLOCKED and a spike child is READY.
		// Also push the std task through.
		s = pushNextToEstimate(s);
		if (s.currentTaskId) {
			s = applyAssessment(s, s.currentTaskId!, {
				complexity: 5,
				risk: 5,
				confidence: 5,
				is_spike: false,
				proposedTargetFiles: [],
			}).state;
		}

		// Force both candidates to READY
		const spikeTarget = spikeChild ? spikeChild.id : spikeId;
		s = {
			...s,
			tasks: {
				...s.tasks,
				[spikeTarget]: { ...s.tasks[spikeTarget], kind: "spike", status: "READY" },
				[stdId]: { ...s.tasks[stdId], status: "READY" },
			},
			currentTaskId: null,
		};

		expect(recommendNextTask(s)).toBe(spikeTarget);
	});

	it("higher downstream wins when no spike", () => {
		const plan: ParsedTask[] = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: [], key: "T1" },
			{ title: "A1", description: "x", dependsOn: ["T0"], key: "T2" },
			{ title: "A2", description: "x", dependsOn: ["T0"], key: "T3" },
			{ title: "A3", description: "x", dependsOn: ["T0"], key: "T4" },
			{ title: "B1", description: "x", dependsOn: ["T1"], key: "T5" },
		];
		const base: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "seed",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const state = ingestPlan(base, plan);
		const aId = Object.values(state.tasks).find((t) => t.title === "A")!.id;
		const _bId = Object.values(state.tasks).find((t) => t.title === "B")!.id;

		let s = pushNextToEstimate(state);
		s = applyAssessment(s, s.currentTaskId!, {
			complexity: 3,
			risk: 2,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		}).state;

		s = pushNextToEstimate(s);
		s = applyAssessment(s, s.currentTaskId!, {
			complexity: 1,
			risk: 2,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		}).state;

		s = { ...s, currentTaskId: null };
		expect(recommendNextTask(s)).toBe(aId);
	});

	it("lower complexity wins on downstream tie", () => {
		const plan: ParsedTask[] = [
			{ title: "Lo", description: "l", dependsOn: [], key: "T0" },
			{ title: "Hi", description: "h", dependsOn: [], key: "T1" },
		];
		const base: DagState = {
			tasks: {},
			rootTaskIds: [],
			currentTaskId: null,
			totalIterations: 0,
			facts: [
				{
					id: "F0",
					key: ".",
					value: "seed",
					source: "INIT",
					confidence: 0.9,
					evidencePaths: [],
					status: "VALID",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			adrs: [],
			paused: false,
		};
		const state = ingestPlan(base, plan);
		const loId = Object.values(state.tasks).find((t) => t.title === "Lo")!.id;
		const hiId = Object.values(state.tasks).find((t) => t.title === "Hi")!.id;

		let s = pushNextToEstimate(state);
		s = applyAssessment(s, s.currentTaskId!, {
			complexity: 2,
			risk: 2,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		}).state;
		// Force Hi to READY (complexity=8 routes to decompose, so skip assessment)
		s = {
			...s,
			tasks: { ...s.tasks, [hiId]: { ...s.tasks[hiId], status: "READY", complexity: 8 } },
			currentTaskId: null,
		};
		expect(recommendNextTask(s)).toBe(loId);
	});

	it("returns null when no READY tasks", () => {
		const state = seedState(1);
		expect(recommendNextTask(state)).toBeNull();
	});
});

// ===========================================================================
// isDagComplete
// ===========================================================================

describe("isDagComplete", () => {
	it("returns false when tasks remain active", () => {
		const state = seedState(2);
		expect(isDagComplete(state)).toBe(false);
	});

	it("returns true when all tasks DONE/FAILED", () => {
		const { state, taskId } = seedAndScore(1);
		const executing = startTask(state, taskId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskId]: { ...executing.tasks[taskId], resultSummary: "ok" } },
		};
		const { state: done } = completeTaskSuccess(transitionToVerifying(withSummary, taskId), taskId);
		expect(isDagComplete(done)).toBe(true);
	});
});

// ===========================================================================
// adjustDag
// ===========================================================================

describe("adjustDag", () => {
	it("adds a new task with valid deps", () => {
		const state = seedState(1);
		const existingId = state.currentTaskId!;
		const mutation: DagMutation = {
			action: "add",
			tasks: [{ title: "New", description: "desc", dependsOn: [existingId] }],
			reason: "executor discovered sub-problem",
		};
		const { result, state: newState } = adjustDag(state, mutation);
		expect(result.accepted).toBe(true);
		expect(result.newTaskIds).toHaveLength(1);
		const newId = result.newTaskIds![0];
		expect(newState.tasks[newId].title).toBe("New");
		expect(newState.tasks[newId].dependsOn).toContain(existingId);
	});

	it("rejects add with non-existent dep", () => {
		const state = seedState(1);
		const mutation: DagMutation = {
			action: "add",
			tasks: [{ title: "New", description: "desc", dependsOn: ["T_nonexistent"] }],
			reason: "test",
		};
		const { result } = adjustDag(state, mutation);
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain("不存在");
	});

	it("removes an unstarted leaf task with no dependents", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const mutation: DagMutation = {
			action: "remove",
			taskId,
			reason: "no longer needed",
		};
		const { result, state: newState } = adjustDag(state, mutation);
		expect(result.accepted).toBe(true);
		expect(newState.tasks[taskId].status).toBe("FAILED");
	});

	it("rejects remove of task with dependents", () => {
		const plan: ParsedTask[] = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const pushed = pushNextToEstimate(state);
		const aId = pushed.currentTaskId!;
		const mutation: DagMutation = {
			action: "remove",
			taskId: aId,
			reason: "test",
		};
		const { result } = adjustDag(pushed, mutation);
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain("依赖");
	});

	it("splits a task into children with sequential wiring", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		const mutation: DagMutation = {
			action: "split",
			parentId,
			tasks: [
				{ title: "Part 1", description: "p1", dependsOn: [] },
				{ title: "Part 2", description: "p2", dependsOn: [] },
			],
			reason: "executor realized subtasks",
		};
		const { result, state: newState } = adjustDag(state, mutation);
		expect(result.accepted).toBe(true);
		expect(result.newTaskIds).toHaveLength(2);
		expect(newState.tasks[parentId].status).toBe("BLOCKED");
		expect(newState.tasks[parentId].childrenIds).toContain(result.newTaskIds![0]);
		expect(newState.tasks[parentId].childrenIds).toContain(result.newTaskIds![1]);

		// Second child depends on first (sequential)
		expect(newState.tasks[result.newTaskIds![1]].dependsOn).toContain(result.newTaskIds![0]);
	});

	it("rejects split with fewer than 2 tasks", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		const mutation: DagMutation = {
			action: "split",
			parentId,
			tasks: [{ title: "Solo", description: "s", dependsOn: [] }],
			reason: "test",
		};
		const { result } = adjustDag(state, mutation);
		expect(result.accepted).toBe(false);
	});
});

// ===========================================================================
// submitSpikeResult
// ===========================================================================

describe("submitSpikeResult", () => {
	it("merges facts into the blackboard and unblocks the parent", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		// Derive a spike from the parent
		const spiked = deriveSpike(state, parentId);
		const spikeId = Object.values(spiked.tasks).find((t) => t.kind === "spike")!.id;
		// Start the spike so it's RUNNING before submit
		const spikeStarted = startTask(spiked, spikeId);

		const { state: after, nextTaskId: _nextTaskId } = submitSpikeResult(spikeStarted, spikeId, [
			{ key: "DB", value: "MySQL", confidence: 0.9, evidencePaths: [] },
			{ key: "framework", value: "FastAPI", confidence: 0.8, evidencePaths: [] },
		]);
		expect(after.tasks[spikeId].status).toBe("DONE");
		expect(after.facts.find((f: Fact) => f.key === "DB")?.value).toBe("MySQL");
		expect(after.facts.find((f: Fact) => f.key === "framework")?.value).toBe("FastAPI");
		expect(after.tasks[parentId].status).toBe("ESTIMATING");
	});

	it("rejects a non-spike task id", () => {
		const { state, taskId } = seedAndScore(1);
		const { state: after, nextTaskId } = submitSpikeResult(state, taskId, [
			{ key: "x", value: "y", confidence: 0.5, evidencePaths: [] },
		]);
		expect(nextTaskId).toBeNull();
		expect(after).toBe(state);
	});
});

// ===========================================================================
// Additional helpers
// ===========================================================================

describe("finishedCount", () => {
	it("counts DONE and FAILED tasks", () => {
		const state = seedState(1);
		expect(finishedCount(state)).toBe(0);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, taskId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskId]: { ...executing.tasks[taskId], resultSummary: "ok" } },
		};
		const { state: done } = completeTaskSuccess(transitionToVerifying(withSummary, taskId), taskId);
		expect(finishedCount(done)).toBe(1);
	});
});

describe("isTaskUnblocked", () => {
	it("returns true for task with no dependencies", () => {
		const state = seedState(1);
		expect(isTaskUnblocked(state, state.rootTaskIds[0])).toBe(true);
	});

	it("returns false when a dependency is not DONE", () => {
		const plan: ParsedTask[] = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const bId = Object.values(state.tasks).find((t) => t.title === "B")!.id;
		expect(isTaskUnblocked(state, bId)).toBe(false);
	});

	it("returns true when all dependencies are DONE", () => {
		const plan: ParsedTask[] = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const pushed = pushNextToEstimate(state);
		const aId = pushed.currentTaskId!;
		const { state: scored } = applyAssessment(pushed, aId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			is_spike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, aId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [aId]: { ...executing.tasks[aId], resultSummary: "ok" } },
		};
		const { state: done } = completeTaskSuccess(transitionToVerifying(withSummary, aId), aId);
		const bId = Object.values(done.tasks).find((t) => t.title === "B")!.id;
		expect(isTaskUnblocked(done, bId)).toBe(true);
	});
});

describe("proposeAdr", () => {
	it("appends an ADR entry to the global blackboard", () => {
		const state = seedState(1);
		const result = proposeAdr(state, "Use PostgreSQL", "We chose PG for its JSONB support.");
		expect(result.adrs).toHaveLength(1);
		expect(result.adrs[0].title).toBe("Use PostgreSQL");
		expect(result.adrs[0].decision).toBe("We chose PG for its JSONB support.");
	});
});

describe("countTasks", () => {
	it("returns total number of tasks", () => {
		const state = seedState(3);
		expect(countTasks(state)).toBe(3);
	});
});
