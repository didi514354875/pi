import { describe, expect, it } from "vitest";
import {
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
	proposeAdr,
	pushNextToAssess,
	recommendNextTask,
	startTask,
	submitSpikeResult,
	transitionToVerifying,
} from "../src/engine.ts";
import type { DagState } from "../src/types.ts";
import { DAG_MAX_VERIFY_RETRIES } from "../src/types.ts";

function makePlan(n: number) {
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
	return ingestPlan(
		{
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
		},
		makePlan(planCount),
	);
}
describe("ingestPlan", () => {
	it("creates root tasks from a single parsed task (no init spike when facts exist)", () => {
		const state = seedState(1);
		expect(countTasks(state)).toBe(1);
		expect(state.rootTaskIds).toHaveLength(1);
		expect(state.tasks[state.rootTaskIds[0]].status).toBe("CREATED");
		expect(state.currentTaskId).toBe(state.rootTaskIds[0]);
	});

	it("creates N root tasks, first is current (CREATED), rest CREATED", () => {
		const state = seedState(3);
		expect(countTasks(state)).toBe(3);
		const statuses = state.rootTaskIds.map((id) => state.tasks[id].status);
		expect(statuses[0]).toBe("CREATED");
		expect(statuses[1]).toBe("CREATED");
		expect(statuses[2]).toBe("CREATED");
		expect(state.currentTaskId).toBe(state.rootTaskIds[0]);
	});

	it("injects a day-zero init spike when facts are empty", () => {
		const state = ingestPlan(null, makePlan(2));
		expect(countTasks(state)).toBe(3); // 1 spike + 2 business
		// spike is first in rootTaskIds, business tasks follow
		const spikeTask = state.tasks[state.rootTaskIds[0]];
		expect(spikeTask.kind).toBe("spike");
		expect(spikeTask.status).toBe("RUNNING"); // started via selectNextToDrive
		// Business tasks are CREATED and blocked by spike
		const biz1 = state.tasks[state.rootTaskIds[1]];
		const biz2 = state.tasks[state.rootTaskIds[2]];
		expect(biz1.status).toBe("CREATED");
		expect(biz2.status).toBe("CREATED");
		expect(biz1.dependsOn).toContain(spikeTask.id);
		expect(biz2.dependsOn).toContain(spikeTask.id);
		expect(state.currentTaskId).toBe(spikeTask.id);
	});

	it("skips init spike when facts already exist", () => {
		const state = seedState(2);
		expect(countTasks(state)).toBe(2);
		expect(state.tasks[state.rootTaskIds[0]].kind).toBe("standard");
	});

	it("resolves dependsOn keys to generated ids", () => {
		const plan = [
			{ title: "A", description: "A", dependsOn: [], key: "T0" },
			{ title: "B", description: "B", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const taskB = state.tasks[state.rootTaskIds[1]];
		expect(taskB.dependsOn).toContain(state.rootTaskIds[0]);
	});
});

describe("pushNextToAssess", () => {
	it("does nothing when currentTaskId is already set", () => {
		const state = seedState(2);
		const before = state.currentTaskId;
		const after = pushNextToAssess(state);
		expect(after.currentTaskId).toBe(before);
	});

	it("pushes next unblocked CREATED task", () => {
		const state = seedState(2);
		const cleared: DagState = { ...state, currentTaskId: null };
		const pushed = pushNextToAssess(cleared);
		expect(pushed.currentTaskId).toBeTruthy();
	});
});

describe("applyAssessment", () => {
	it("low complexity → action ready, task READY", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: newState, action } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		expect(action).toBe("ready");
		expect(newState.tasks[taskId].status).toBe("READY");
		expect(newState.tasks[taskId].complexity).toBe(3);
		expect(newState.tasks[taskId].risk).toBe(3);
		expect(newState.tasks[taskId].confidence).toBe(8);
	});

	it("complexity > threshold → action decompose, stays CREATED", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: newState, action } = applyAssessment(state, taskId, {
			complexity: 9,
			risk: 5,
			confidence: 5,
			isSpike: false,
			proposedTargetFiles: [],
		});
		expect(action).toBe("decompose");
		expect(newState.tasks[taskId].status).toBe("CREATED");
	});

	it("complexity == threshold (8) → action ready (boundary is strictly-greater)", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { action } = applyAssessment(state, taskId, {
			complexity: 8,
			risk: 5,
			confidence: 5,
			isSpike: false,
			proposedTargetFiles: [],
		});
		expect(action).toBe("ready");
	});

	it("isSpike=true → action spike, task stays CREATED", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: newState, action } = applyAssessment(state, taskId, {
			complexity: 10,
			risk: 10,
			confidence: 1,
			isSpike: true,
			proposedTargetFiles: [],
		});
		expect(action).toBe("spike");
		// applyAssessment records values only; deriveSpike mutates structure.
		expect(newState.tasks[taskId].status).toBe("CREATED");
		expect(newState.tasks[taskId].complexity).toBe(10);
	});

	it("returns action ready for non-existent task", () => {
		const state = seedState(1);
		const { state: newState, action } = applyAssessment(state, "T_nope", {
			complexity: 3,
			risk: 3,
			confidence: 3,
			isSpike: false,
			proposedTargetFiles: [],
		});
		expect(action).toBe("ready");
		expect(newState).toBe(state);
	});
});

