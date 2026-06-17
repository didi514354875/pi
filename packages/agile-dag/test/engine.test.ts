import { describe, expect, it } from "vitest";
import {
	applyPokerScore,
	countTasks,
	createSpikeTask,
	decomposeTask,
	finishedCount,
	ingestPlan,
	isDagComplete,
	isTaskUnblocked,
	proposeAdr,
	pushNextToEstimate,
	selectNextBestTask,
	startExecution,
	submitResult,
	submitSpikeResult,
} from "../src/engine.ts";
import type { DagState } from "../src/types.ts";
import { DAG_MAX_FIX_DEPTH } from "../src/types.ts";

function makePlan(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		title: `Task ${i + 1}`,
		description: `Description ${i + 1}`,
		dependsOn: [],
		key: `T${i}`,
	}));
}

describe("ingestPlan", () => {
	it("creates root tasks from a single parsed task", () => {
		const state = ingestPlan(null, makePlan(1));
		expect(countTasks(state)).toBe(1);
		expect(state.rootTaskIds).toHaveLength(1);
		expect(state.tasks[state.rootTaskIds[0]].status).toBe("ESTIMATING");
		expect(state.currentTaskId).toBe(state.rootTaskIds[0]);
	});

	it("creates N root tasks, first is ESTIMATING, rest TODO", () => {
		const state = ingestPlan(null, makePlan(3));
		expect(countTasks(state)).toBe(3);
		const statuses = state.rootTaskIds.map((id) => state.tasks[id].status);
		expect(statuses[0]).toBe("ESTIMATING");
		expect(statuses[1]).toBe("TODO");
		expect(statuses[2]).toBe("TODO");
		expect(state.currentTaskId).toBe(state.rootTaskIds[0]);
	});

	it("resolves dependsOn keys to generated ids", () => {
		const plan = [
			{ title: "A", description: "A", dependsOn: [], key: "T0" },
			{ title: "B", description: "B", dependsOn: ["T0"], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const taskB = state.tasks[state.rootTaskIds[1]];
		expect(taskB.dependsOn).toEqual([state.rootTaskIds[0]]);
	});
});

describe("pushNextToEstimate", () => {
	it("does nothing when currentTaskId is already set", () => {
		const state = ingestPlan(null, makePlan(2));
		const before = state.currentTaskId;
		const after = pushNextToEstimate(state);
		expect(after.currentTaskId).toBe(before);
	});

	it("pushes next unblocked TODO task", () => {
		const state = ingestPlan(null, makePlan(2));
		// Manually clear currentTaskId to simulate a submit that left a gap.
		const cleared: DagState = { ...state, currentTaskId: null };
		const pushed = pushNextToEstimate(cleared);
		expect(pushed.currentTaskId).toBeTruthy();
	});
});

describe("applyPokerScore", () => {
	it("scores < threshold → action ready, task READY", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: newState, action } = applyPokerScore(state, taskId, 5);
		expect(action).toBe("ready");
		expect(newState.tasks[taskId].status).toBe("READY");
		expect(newState.tasks[taskId].storyPoints).toBe(5);
	});

	it("scores >= threshold → action decompose, stays ESTIMATING", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: newState, action } = applyPokerScore(state, taskId, 8);
		expect(action).toBe("decompose");
		expect(newState.tasks[taskId].status).toBe("ESTIMATING");
	});

	it("scores 13 → action decompose", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { action } = applyPokerScore(state, taskId, 13);
		expect(action).toBe("decompose");
	});

	it("scores -1 (Spike) → action spike, task stays ESTIMATING", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: newState, action } = applyPokerScore(state, taskId, -1);
		expect(action).toBe("spike");
		// applyPokerScore only records the score; createSpikeTask mutates structure.
		expect(newState.tasks[taskId].status).toBe("ESTIMATING");
		expect(newState.tasks[taskId].storyPoints).toBe(-1);
	});

	it("returns action ready for non-existent task", () => {
		const state = ingestPlan(null, makePlan(1));
		const { state: newState, action } = applyPokerScore(state, "T_nope", 3);
		expect(action).toBe("ready");
		expect(newState).toBe(state);
	});
});

