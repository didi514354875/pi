/**
 * Pure DAG state-machine functions.
 *
 * No Pi API dependency — fully testable in isolation. Every function returns a
 * new DagState (immutable update) or a result tuple; none mutate the input.
 */
import { randomUUID } from "node:crypto";
import type { ParsedTask } from "./parser.ts";
import {
	type AdrEntry,
	DAG_MAX_FIX_DEPTH,
	DAG_POKER_THRESHOLD,
	type DagState,
	isTaskActive,
	type StoryPoints,
	type TaskKind,
	type TaskNode,
	type TaskStatus,
} from "./types.ts";

/** Context cap (chars) appended to a successor when a predecessor completes. */
const RESULT_CONTEXT_CAP = 200;
/** Max accumulated context length per task. */
const CONTEXT_CAP = 500;

/** Generate a unique task id, collision-checked against the existing nodes. */
function generateTaskId(tasks: Record<string, TaskNode>): string {
	for (let i = 0; i < 100; i++) {
		const id = `T_${randomUUID().slice(0, 8)}`;
		if (!tasks[id]) return id;
	}
	return `T_${randomUUID()}`;
}

/** Count how many tasks depend on `taskId`. */
function countDependents(state: DagState, taskId: string): number {
	let count = 0;
	for (const task of Object.values(state.tasks)) {
		if (task.dependsOn.includes(taskId)) count++;
	}
	return count;
}

/**
 * Create root tasks from parsed plan input.
 *
 * Resolves sibling `key` references in each ParsedTask.dependsOn to generated
 * task ids, then pushes the first unblocked TODO task to ESTIMATING.
 */
export function ingestPlan(state: DagState | null, plan: ParsedTask[]): DagState {
	const base = normalizeState(state);
	const tasks: Record<string, TaskNode> = { ...base.tasks };
	const keyToId = new Map<string, string>();
	const created: { id: string; dependsOnKeys: string[] }[] = [];

	for (const parsed of plan) {
		const id = generateTaskId(tasks);
		tasks[id] = {
			id,
			title: parsed.title,
			description: parsed.description,
			status: "TODO",
			storyPoints: null,
			dependsOn: [],
			parentId: null,
			context: "",
			resultSummary: null,
			iteration: 0,
			kind: "standard",
			boundary: "",
			spikeForTaskId: null,
			fixDepth: 0,
		};
		keyToId.set(parsed.key, id);
		created.push({ id, dependsOnKeys: parsed.dependsOn });
	}

	for (const { id, dependsOnKeys } of created) {
		const resolved: string[] = [];
		for (const key of dependsOnKeys) {
			const depId = keyToId.get(key);
			if (depId && depId !== id) resolved.push(depId);
		}
		tasks[id] = { ...tasks[id], dependsOn: resolved };
	}

	const rootTaskIds = [...base.rootTaskIds, ...created.map((c) => c.id)];
	const newState: DagState = {
		tasks,
		rootTaskIds,
		currentTaskId: null,
		totalIterations: base.totalIterations,
		facts: base.facts,
		adrs: base.adrs,
	};
	return pushNextToEstimate(newState);
}

/**
 * Ensure a (possibly older) DagState carries the blackboard fields.
 * Restored sessions pre-dating facts/adrs get empty defaults; tasks missing
 * the new discriminator fields are backfilled so downstream code can rely on them.
 */
export function normalizeState(state: DagState | null): DagState {
	if (!state) return emptyBlackboardlessState();
	const tasks = { ...state.tasks };
	for (const [id, task] of Object.entries(tasks)) {
		if (
			task.kind === undefined ||
			task.boundary === undefined ||
			task.spikeForTaskId === undefined ||
			task.fixDepth === undefined
		) {
			tasks[id] = {
				...task,
				kind: task.kind ?? "standard",
				boundary: task.boundary ?? "",
				spikeForTaskId: task.spikeForTaskId ?? null,
				fixDepth: task.fixDepth ?? 0,
			};
		}
	}
	return {
		tasks,
		rootTaskIds: state.rootTaskIds,
		currentTaskId: state.currentTaskId,
		totalIterations: state.totalIterations,
		facts: state.facts ?? {},
		adrs: state.adrs ?? [],
	};
}

function emptyBlackboardlessState(): DagState {
	return { tasks: {}, rootTaskIds: [], currentTaskId: null, totalIterations: 0, facts: {}, adrs: [] };
}