describe("decomposeTask", () => {
	it("sequential children are chained, parent BLOCKED", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		const children = [
			{ title: "Sub A", description: "a" },
			{ title: "Sub B", description: "b" },
			{ title: "Sub C", description: "c" },
		];
		const newState = decomposeTask(state, parentId, children, true);

		expect(newState.tasks[parentId].status).toBe("BLOCKED");

		const childTasks = Object.values(newState.tasks).filter((t) => t.parentId === parentId);
		expect(childTasks).toHaveLength(3);
		// Children start as CREATED.
		expect(childTasks.every((c) => c.status === "CREATED")).toBe(true);

		const sorted = childTasks.sort((a, b) => a.title.localeCompare(b.title));
		expect(sorted[1].dependsOn).toContain(sorted[0].id);
		expect(sorted[2].dependsOn).toContain(sorted[1].id);

		expect(newState.currentTaskId).toBeTruthy();
		expect(newState.tasks[newState.currentTaskId!].parentId).toBe(parentId);
	});

	it("parallel children all inherit parent dependsOn", () => {
		const plan = [
			{ title: "Root", description: "root", dependsOn: [], key: "T0" },
			{ title: "Dep", description: "dep", dependsOn: ["T0"], key: "T1" },
		];
		let state = ingestPlan(null, plan);
		const parentId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, parentId, {
			complexity: 9,
			risk: 5,
			confidence: 5,
			isSpike: false,
			proposedTargetFiles: [],
		});
		state = scored;

		const children = [
			{ title: "P1", description: "p1" },
			{ title: "P2", description: "p2" },
		];
		const newState = decomposeTask(state, parentId, children, false);

		const childTasks = Object.values(newState.tasks).filter((t) => t.parentId === parentId);
		expect(childTasks[0].dependsOn).not.toContain(childTasks[1].id);
		expect(childTasks[1].dependsOn).not.toContain(childTasks[0].id);
	});

	it("does nothing with empty children array", () => {
		const state = seedState(1);
		const newState = decomposeTask(state, state.currentTaskId!, [], true);
		expect(newState).toBe(state);
	});

	it("can decompose a RUNNING task mid-execution", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, taskId);
		expect(executing.tasks[taskId].status).toBe("RUNNING");

		const children = [
			{ title: "Part A", description: "a" },
			{ title: "Part B", description: "b" },
		];
		const newState = decomposeTask(executing, taskId, children, true);

		expect(newState.tasks[taskId].status).toBe("BLOCKED");
		expect(newState.currentTaskId).toBeTruthy();
		expect(newState.tasks[newState.currentTaskId!].parentId).toBe(taskId);
	});
});

describe("startTask", () => {
	it("transitions READY → RUNNING and increments iteration", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const newState = startTask(scored, taskId);
		expect(newState.tasks[taskId].status).toBe("RUNNING");
		expect(newState.tasks[taskId].iteration).toBe(1);
		expect(newState.currentTaskId).toBe(taskId);
		expect(newState.totalIterations).toBe(1);
	});

	it("does nothing for non-READY task", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const newState = startTask(state, taskId);
		expect(newState).toBe(state);
	});
});