describe("decomposeTask", () => {
	it("sequential children are chained, parent BLOCKED", () => {
		const state = ingestPlan(null, makePlan(1));
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

		// Sequential: child[1] depends on child[0], child[2] depends on child[1]
		const sorted = childTasks.sort((a, b) => a.title.localeCompare(b.title));
		expect(sorted[1].dependsOn).toContain(sorted[0].id);
		expect(sorted[2].dependsOn).toContain(sorted[1].id);

		// First child should be ESTIMATING (it's unblocked since it has no done-deps)
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
		// Score the root so it's not estimating, then decompose
		const { state: scored } = applyPokerScore(state, parentId, 13);
		state = scored;

		const children = [
			{ title: "P1", description: "p1" },
			{ title: "P2", description: "p2" },
		];
		const newState = decomposeTask(state, parentId, children, false);

		const childTasks = Object.values(newState.tasks).filter((t) => t.parentId === parentId);
		// Parallel children should not depend on each other
		expect(childTasks[0].dependsOn).not.toContain(childTasks[1].id);
		expect(childTasks[1].dependsOn).not.toContain(childTasks[0].id);
	});

	it("does nothing with empty children array", () => {
		const state = ingestPlan(null, makePlan(1));
		const newState = decomposeTask(state, state.currentTaskId!, [], true);
		expect(newState).toBe(state);
	});
	it("can decompose an IN_PROGRESS task mid-execution", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		// Score low so it becomes READY, then start execution
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		expect(executing.tasks[taskId].status).toBe("IN_PROGRESS");

		// Now decompose mid-execution
		const children = [
			{ title: "Part A", description: "a" },
			{ title: "Part B", description: "b" },
		];
		const newState = decomposeTask(executing, taskId, children, true);

		// Parent should be BLOCKED, first child should be ESTIMATING
		expect(newState.tasks[taskId].status).toBe("BLOCKED");
		expect(newState.currentTaskId).toBeTruthy();
		expect(newState.tasks[newState.currentTaskId!].parentId).toBe(taskId);
	});
});

describe("startExecution", () => {
	it("transitions READY → IN_PROGRESS and increments iteration", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const newState = startExecution(scored, taskId);
		expect(newState.tasks[taskId].status).toBe("IN_PROGRESS");
		expect(newState.tasks[taskId].iteration).toBe(1);
		expect(newState.currentTaskId).toBe(taskId);
		expect(newState.totalIterations).toBe(1);
	});

	it("does nothing for non-READY task", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const newState = startExecution(state, taskId);
		expect(newState).toBe(state);
	});
});