/**
 * Mark the best unblocked TODO task ESTIMATING and set currentTaskId.
 *
 * First releases any BLOCKED tasks whose only blockers were dependency edges
 * (e.g. a Spike or Bug Fix prerequisite that has since completed) back to TODO,
 * so they re-enter the estimation queue. BLOCKED tasks that are still waiting
 * on their own decomposition children stay BLOCKED.
 */
export function pushNextToEstimate(state: DagState): DagState {
	const working = releaseDependencyBlockedTasks(state);
	if (working.currentTaskId) return working;
	for (const task of Object.values(working.tasks)) {
		if (task.status === "TODO" && isTaskUnblocked(working, task.id)) {
			const tasks = { ...working.tasks, [task.id]: { ...task, status: "ESTIMATING" as const } };
			return { ...working, tasks, currentTaskId: task.id };
		}
	}
	return working;
}

/**
 * Move BLOCKED tasks whose children are all settled AND whose dependency edges
 * are all DONE back to TODO, so they can be re-estimated. A task waiting on its
 * own in-progress decomposition children is left BLOCKED.
 */
function releaseDependencyBlockedTasks(state: DagState): DagState {
	let tasks = state.tasks;
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of Object.values(tasks)) {
			if (task.status !== "BLOCKED") continue;
			const children = Object.values(tasks).filter((t) => t.parentId === task.id);
			// If it has active children, it's blocked by decomposition — leave it.
			if (children.some((c) => c.status !== "DONE" && c.status !== "FAILED")) continue;
			if (!isTaskUnblocked({ ...state, tasks }, task.id)) continue;
			tasks = { ...tasks, [task.id]: { ...task, status: "TODO" as const } };
			changed = true;
		}
	}
	return tasks === state.tasks ? state : { ...state, tasks };
}

/**
 * Record a poker score and decide the next action.
 *
 * Returns an `action` the caller (tools layer) must branch on:
 *  - "ready":     points below threshold — task moved to READY; caller starts execution.
 *  - "decompose": points at/above threshold — task stays ESTIMATING; caller demands decomposition.
 *  - "spike":     the -1 probe card — caller must call createSpikeTask to freeze & derive a probe.
 *
 * applyPokerScore itself does NOT create the Spike task (kept side-effect free
 * wrt task creation); it only records the score. The tool layer owns the branch.
 */
export function applyPokerScore(
	state: DagState,
	taskId: string,
	points: StoryPoints,
): { state: DagState; action: "ready" | "decompose" | "spike" } {
	const task = state.tasks[taskId];
	if (!task) return { state, action: "ready" };

	const updated: TaskNode = { ...task, storyPoints: points };
	if (points === -1) {
		const tasks = { ...state.tasks, [taskId]: updated };
		return { state: { ...state, tasks }, action: "spike" };
	}
	if (points >= DAG_POKER_THRESHOLD) {
		const tasks = { ...state.tasks, [taskId]: updated };
		return { state: { ...state, tasks }, action: "decompose" };
	}
	const tasks = { ...state.tasks, [taskId]: { ...updated, status: "READY" as const } };
	return { state: { ...state, tasks }, action: "ready" };
}

/**
 * Freeze `taskId` (the black-box original) and derive a read-only Spike probe
 * as its new prerequisite. The original task is BLOCKED and depends on the
 * Spike. The Spike is pushed straight to IN_PROGRESS and becomes current:
 * a Spike is a probe, not an estimatable unit — it skips Agile Poker and the
 * Worker begins read-only exploration immediately.
 */
export function createSpikeTask(state: DagState, taskId: string): DagState {
	const task = state.tasks[taskId];
	if (!task) return state;

	const spikeId = generateTaskId(state.tasks);
	const spike: TaskNode = {
		id: spikeId,
		title: `Spike: ${task.title}`,
		description: `探针任务：探索并萃取与「${task.title}」相关的客观事实（只读模式，禁止修改任何文件）。完成后调用 submit_spike_result 输出 Key-Value 事实。`,
		status: "IN_PROGRESS" as const,
		storyPoints: null,
		dependsOn: [...task.dependsOn],
		parentId: task.parentId,
		context: task.context,
		resultSummary: null,
		iteration: 1,
		kind: "spike",
		boundary: "",
		spikeForTaskId: taskId,
		fixDepth: 0,
	};

	const tasks: Record<string, TaskNode> = {
		...state.tasks,
		[spikeId]: spike,
		[taskId]: {
			...task,
			status: "BLOCKED" as const,
			dependsOn: [...task.dependsOn, spikeId],
		},
	};

	return { ...state, tasks, currentTaskId: spikeId, totalIterations: state.totalIterations + 1 };
}