describe("transitionToVerifying + completeTaskSuccess", () => {
	it("SUCCESS → VERIFYING → DONE and sets resultSummary", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, taskId);
		// Pre-set the summary (as the tools layer does before transitioning).
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskId]: { ...executing.tasks[taskId], resultSummary: "done" } },
		};
		const verifying = transitionToVerifying(withSummary, taskId);
		expect(verifying.tasks[taskId].status).toBe("VERIFYING");
		const { state: newState, isComplete } = completeTaskSuccess(verifying, taskId);
		expect(newState.tasks[taskId].status).toBe("DONE");
		expect(newState.tasks[taskId].resultSummary).toBe("done");
		expect(isComplete).toBe(true);
	});

	it("propagates resultSummary to successor context", () => {
		const plan = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const taskAId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskAId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, taskAId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskAId]: { ...executing.tasks[taskAId], resultSummary: "A completed" } },
		};
		const verifying = transitionToVerifying(withSummary, taskAId);
		const { state: newState } = completeTaskSuccess(verifying, taskAId);

		const taskB = newState.tasks[newState.rootTaskIds[1]];
		expect(taskB.context).toContain("A completed");
	});

	it("auto-completes BLOCKED parent when all children done", () => {
		const state = seedState(1);
		const parentId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, parentId, {
			complexity: 9,
			risk: 5,
			confidence: 5,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const decomposed = decomposeTask(
			scored,
			parentId,
			[
				{ title: "C1", description: "c1" },
				{ title: "C2", description: "c2" },
			],
			true,
		);

		// Complete first child.
		const child1Id = decomposed.currentTaskId!;
		const s1 = applyAssessment(decomposed, child1Id, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		}).state;
		const s2 = startTask(s1, child1Id);
		const s2s: DagState = {
			...s2,
			tasks: { ...s2.tasks, [child1Id]: { ...s2.tasks[child1Id], resultSummary: "c1 done" } },
		};
		const s3 = completeTaskSuccess(transitionToVerifying(s2s, child1Id), child1Id).state;

		// Complete second child.
		const child2Id = s3.currentTaskId!;
		const s4 = applyAssessment(s3, child2Id, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		}).state;
		const s5 = startTask(s4, child2Id);
		const s5s: DagState = {
			...s5,
			tasks: { ...s5.tasks, [child2Id]: { ...s5.tasks[child2Id], resultSummary: "c2 done" } },
		};
		const { state: s6, isComplete } = completeTaskSuccess(transitionToVerifying(s5s, child2Id), child2Id);

		expect(isComplete).toBe(true);
		expect(s6.tasks[parentId].status).toBe("DONE");
		expect(s6.tasks[parentId].resultSummary).toContain("c1 done");
		expect(s6.tasks[parentId].resultSummary).toContain("c2 done");
	});
});

describe("handleTaskFailure retry", () => {
	it("retryCount < cap → task re-queued for retry with failure context", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, taskId);
		const verifying = transitionToVerifying(executing, taskId);
		const { state: newState, nextTaskId } = handleTaskFailure(verifying, taskId, "verify failed");
		const failed = newState.tasks[taskId];
		// Non-terminal failure: task is re-queued for a direct retry (auto-started
		// to RUNNING) with the failure context appended.
		expect(failed.retryCount).toBe(1);
		expect(failed.context).toContain("[verify-fail #1]");
		expect(failed.context).toContain("verify failed");
		expect(nextTaskId).toBe(taskId);
		expect(failed.status).toBe("RUNNING");
	});

	it("retryCount >= cap → terminal FAILED + cascade to dependents", () => {
		const plan = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const aId = state.currentTaskId!;
		const bId = Object.keys(state.tasks).find((id) => id !== aId)!;
		const { state: scored } = applyAssessment(state, aId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, aId);
		// Pre-set retryCount to cap-1 so one more failure hits the cap.
		const atCap: DagState = {
			...executing,
			tasks: { ...executing.tasks, [aId]: { ...executing.tasks[aId], retryCount: DAG_MAX_VERIFY_RETRIES - 1 } },
		};
		const verifying = transitionToVerifying(atCap, aId);
		const { state: newState, isComplete } = handleTaskFailure(verifying, aId, "fatal");
		expect(newState.tasks[aId].status).toBe("FAILED");
		expect(newState.tasks[aId].retryCount).toBe(DAG_MAX_VERIFY_RETRIES);
		expect(newState.tasks[bId].status).toBe("FAILED");
		expect(isComplete).toBe(true);
	});
});