describe("submitResult", () => {
	it("marks task DONE and sets resultSummary", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		const { state: newState, isComplete } = submitResult(executing, taskId, "SUCCESS", "done", false);

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
		const { state: scored } = applyPokerScore(state, taskAId, 3);
		const executing = startExecution(scored, taskAId);
		const { state: newState } = submitResult(executing, taskAId, "SUCCESS", "A completed", false);

		const taskB = newState.tasks[newState.rootTaskIds[1]];
		expect(taskB.context).toContain("A completed");
	});

	it("FAILED (fixDepth < cap) → BLOCKED + bugfix derivation, not terminal", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		const { state: newState, nextTaskId, isComplete } = submitResult(executing, taskId, "FAILED", "broke", false);
		// Failed task is frozen (BLOCKED), not terminal FAILED.
		expect(newState.tasks[taskId].status).toBe("BLOCKED");
		// A bugfix child is derived and driven next.
		const bugfix = nextTaskId ? newState.tasks[nextTaskId] : undefined;
		expect(bugfix).toBeDefined();
		expect(bugfix!.kind).toBe("bugfix");
		expect(bugfix!.fixDepth).toBe(1);
		expect(newState.tasks[taskId].dependsOn).toContain(bugfix!.id);
		expect(isComplete).toBe(false);
	});

	it("needNewTasks=true → nextTaskId null, not complete", () => {
		const plan = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: [], key: "T1" },
		];
		const state = ingestPlan(null, plan);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		const { nextTaskId, isComplete } = submitResult(executing, taskId, "SUCCESS", "done", true);
		expect(nextTaskId).toBeNull();
		expect(isComplete).toBe(false);
	});

	it("auto-completes BLOCKED parent when all children done", () => {
		const state = ingestPlan(null, makePlan(1));
		const parentId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, parentId, 13);
		const decomposed = decomposeTask(
			scored,
			parentId,
			[
				{ title: "C1", description: "c1" },
				{ title: "C2", description: "c2" },
			],
			true,
		);

		// Complete first child
		const child1Id = decomposed.currentTaskId!;
		const { state: s1 } = applyPokerScore(decomposed, child1Id, 3);
		const s2 = startExecution(s1, child1Id);
		const { state: s3 } = submitResult(s2, child1Id, "SUCCESS", "c1 done", false);

		// Complete second child
		const child2Id = s3.currentTaskId!;
		const { state: s4 } = applyPokerScore(s3, child2Id, 3);
		const s5 = startExecution(s4, child2Id);
		const { state: s6, isComplete } = submitResult(s5, child2Id, "SUCCESS", "c2 done", false);

		expect(isComplete).toBe(true);
		expect(s6.tasks[parentId].status).toBe("DONE");
		expect(s6.tasks[parentId].resultSummary).toContain("c1 done");
		expect(s6.tasks[parentId].resultSummary).toContain("c2 done");
	});
});

describe("selectNextBestTask", () => {
	it("picks READY task with most dependents", () => {
		// A is depended on by B and C; D is standalone. A should win.
		const plan = [
			{ title: "A", description: "a", dependsOn: [], key: "T0" },
			{ title: "B", description: "b", dependsOn: ["T0"], key: "T1" },
			{ title: "C", description: "c", dependsOn: ["T0"], key: "T2" },
			{ title: "D", description: "d", dependsOn: [], key: "T3" },
		];
		let state = ingestPlan(null, plan);
		// Score all tasks to READY first (need to advance through them)
		const ids = [...state.rootTaskIds];
		// Score the current one, then manually make others READY
		for (const id of ids) {
			const task = state.tasks[id];
			if (task.status === "ESTIMATING" || task.status === "TODO") {
				const { state: scored } = applyPokerScore(state, id, 3);
				state = scored;
			}
		}
		// A should have 2 dependents, D has 0
		const best = selectNextBestTask(state);
		expect(best).toBe(state.rootTaskIds[0]);
	});

	it("returns null when no READY tasks", () => {
		const state = ingestPlan(null, makePlan(1));
		expect(selectNextBestTask(state)).toBeNull();
	});

	it("tie-break is stable (insertion order)", () => {
		// Two standalone READY tasks with same points — first inserted wins.
		const plan = [
			{ title: "X", description: "x", dependsOn: [], key: "T0" },
			{ title: "Y", description: "y", dependsOn: [], key: "T1" },
		];
		let state = ingestPlan(null, plan);
		for (const id of [...state.rootTaskIds]) {
			const task = state.tasks[id];
			if (task.status === "ESTIMATING" || task.status === "TODO") {
				const { state: scored } = applyPokerScore(state, id, 3);
				state = scored;
			}
		}
		const best = selectNextBestTask(state);
		expect(best).toBe(state.rootTaskIds[0]);
	});
});

describe("isTaskUnblocked", () => {
	it("returns true for task with no dependencies", () => {
		const state = ingestPlan(null, makePlan(1));
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
		const { state: scored } = applyPokerScore(state, taskAId, 3);
		const executing = startExecution(scored, taskAId);
		const { state: done } = submitResult(executing, taskAId, "SUCCESS", "ok", false);
		expect(isTaskUnblocked(done, done.rootTaskIds[1])).toBe(true);
	});
});