/**
 * Decompose a task into children, wire dependencies, and BLOCK the parent.
 *
 * Sequential: child[i] depends on child[i-1] (child[0] inherits parent deps).
 * Parallel: every child inherits the parent's dependsOn.
 * The first child is pushed to ESTIMATING.
 */
export function decomposeTask(
	state: DagState,
	parentId: string,
	children: { title: string; description: string; kind?: TaskKind; boundary?: string }[],
	isSequential: boolean,
): DagState {
	const parent = state.tasks[parentId];
	if (!parent || children.length === 0) return state;

	let tasks: Record<string, TaskNode> = {
		...state.tasks,
		[parentId]: { ...parent, status: "BLOCKED" as const },
	};
	const childIds: string[] = [];

	for (const child of children) {
		const id = generateTaskId(tasks);
		const dependsOn = isSequential && childIds.length > 0 ? [childIds[childIds.length - 1]] : [...parent.dependsOn];
		tasks = {
			...tasks,
			[id]: {
				id,
				title: child.title,
				description: child.description,
				status: "TODO",
				storyPoints: null,
				dependsOn,
				parentId,
				context: parent.context,
				resultSummary: null,
				iteration: 0,
				kind: child.kind ?? "standard",
				boundary: child.boundary ?? "",
				spikeForTaskId: null,
				fixDepth: 0,
			},
		};
		childIds.push(id);
	}

	return pushNextToEstimate({ ...state, tasks, currentTaskId: null });
}

/**
 * Close a Spike task, merge its Key-Value facts into the global blackboard,
 * and release the frozen original task back to ESTIMATING for re-estimation.
 *
 * Returns the original task id (the one the Spike was probing) so the caller
 * can drive it next. The agent must now re-score it in light of the new facts.
 */
export function submitSpikeResult(
	state: DagState,
	spikeId: string,
	facts: Record<string, string>,
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const spike = state.tasks[spikeId];
	if (!spike || spike.kind !== "spike") {
		return { state, nextTaskId: null, isComplete: isDagComplete(state) };
	}

	const summary = Object.entries(facts)
		.map(([k, v]) => `${k}=${v}`)
		.join("; ")
		.slice(0, RESULT_CONTEXT_CAP);

	let tasks: Record<string, TaskNode> = {
		...state.tasks,
		[spikeId]: { ...spike, status: "DONE" as const, resultSummary: summary },
	};

	// Merge facts into the global blackboard (last-write-wins).
	const mergedFacts: Record<string, string> = { ...state.facts };
	for (const [k, v] of Object.entries(facts)) mergedFacts[k] = v;

	// Propagate the fact summary to the probed task's context.
	const probedId = spike.spikeForTaskId;
	if (probedId && tasks[probedId]) {
		const addition = `\n[spike:${spike.title}]: ${summary}`.slice(0, RESULT_CONTEXT_CAP);
		tasks = {
			...tasks,
			[probedId]: {
				...tasks[probedId],
				context: (tasks[probedId].context + addition).slice(0, CONTEXT_CAP),
			},
		};
	}

	let nextState: DagState = { ...state, tasks, currentTaskId: null, facts: mergedFacts };
	nextState = resolveCompletedParents(nextState);

	const complete = isDagComplete(nextState);
	if (complete) {
		return { state: nextState, nextTaskId: null, isComplete: true };
	}

	// Push the next TODO (the unblocked probed task, if any) to ESTIMATING.
	const estimating = pushNextToEstimate(nextState);
	return { state: estimating, nextTaskId: estimating.currentTaskId, isComplete: false };
}

/** Transition a READY task to IN_PROGRESS and set it as current. */
export function startExecution(state: DagState, taskId: string): DagState {
	const task = state.tasks[taskId];
	if (!task || task.status !== "READY") return state;
	const tasks = {
		...state.tasks,
		[taskId]: { ...task, status: "IN_PROGRESS" as const, iteration: task.iteration + 1 },
	};
	return { ...state, tasks, currentTaskId: taskId, totalIterations: state.totalIterations + 1 };
}