describe("recommendNextTask heuristic formula", () => {
	it("spike task beats high-downstream task (W_SPIKE=100 dominates)", () => {
		// Two READY tasks: a spike (downstream=0) and a standard (downstream=5).
		// spike:  15*0 + 100 - 5*5 + 2*5 = 85
		// std:    15*5 + 0   - 5*5 + 2*5 = 60
		const plan = [
			{ title: "Spike", description: "s", dependsOn: [], key: "T0" },
			{ title: "Std", description: "x", dependsOn: [], key: "T1" },
			{ title: "D1", description: "d", dependsOn: ["T1"], key: "T2" },
			{ title: "D2", description: "d", dependsOn: ["T1"], key: "T3" },
			{ title: "D3", description: "d", dependsOn: ["T1"], key: "T4" },
			{ title: "D4", description: "d", dependsOn: ["T1"], key: "T5" },
			{ title: "D5", description: "d", dependsOn: ["T1"], key: "T6" },
		];
		const state = ingestPlan(null, plan);
		const spikeId = state.rootTaskIds[0];
		const stdId = state.rootTaskIds[1];
		// Force both candidates to READY. The spike uses isSpike=true but
		// applyAssessment leaves a spike candidate CREATED (deriveSpike is what
		// promotes it to READY), so set status directly to model the READY spike.
		let s = state;
		for (const id of [spikeId, stdId]) {
			s = applyAssessment(s, id, {
				complexity: 5,
				risk: 5,
				confidence: 5,
				isSpike: id === spikeId,
				proposedTargetFiles: [],
			}).state;
		}
		s = {
			...s,
			tasks: {
				...s.tasks,
				[spikeId]: { ...s.tasks[spikeId], kind: "spike", status: "READY" },
				[stdId]: { ...s.tasks[stdId], status: "READY" },
			},
			currentTaskId: null,
		};
		expect(recommendNextTask(s)).toBe(spikeId);
	});

	it("higher downstream wins when no spike", () => {
		// A(downstream=3,complexity=3) vs B(downstream=1,complexity=1)
		// A: 15*3 - 5*3 + 2*8 = 51
		// B: 15*1 - 5*1 + 2*8 = 26
		const plan = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: [], key: "T1" },
			{ title: "A1", description: "x", dependsOn: ["T0"], key: "T2" },
			{ title: "A2", description: "x", dependsOn: ["T0"], key: "T3" },
			{ title: "A3", description: "x", dependsOn: ["T0"], key: "T4" },
			{ title: "B1", description: "x", dependsOn: ["T1"], key: "T5" },
		];
		const state = ingestPlan(null, plan);
		const aId = state.rootTaskIds[0];
		const bId = state.rootTaskIds[1];
		let s = state;
		for (const id of [aId, bId]) {
			s = applyAssessment(s, id, {
				complexity: id === aId ? 3 : 1,
				risk: 2,
				confidence: 8,
				isSpike: false,
				proposedTargetFiles: [],
			}).state;
		}
		s = { ...s, currentTaskId: null };
		expect(recommendNextTask(s)).toBe(aId);
	});

	it("lower complexity wins on downstream tie", () => {
		// Two downstream=0 tasks: complexity 2 vs 8.
		// lo:  0 - 5*2 + 2*8 = 6
		// hi:  0 - 5*8 + 2*8 = -24
		const plan = [
			{ title: "Lo", description: "l", dependsOn: [], key: "T0" },
			{ title: "Hi", description: "h", dependsOn: [], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const loId = state.rootTaskIds[0];
		const hiId = state.rootTaskIds[1];
		let s = state;
		for (const id of [loId, hiId]) {
			s = applyAssessment(s, id, {
				complexity: id === loId ? 2 : 8,
				risk: 2,
				confidence: 8,
				isSpike: false,
				proposedTargetFiles: [],
			}).state;
		}
		s = { ...s, currentTaskId: null };
		expect(recommendNextTask(s)).toBe(loId);
	});

	it("returns null when no READY tasks", () => {
		const state = seedState(1);
		expect(recommendNextTask(state)).toBeNull();
	});
});