describe("isDagComplete", () => {
	it("returns false when tasks remain active", () => {
		const state = ingestPlan(null, makePlan(2));
		expect(isDagComplete(state)).toBe(false);
	});

	it("returns true when all tasks DONE/FAILED", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		const { state: done } = submitResult(executing, taskId, "SUCCESS", "ok", false);
		expect(isDagComplete(done)).toBe(true);
	});
});

describe("finishedCount", () => {
	it("counts DONE and FAILED tasks", () => {
		const state = ingestPlan(null, makePlan(1));
		expect(finishedCount(state)).toBe(0);
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		const { state: done } = submitResult(executing, taskId, "SUCCESS", "ok", false);
		expect(finishedCount(done)).toBe(1);
	});
});

describe("createSpikeTask", () => {
	it("freezes the original BLOCKED, derives a Spike IN_PROGRESS, wires dep", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const spiked = createSpikeTask(state, taskId);

		// Original is frozen.
		expect(spiked.tasks[taskId].status).toBe("BLOCKED");
		// Spike is current and already IN_PROGRESS (skips Agile Poker — it's a probe).
		expect(spiked.currentTaskId).toBeTruthy();
		expect(spiked.currentTaskId).not.toBe(taskId);
		const spike = spiked.tasks[spiked.currentTaskId!];
		expect(spike.kind).toBe("spike");
		expect(spike.status).toBe("IN_PROGRESS");
		expect(spike.spikeForTaskId).toBe(taskId);
		// Original now depends on the Spike.
		expect(spiked.tasks[taskId].dependsOn).toContain(spike.id);
	});

	it("is a no-op for a non-existent task", () => {
		const state = ingestPlan(null, makePlan(1));
		expect(createSpikeTask(state, "T_nope")).toBe(state);
	});
});

describe("submitSpikeResult", () => {
	it("merges facts into the blackboard and unblocks the original task", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const spiked = createSpikeTask(state, taskId);
		const spikeId = spiked.currentTaskId!;
		// Spike is already IN_PROGRESS (createSpikeTask skips Agile Poker).

		const { state: after, nextTaskId } = submitSpikeResult(spiked, spikeId, { DB: "MySQL", framework: "FastAPI" });
		// Spike closed.
		expect(after.tasks[spikeId].status).toBe("DONE");
		// Facts merged into global blackboard.
		expect(after.facts.DB).toBe("MySQL");
		expect(after.facts.framework).toBe("FastAPI");
		// Original task released back to ESTIMATING.
		expect(nextTaskId).toBe(taskId);
		expect(after.tasks[taskId].status).toBe("ESTIMATING");
		// Fact summary propagated into the original task's context.
		expect(after.tasks[taskId].context).toContain("MySQL");
	});

	it("rejects a non-spike task id", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: after, nextTaskId } = submitSpikeResult(state, taskId, { x: "y" });
		expect(nextTaskId).toBeNull();
		expect(after).toBe(state);
	});
});

describe("submitResult fail-fix depth cap", () => {
	it("FAILED at fixDepth >= cap → terminal FAILED, no bugfix derived", () => {
		// Hand-build a state where the current task is already at max fix depth.
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		const capped: DagState = {
			...executing,
			tasks: { ...executing.tasks, [taskId]: { ...executing.tasks[taskId], fixDepth: DAG_MAX_FIX_DEPTH } },
		};
		const { state: newState, nextTaskId } = submitResult(capped, taskId, "FAILED", "broke again", false);
		expect(newState.tasks[taskId].status).toBe("FAILED");
		expect(nextTaskId).toBeNull();
		// No bugfix child created.
		const bugfixChildren = Object.values(newState.tasks).filter((t) => t.kind === "bugfix");
		expect(bugfixChildren).toHaveLength(0);
	});

	it("bugfix completion unblocks the failed task back to ESTIMATING", () => {
		const state = ingestPlan(null, makePlan(1));
		const taskId = state.currentTaskId!;
		const { state: scored } = applyPokerScore(state, taskId, 3);
		const executing = startExecution(scored, taskId);
		const { state: failed, nextTaskId: bugfixId } = submitResult(executing, taskId, "FAILED", "broke", false);
		expect(bugfixId).toBeTruthy();
		// Score + execute the bugfix, then submit SUCCESS.
		const bugScored = applyPokerScore(failed, bugfixId!, 3).state;
		const bugExec = startExecution(bugScored, bugfixId!);
		const { state: after, nextTaskId } = submitResult(bugExec, bugfixId!, "SUCCESS", "fixed", false);
		// Bugfix DONE; original task is no longer BLOCKED — it re-enters ESTIMATING.
		expect(after.tasks[bugfixId!].status).toBe("DONE");
		expect(after.tasks[taskId].status).toBe("ESTIMATING");
		expect(nextTaskId).toBe(taskId);
	});
});