/** A task is READY-eligible once every dependsOn entry is DONE. */
export function isTaskUnblocked(state: DagState, taskId: string): boolean {
	const task = state.tasks[taskId];
	if (!task) return false;
	for (const depId of task.dependsOn) {
		const dep = state.tasks[depId];
		if (!dep || dep.status !== "DONE") return false;
	}
	return true;
}

/** Highest-scored READY + unblocked task (dependents*2 − points*0.5); stable tie-break by insertion order. */
export function selectNextBestTask(state: DagState): string | null {
	let bestId: string | null = null;
	let bestScore = 0;
	for (const task of Object.values(state.tasks)) {
		if (task.status !== "READY" || !isTaskUnblocked(state, task.id)) continue;
		const dependents = countDependents(state, task.id);
		const points = task.storyPoints ?? 0;
		const score = dependents * 2 - points * 0.5;
		if (bestId === null || score > bestScore) {
			bestId = task.id;
			bestScore = score;
		}
	}
	return bestId;
}

/** Recursively complete BLOCKED parents whose children are all DONE/FAILED, propagating context. */
function resolveCompletedParents(state: DagState): DagState {
	let tasks = state.tasks;
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of Object.values(tasks)) {
			if (task.status !== "BLOCKED") continue;
			const children = Object.values(tasks).filter((t) => t.parentId === task.id);
			if (children.length === 0) continue;
			if (!children.every((c) => c.status === "DONE" || c.status === "FAILED")) continue;

			const aggregated = children
				.map((c) => `${c.title}: ${c.resultSummary ?? "(no summary)"}`)
				.join("; ")
				.slice(0, RESULT_CONTEXT_CAP);
			tasks = { ...tasks, [task.id]: { ...task, status: "DONE" as const, resultSummary: aggregated } };
			changed = true;

			for (const dependent of Object.values(tasks)) {
				if (!dependent.dependsOn.includes(task.id)) continue;
				const addition = `\n[${task.title}]: ${aggregated}`.slice(0, RESULT_CONTEXT_CAP);
				tasks = {
					...tasks,
					[dependent.id]: { ...dependent, context: (dependent.context + addition).slice(0, CONTEXT_CAP) },
				};
			}
		}
	}
	return { ...state, tasks };
}

/** No TODO/ESTIMATING/READY/IN_PROGRESS/BLOCKED tasks remain. */
export function isDagComplete(state: DagState): boolean {
	for (const task of Object.values(state.tasks)) {
		if (isTaskActive(task.status)) return false;
	}
	return true;
}

/** Count finished (DONE or FAILED) tasks. */
function countFinished(state: DagState): number {
	let count = 0;
	for (const task of Object.values(state.tasks)) {
		if (task.status === "DONE" || task.status === "FAILED") count++;
	}
	return count;
}

/** Total task count. */
export function countTasks(state: DagState): number {
	return Object.keys(state.tasks).length;
}

/** Finished count for statusline. */
export function finishedCount(state: DagState): number {
	return countFinished(state);
}

/**
 * Submit a result: mark DONE/FAILED, propagate context to direct successors,
 * resolve completed parents, then select the next task to drive.
 *
 * Returns the next task id (an ESTIMATING or IN_PROGRESS task) and whether the
 * whole DAG is complete. When `needNewTasks` is true the system does not
 * auto-advance: nextTaskId is null and the agent is asked to clarify/decompose.
 */