describe("isTaskUnblocked", () => {
	it("returns true for task with no dependencies", () => {
		const state = seedState(1);
		expect(isTaskUnblocked(state, state.rootTaskIds[0])).toBe(true);
	});

	it("returns false when a dependency is not DONE", () => {
		const plan = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		expect(isTaskUnblocked(state, state.rootTaskIds[1])).toBe(false);
	});

	it("returns true when all dependencies are DONE", () => {
		const plan = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const taskAId = state.rootTaskIds[0];
		const { state: scored } = applyAssessment(state, taskAId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, taskAId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskAId]: { ...executing.tasks[taskAId], resultSummary: "ok" } },
		};
		const { state: done } = completeTaskSuccess(transitionToVerifying(withSummary, taskAId), taskAId);
		expect(isTaskUnblocked(done, done.rootTaskIds[1])).toBe(true);
	});
});

describe("isDagComplete", () => {
	it("returns false when tasks remain active", () => {
		const state = seedState(2);
		expect(isDagComplete(state)).toBe(false);
	});

	it("returns true when all tasks DONE/FAILED", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, taskId);
		const withSummary: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskId]: { ...executing.tasks[taskId], resultSummary: "ok" } },
		};
		const { state: done } = completeTaskSuccess(transitionToVerifying(withSummary, taskId), taskId);
		expect(isDagComplete(done)).toBe(true);
	});
});