describe("proposeAdr", () => {
	it("appends an ADR entry to the global blackboard", () => {
		const state = ingestPlan(null, makePlan(1));
		expect(state.adrs).toHaveLength(0);
		const withAdr = proposeAdr(state, "统一鉴权", "使用 JWT");
		expect(withAdr.adrs).toHaveLength(1);
		expect(withAdr.adrs[0].title).toBe("统一鉴权");
		expect(withAdr.adrs[0].decision).toBe("使用 JWT");
		expect(withAdr.adrs[0].id).toMatch(/^ADR_/);
		// Does not mutate the original state.
		expect(state.adrs).toHaveLength(0);
	});
});

describe("cascadeTerminalFailure (Bug A)", () => {
	it("B depends on A, A terminally FAILED → B also FAILED", () => {
		const state = ingestPlan(null, [
			{ title: "A", description: "a", dependsOn: [], key: "KA" },
			{ title: "B", description: "b", dependsOn: ["KA"], key: "KB" },
		]);
		const aId = state.currentTaskId!;
		const bId = Object.keys(state.tasks).find((id) => id !== aId)!;
		// Force A to max fix depth so FAILED is terminal.
		const capped = { ...state, tasks: { ...state.tasks, [aId]: { ...state.tasks[aId], fixDepth: 2 } } };
		const scored = applyPokerScore(capped, aId, 3).state;
		const executing = startExecution(scored, aId);
		const result = submitResult(executing, aId, "FAILED", "unrecoverable", false);
		expect(result.state.tasks[aId].status).toBe("FAILED");
		expect(result.state.tasks[bId].status).toBe("FAILED");
		expect(result.isComplete).toBe(true);
	});

	it("A fail-fix eligible (fixDepth < cap) → A BLOCKED, bugfix derived, no cascade to B", () => {
		const state = ingestPlan(null, [
			{ title: "A", description: "a", dependsOn: [], key: "KA" },
			{ title: "B", description: "b", dependsOn: ["KA"], key: "KB" },
		]);
		const aId = state.currentTaskId!;
		const bId = Object.keys(state.tasks).find((id) => id !== aId)!;
		const scored = applyPokerScore(state, aId, 3).state;
		const executing = startExecution(scored, aId);
		const result = submitResult(executing, aId, "FAILED", "fixable", false);
		expect(result.state.tasks[aId].status).toBe("BLOCKED");
		expect(result.state.tasks[bId].status).not.toBe("FAILED");
		expect(result.nextTaskId).not.toBeNull();
		const bugfix = result.state.tasks[result.nextTaskId!];
		expect(bugfix.kind).toBe("bugfix");
	});

	it("transitive cascade: A FAILED → B (depends on A) → C (depends on B) all FAILED", () => {
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
		const capped = { ...state, tasks: { ...state.tasks, [aId]: { ...state.tasks[aId], fixDepth: 2 } } };
		const scored = applyPokerScore(capped, aId, 3).state;
		const executing = startExecution(scored, aId);
		const result = submitResult(executing, aId, "FAILED", "fatal", false);
		expect(result.state.tasks[aId].status).toBe("FAILED");
		expect(result.state.tasks[bId].status).toBe("FAILED");
		expect(result.state.tasks[cId].status).toBe("FAILED");
		expect(result.isComplete).toBe(true);
	});
});