export function submitResult(
	state: DagState,
	taskId: string,
	status: "SUCCESS" | "FAILED",
	resultSummary: string,
	needNewTasks: boolean,
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const task = state.tasks[taskId];
	if (!task) return { state, nextTaskId: null, isComplete: isDagComplete(state) };

	const isFailure = status === "FAILED";
	const summary = resultSummary.slice(0, RESULT_CONTEXT_CAP);
	// FAILED under the fix-depth cap triggers the Micro Fail-Fix Loop:
	// instead of a terminal FAILED, freeze the task and derive a Bug Fix
	// prerequisite so a clean-context Worker can repair it.
	const failFixEligible = isFailure && task.fixDepth < DAG_MAX_FIX_DEPTH;
	const newStatus: TaskStatus = isFailure ? (failFixEligible ? "BLOCKED" : "FAILED") : "DONE";
	let tasks: Record<string, TaskNode> = {
		...state.tasks,
		[taskId]: { ...task, status: newStatus, resultSummary: summary },
	};

	for (const dependent of Object.values(tasks)) {
		if (!dependent.dependsOn.includes(taskId)) continue;
		const addition = `\n[${task.title}]: ${summary}`.slice(0, RESULT_CONTEXT_CAP);
		tasks = {
			...tasks,
			[dependent.id]: { ...dependent, context: (dependent.context + addition).slice(0, CONTEXT_CAP) },
		};
	}

	// Cascade terminal FAILURE to dependents that can never unblock.
	if (newStatus === "FAILED") {
		const cascaded = cascadeTerminalFailure({ ...state, tasks }, taskId);
		tasks = cascaded.tasks;
	}

	let nextState: DagState = { ...state, tasks, currentTaskId: null };
	nextState = resolveCompletedParents(nextState);

	const complete = isDagComplete(nextState);
	if (complete) {
		return { state: nextState, nextTaskId: null, isComplete: true };
	}

	if (failFixEligible) {
		// Derive a Bug Fix task in a fresh, clean context. It blocks the failed
		// task so the latter re-runs only after the fix lands.
		const bugfixId = generateTaskId(nextState.tasks);
		const bugfix: TaskNode = {
			id: bugfixId,
			title: `Bug Fix: ${task.title}`,
			description: `修复失败任务的错误。错误摘要：${summary}`,
			status: "TODO",
			storyPoints: null,
			dependsOn: [],
			parentId: task.parentId,
			context: "",
			resultSummary: null,
			iteration: 0,
			kind: "bugfix",
			boundary: task.boundary,
			spikeForTaskId: null,
			fixDepth: task.fixDepth + 1,
		};
		const failedTask = nextState.tasks[taskId];
		const fixTasks: Record<string, TaskNode> = {
			...nextState.tasks,
			[bugfixId]: bugfix,
			[taskId]: { ...failedTask, dependsOn: [...failedTask.dependsOn, bugfixId] },
		};
		const fixState: DagState = { ...nextState, tasks: fixTasks };
		const estimating = pushNextToEstimate(fixState);
		return { state: estimating, nextTaskId: bugfixId, isComplete: false };
	}

	if (needNewTasks) {
		return { state: nextState, nextTaskId: null, isComplete: false };
	}

	// Prefer an already-READY task to execute; otherwise push the next TODO to estimate.
	const readyId = selectNextBestTask(nextState);
	if (readyId !== null) {
		const executing = startExecution(nextState, readyId);
		return { state: executing, nextTaskId: readyId, isComplete: false };
	}

	const estimating = pushNextToEstimate(nextState);
	return { state: estimating, nextTaskId: estimating.currentTaskId, isComplete: false };
}

/**
 * Write an Architecture Decision Record to the global blackboard.
 *
 * ADRs are carried by every subsequent task prompt (Tier 2 of the system
 * prompt), so a decision recorded here becomes a standing rule for the DAG.
 * Does not advance task selection.
 */
export function proposeAdr(state: DagState, title: string, decision: string): DagState {
	const entry: AdrEntry = {
		id: `ADR_${randomUUID().slice(0, 6)}`,
		title,
		decision,
		createdAt: Date.now(),
	};
	return { ...state, adrs: [...state.adrs, entry] };
}

/**
 * Cascade terminal FAILURE along `dependsOn` edges.
 *
 * When a task becomes terminally FAILED (not fail-fix eligible), every task
 * that depends on it via a `dependsOn` edge can never unblock (isTaskUnblocked
 * requires DONE). This function recursively marks them FAILED too.
 *
 * Tasks that are BLOCKED and still have active children (decomposition) are
 * skipped — they are blocked by their children, not by the failed dependency;
 * resolveCompletedParents will handle them when children settle.
 */
function cascadeTerminalFailure(state: DagState, failedId: string): DagState {
	let tasks = state.tasks;
	const queue = [failedId];
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const [depId, dep] of Object.entries(tasks)) {
			if (!dep.dependsOn.includes(id)) continue;
			if (!isTaskActive(dep.status)) continue;
			// Skip BLOCKED tasks still waiting on children — they are blocked by
			// decomposition, not by the failed dependency edge.
			if (dep.status === "BLOCKED") {
				const activeChildren = Object.values(tasks).some((t) => t.parentId === depId && isTaskActive(t.status));
				if (activeChildren) continue;
			}
			tasks = { ...tasks, [depId]: { ...dep, status: "FAILED" as const } };
			queue.push(depId);
		}
	}
	return tasks === state.tasks ? state : { ...state, tasks };
}