describe("finishedCount", () => {
	it("counts DONE and FAILED tasks", () => {
		const state = seedState(1);
		expect(finishedCount(state)).toBe(0);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyAssessment(state, taskId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
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

describe("deriveSpike", () => {
	it("freezes the original BLOCKED, derives a Spike READY, wires dep", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const spiked = deriveSpike(state, taskId);

		expect(spiked.tasks[taskId].status).toBe("BLOCKED");
		const spike = Object.values(spiked.tasks).find((t) => t.kind === "spike")!;
		expect(spike).toBeDefined();
		expect(spike.status).toBe("READY");
		expect(spike.spikeForTaskId).toBe(taskId);
		expect(spike.complexity).toBe(5);
		expect(spiked.tasks[taskId].dependsOn).toContain(spike.id);
	});

	it("is a no-op for a non-existent task", () => {
		const state = seedState(1);
		expect(deriveSpike(state, "T_nope")).toBe(state);
	});
});

describe("submitSpikeResult", () => {
	it("merges facts into the blackboard and unblocks the original task", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const spiked = deriveSpike(state, taskId);
		const spikeId = Object.values(spiked.tasks).find((t) => t.kind === "spike")!.id;
		// Start the spike so it's RUNNING before submit.
		const spikeStarted = startTask(spiked, spikeId);

		const { state: after, nextTaskId } = submitSpikeResult(spikeStarted, spikeId, [
			{ key: "DB", value: "MySQL" },
			{ key: "framework", value: "FastAPI" },
		]);
		expect(after.tasks[spikeId].status).toBe("DONE");
		expect(after.facts.find((f) => f.key === "DB")?.value).toBe("MySQL");
		expect(after.facts.find((f) => f.key === "framework")?.value).toBe("FastAPI");
		// Original task released back to CREATED (awaiting re-assessment).
		expect(nextTaskId).toBe(taskId);
		expect(after.tasks[taskId].status).toBe("CREATED");
		expect(after.tasks[taskId].context).toContain("MySQL");
	});

	it("rejects a non-spike task id", () => {
		const state = seedState(1);
		const taskId = state.currentTaskId!;
		const { state: after, nextTaskId } = submitSpikeResult(state, taskId, [{ key: "x", value: "y" }]);
		expect(nextTaskId).toBeNull();
		expect(after).toBe(state);
	});
});

describe("proposeAdr", () => {
	it("appends an ADR entry to the global blackboard", () => {
		const state = seedState(1);
		expect(state.adrs).toHaveLength(0);
		const withAdr = proposeAdr(state, "统一鉴权", "使用 JWT");
		expect(withAdr.adrs).toHaveLength(1);
		expect(withAdr.adrs[0].title).toBe("统一鉴权");
		expect(withAdr.adrs[0].decision).toBe("使用 JWT");
		expect(withAdr.adrs[0].id).toMatch(/^ADR_/);
		expect(state.adrs).toHaveLength(0);
	});
});

describe("cascadeTerminalFailure", () => {
	it("terminal FAILED → dependent also FAILED", () => {
		const state = ingestPlan(null, [
			{ title: "A", description: "a", dependsOn: [], key: "KA" },
			{ title: "B", description: "b", dependsOn: ["KA"], key: "KB" },
		]);
		const aId = state.currentTaskId!;
		const bId = Object.keys(state.tasks).find((id) => id !== aId)!;
		// Pre-set retryCount so the failure is terminal.
		const { state: scored } = applyAssessment(state, aId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, aId);
		const atCap: DagState = {
			...executing,
			tasks: { ...executing.tasks, [aId]: { ...executing.tasks[aId], retryCount: DAG_MAX_VERIFY_RETRIES - 1 } },
		};
		const result = handleTaskFailure(transitionToVerifying(atCap, aId), aId, "unrecoverable");
		expect(result.state.tasks[aId].status).toBe("FAILED");
		expect(result.state.tasks[bId].status).toBe("FAILED");
		expect(result.isComplete).toBe(true);
	});

	it("non-terminal failure → task re-queued RUNNING for retry, no cascade to dependents", () => {
		const state = ingestPlan(null, [
			{ title: "A", description: "a", dependsOn: [], key: "KA" },
			{ title: "B", description: "b", dependsOn: ["KA"], key: "KB" },
		]);
		const aId = state.currentTaskId!;
		const bId = Object.keys(state.tasks).find((id) => id !== aId)!;
		const { state: scored } = applyAssessment(state, aId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, aId);
		const result = handleTaskFailure(transitionToVerifying(executing, aId), aId, "fixable");
		expect(result.state.tasks[aId].status).toBe("RUNNING");
		expect(result.state.tasks[aId].retryCount).toBe(1);
		expect(result.state.tasks[bId].status).not.toBe("FAILED");
	});

	it("transitive cascade: A FAILED → B → C all FAILED", () => {
		const state = ingestPlan(null, [
			{ title: "A", description: "a", dependsOn: [], key: "KA" },
			{ title: "B", description: "b", dependsOn: ["KA"], key: "KB" },
			{ title: "C", description: "c", dependsOn: ["KB"], key: "KC" },
		]);
		const aId = state.currentTaskId!;
		const ids = Object.keys(state.tasks);
		const bId = ids.find(
			(id) => id !== aId && state.tasks[id].dependsOn.length === 1 && state.tasks[id].dependsOn[0] === aId,
		)!;
		const cId = ids.find((id) => id !== aId && id !== bId)!;
		const { state: scored } = applyAssessment(state, aId, {
			complexity: 3,
			risk: 3,
			confidence: 8,
			isSpike: false,
			proposedTargetFiles: [],
		});
		const executing = startTask(scored, aId);
		const atCap: DagState = {
			...executing,
			tasks: { ...executing.tasks, [aId]: { ...executing.tasks[aId], retryCount: DAG_MAX_VERIFY_RETRIES - 1 } },
		};
		const result = handleTaskFailure(transitionToVerifying(atCap, aId), aId, "fatal");
		expect(result.state.tasks[aId].status).toBe("FAILED");
		expect(result.state.tasks[bId].status).toBe("FAILED");
		expect(result.state.tasks[cId].status).toBe("FAILED");
		expect(result.isComplete).toBe(true);
	});
});
