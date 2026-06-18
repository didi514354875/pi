/**
 * Pure DAG state-machine functions.
 *
 * All functions are deterministic: they take DagState + input and return a new
 * DagState (or a state + action tuple). Side effects (git, verify, LLM calls)
 * live in the tools/hooks layer.
 */
import { randomUUID } from "node:crypto";
import { assignBudget, type BudgetAssignment } from "./budget.ts";
import {
	type AdrEntry,
	BUDGET_DECOMPOSE_THRESHOLD,
	DAG_MAX_VERIFY_RETRIES,
	type DagAdjustmentResult,
	type DagMutation,
	type DagState,
	type Fact,
	isTaskActive,
	type TaskKind,
	type TaskNode,
	W_COMPLEXITY,
	W_CONFIDENCE,
	W_CRITICAL,
	W_SPIKE,
} from "./types.ts";

// ===========================================================================
// Helpers
// ===========================================================================

/** Context cap (chars) appended to a successor when a predecessor completes. */
const RESULT_CONTEXT_CAP = 200;
/** Max accumulated context length per task. */
const CONTEXT_CAP = 500;

/** Generate a unique task id, collision-checked against the existing nodes. */
function generateTaskId(tasks: Record<string, TaskNode>): string {
	for (;;) {
		const id = `T_${randomUUID().slice(0, 8)}`;
		if (!(id in tasks)) return id;
	}
}

/** Count how many tasks directly depend on `taskId`. */
function countDependents(state: DagState, taskId: string): number {
	let count = 0;
	for (const task of Object.values(state.tasks)) {
		if (task.dependsOn.includes(taskId)) count++;
	}
	return count;
}

/** Build a fresh task node with defaults. */
function makeTask(over: Partial<TaskNode> & Pick<TaskNode, "id" | "title" | "description">): TaskNode {
	return {
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
		...over,
	};
}

/** Generate a stable fact id. */
function generateFactId(existing: Fact[]): string {
	const ids = new Set(existing.map((f) => f.id));
	for (;;) {
		const id = `F_${randomUUID().slice(0, 6)}`;
		if (!ids.has(id)) return id;
	}
}

// ===========================================================================
// Plan ingestion
// ===========================================================================

/** A parsed task from the plan input parser. */
export interface ParsedTask {
	title: string;
	description: string;
	dependsOn: string[];
	/** Stable key within this parse batch; used to resolve dependsOn in the engine. */
	key: string;
}

/**
 * Create root tasks from parsed plan input.
 * If no facts exist, also inject a day-zero init spike to harvest project structure.
 */
export function ingestPlan(state: DagState | null, plan: ParsedTask[]): DagState {
	const tasks: Record<string, TaskNode> = state?.tasks ?? {};
	const rootTaskIds: string[] = [];
	const keyToId = new Map<string, string>();

	// Create root tasks
	for (const item of plan) {
		const id = generateTaskId(tasks);
		keyToId.set(item.key, id);
		const task = makeTask({ id, title: item.title, description: item.description });
		tasks[id] = task;
		rootTaskIds.push(id);
	}

	// Resolve dependsOn keys to ids
	for (const item of plan) {
		const id = keyToId.get(item.key);
		if (!id) continue;
		const task = tasks[id];
		if (!task) continue;
		for (const depKey of item.dependsOn) {
			const depId = keyToId.get(depKey);
			if (depId && depId !== id) {
				if (!task.dependsOn.includes(depId)) {
					task.dependsOn.push(depId);
				}
			}
		}
	}

	const facts = state?.facts ?? [];
	const adrs = state?.adrs ?? [];

	// Seed day-zero init spike if no facts exist
	if (facts.length === 0) {
		const spikeId = createInitSpike(tasks);
		rootTaskIds.push(spikeId);
	}

	return {
		tasks,
		rootTaskIds,
		currentTaskId: null,
		totalIterations: (state?.totalIterations ?? 0) + 1,
		facts,
		adrs,
		paused: false,
	};
}

/** Build the day-zero initialization Spike — READY read-only probe. */
function createInitSpike(tasks: Record<string, TaskNode>): string {
	const id = generateTaskId(tasks);
	tasks[id] = makeTask({
		id,
		title: "项目骨架探索 (Init Spike)",
		description: "只读探索当前项目的技术栈、入口文件、依赖清单和目录结构。将发现写入全局事实库。禁止修改任何文件。",
		kind: "spike",
		status: "READY",
	});
	return id;
}

// ===========================================================================
// State push (assessment queue)
// ===========================================================================

/** Mark the best unblocked CREATED task as current (awaiting assess_task). */
export function pushNextToEstimate(state: DagState): DagState {
	// Release any BLOCKED tasks whose dependencies resolved
	const released = releaseDependencyBlockedTasks(state);
	// Find first CREATED
	const taskId = Object.keys(released.tasks).find((id) => released.tasks[id].status === "CREATED");
	if (taskId) {
		released.tasks[taskId].status = "ESTIMATING";
		released.currentTaskId = taskId;
	}
	return released;
}

/** Move BLOCKED tasks whose children/deps are all DONE back to CREATED. */
function releaseDependencyBlockedTasks(state: DagState): DagState {
	const tasks = { ...state.tasks };
	for (const [id, task] of Object.entries(tasks)) {
		if (task.status !== "BLOCKED") continue;
		// Don't unblock if BLOCKED due to decompose exhaustion (still has active children)
		const children = Object.values(tasks).filter((t) => t.parentId === id);
		const allChildrenSettled = children.every((c) => c.status === "DONE" || c.status === "FAILED");
		const depsSettled = task.dependsOn.every((depId) => {
			const dep = tasks[depId];
			return dep && (dep.status === "DONE" || dep.status === "FAILED");
		});
		const noActiveChildren = children.every((c) => !isTaskActive(c.status));
		if (allChildrenSettled && depsSettled && noActiveChildren) {
			tasks[id] = { ...task, status: "CREATED", decomposeRetries: 0 };
		}
	}
	return { ...state, tasks };
}

// ===========================================================================
// Assessment (poker scoring)
// ===========================================================================

/** Assessment payload from assess_task. */
export interface Assessment {
	complexity: number;
	risk: number;
	confidence: number;
	is_spike: boolean;
	proposedTargetFiles: string[];
}

/** Record an assessment and decide next action. */
export function applyAssessment(
	state: DagState,
	taskId: string,
	assessment: Assessment,
): { state: DagState; action: "ready" | "decompose" | "spike"; budget?: BudgetAssignment } {
	const task = state.tasks[taskId];
	if (!task || task.status !== "ESTIMATING") {
		return { state, action: "ready" }; // no-op guard
	}

	const updatedTask: TaskNode = {
		...task,
		complexity: assessment.complexity,
		risk: assessment.risk,
		confidence: assessment.confidence,
		proposedTargetFiles: assessment.proposedTargetFiles,
		boundary: assessment.proposedTargetFiles.join(","),
	};

	const tasks = { ...state.tasks, [taskId]: updatedTask };

	if (assessment.is_spike || assessment.complexity === -1) {
		// Spike probe needed
		tasks[taskId] = { ...updatedTask, status: "BLOCKED" };
		const derived = deriveSpike({ ...state, tasks }, taskId);
		return { state: derived, action: "spike" };
	}

	if (assessment.complexity >= BUDGET_DECOMPOSE_THRESHOLD) {
		// Complexity too high — must decompose
		tasks[taskId] = { ...updatedTask, status: "DECOMPOSING" };
		return { state: { ...state, tasks, currentTaskId: taskId }, action: "decompose" };
	}

	// Ready to execute with budget
	const budget = assignBudget(assessment.complexity);
	tasks[taskId] = {
		...updatedTask,
		status: "READY",
		budgetRemaining: budget.maxToolCalls,
	};
	return {
		state: { ...state, tasks, currentTaskId: null },
		action: "ready",
		budget,
	};
}

// ===========================================================================
// Spike
// ===========================================================================

/** Freeze parent task and derive a read-only Spike probe. */
export function deriveSpike(state: DagState, parentId: string): DagState {
	const parent = state.tasks[parentId];
	if (!parent) return state;

	const spikeId = generateTaskId(state.tasks);
	const tasks = { ...state.tasks };

	tasks[spikeId] = makeTask({
		id: spikeId,
		title: `🔍 探索: ${parent.title}`,
		description: `只读探索父任务的前置知识缺口。禁止修改任何文件，仅收集事实。\n\n父任务: ${parent.description}`,
		kind: "spike",
		status: "READY",
		spikeForTaskId: parentId,
		parentId,
	});

	// Link parent → spike
	tasks[parentId] = {
		...parent,
		childrenIds: [...parent.childrenIds, spikeId],
		dependsOn: [...parent.dependsOn, spikeId],
	};

	return { ...state, tasks };
}

/** Input shape for spike facts. */
export interface SpikeFactInput {
	key: string;
	value: string;
	confidence: number;
	evidencePaths: string[];
}

/** Close a Spike task, merge facts, unblock parent. */
export function submitSpikeResult(
	state: DagState,
	spikeId: string,
	facts: SpikeFactInput[],
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const spike = state.tasks[spikeId];
	if (!spike || spike.kind !== "spike") {
		return { state, nextTaskId: null, isComplete: false };
	}

	const tasks = { ...state.tasks };
	tasks[spikeId] = { ...spike, status: "DONE", resultSummary: `Spike完成，收集了 ${facts.length} 条事实。` };

	// Merge facts
	const newFacts: Fact[] = facts.map((f) => ({
		id: generateFactId(state.facts),
		key: f.key,
		value: f.value,
		source: spikeId,
		confidence: f.confidence,
		evidencePaths: f.evidencePaths,
		status: "VALID" as const,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	}));
	const mergedFacts = mergeFactsIntoState(state.facts, newFacts);

	const newState: DagState = { ...state, tasks, facts: mergedFacts };

	// Unblock parent
	if (spike.spikeForTaskId) {
		const parent = tasks[spike.spikeForTaskId];
		if (parent && parent.status === "BLOCKED") {
			tasks[spike.spikeForTaskId] = { ...parent, status: "CREATED" };
		}
	}

	// Select next task
	const { nextTaskId } = selectNextToDrive({ ...newState, tasks });
	return { state: { ...newState, tasks }, nextTaskId, isComplete: false };
}

// ===========================================================================
// Decomposition
// ===========================================================================

/** Decompose a task into children, BLOCK parent. */
export function decomposeTask(
	state: DagState,
	parentId: string,
	children: { title: string; description: string; kind?: TaskKind; boundary?: string; dependsOn?: string[] }[],
	isSequential: boolean,
): DagState {
	const parent = state.tasks[parentId];
	if (!parent) return state;

	const tasks = { ...state.tasks };
	const childIds: string[] = [];

	let prevId: string | null = null;
	for (const childDef of children) {
		const childId = generateTaskId(tasks);
		const childDependsOn = childDef.dependsOn ?? [];
		if (isSequential && prevId) {
			childDependsOn.push(prevId);
		}
		tasks[childId] = makeTask({
			id: childId,
			title: childDef.title,
			description: childDef.description,
			kind: childDef.kind ?? "standard",
			boundary: childDef.boundary ?? "",
			parentId,
			dependsOn: childDependsOn,
		});
		childIds.push(childId);
		prevId = childId;
	}

	// Update parent
	tasks[parentId] = {
		...parent,
		status: "BLOCKED",
		childrenIds: [...parent.childrenIds, ...childIds],
		decomposeRetries: 0,
	};

	// Also remove any previous children that were from a rejected decomposition
	const newChildren = new Set(childIds);
	for (const [id, task] of Object.entries(tasks)) {
		if (task.parentId === parentId && !newChildren.has(id) && task.status === "CREATED") {
			tasks[id] = { ...task, status: "FAILED" };
		}
	}

	return { ...state, tasks, currentTaskId: null };
}

// ===========================================================================
// Task execution
// ===========================================================================

/** Transition a READY task to RUNNING and set it as current. */
export function startTask(state: DagState, taskId: string): DagState {
	const task = state.tasks[taskId];
	if (!task || task.status !== "READY") return state;

	const tasks = { ...state.tasks };
	tasks[taskId] = {
		...task,
		status: "RUNNING",
		iteration: task.iteration + 1,
	};
	return { ...state, tasks, currentTaskId: taskId };
}

/** Transition a RUNNING task to VERIFYING. */
export function transitionToVerifying(state: DagState, taskId: string): DagState {
	const task = state.tasks[taskId];
	if (!task || task.status !== "RUNNING") return state;

	const tasks = { ...state.tasks };
	tasks[taskId] = { ...task, status: "VERIFYING", budgetRemaining: null };
	return { ...state, tasks };
}

// ===========================================================================
// Task completion
// ===========================================================================

/** A task is READY-eligible once every dependsOn entry is DONE. */
export function isTaskUnblocked(state: DagState, taskId: string): boolean {
	const task = state.tasks[taskId];
	if (!task) return false;
	return task.dependsOn.every((depId) => {
		const dep = state.tasks[depId];
		return dep && dep.status === "DONE";
	});
}

/** Highest-scored READY + unblocked task per the heuristic formula. */
export function recommendNextTask(state: DagState): string | null {
	let bestId: string | null = null;
	let bestScore = -Infinity;

	for (const [id, task] of Object.entries(state.tasks)) {
		if (task.status !== "READY") continue;
		if (!isTaskUnblocked(state, id)) continue;

		const downstream = countDependents(state, id);
		const isSpike = task.kind === "spike" ? 1 : 0;
		const score =
			W_CRITICAL * downstream + W_SPIKE * isSpike - W_COMPLEXITY * task.complexity + W_CONFIDENCE * task.confidence;

		if (score > bestScore) {
			bestScore = score;
			bestId = id;
		}
	}

	return bestId;
}

/** Recursively complete BLOCKED parents whose children are all DONE/FAILED. */
function resolveCompletedParents(state: DagState): DagState {
	const tasks = { ...state.tasks };
	let changed = true;

	while (changed) {
		changed = false;
		for (const [id, task] of Object.entries(tasks)) {
			if (task.status !== "BLOCKED") continue;

			const children = task.childrenIds.map((cid) => tasks[cid]).filter(Boolean);
			if (children.length === 0) continue;

			const allDone = children.every((c) => c.status === "DONE" || c.status === "FAILED");
			if (!allDone) continue;

			// Propagate context from children
			let context = task.context;
			for (const child of children) {
				if (child.resultSummary) {
					const append = child.resultSummary.slice(0, RESULT_CONTEXT_CAP);
					context = `${context}\n[${child.id}] ${append}`.slice(-CONTEXT_CAP);
				}
			}

			tasks[id] = {
				...task,
				status: "DONE",
				context,
				resultSummary: `子任务 ${children.length} 个已完成。`,
			};
			changed = true;
		}
	}

	return { ...state, tasks };
}

/** No CREATED/ESTIMATING/SPIKING/DECOMPOSING/READY/RUNNING/VERIFYING/BLOCKED tasks remain. */
export function isDagComplete(state: DagState): boolean {
	return !Object.values(state.tasks).some((t) => isTaskActive(t.status));
}

/** Finished count for statusline. */
export function finishedCount(state: DagState): number {
	return Object.values(state.tasks).filter((t) => t.status === "DONE" || t.status === "FAILED").length;
}

/** Total task count. */
export function countTasks(state: DagState): number {
	return Object.keys(state.tasks).length;
}

// ===========================================================================
// Task completion / failure
// ===========================================================================

/** Select the next task to drive after a state transition. */
function selectNextToDrive(state: DagState): { state: DagState; nextTaskId: string | null } {
	const next = recommendNextTask(state);
	if (next) {
		return { state, nextTaskId: next };
	}
	// Push next CREATED to ESTIMATING
	const pushed = pushNextToEstimate(state);
	return { state: pushed, nextTaskId: pushed.currentTaskId };
}

/** VERIFYING → DONE. */
export function completeTaskSuccess(
	state: DagState,
	taskId: string,
	invalidateFactKeys?: string[],
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const task = state.tasks[taskId];
	if (!task) return { state, nextTaskId: null, isComplete: false };

	const tasks = { ...state.tasks };
	tasks[taskId] = { ...task, status: "DONE", budgetRemaining: null };

	let facts = state.facts;
	if (invalidateFactKeys && invalidateFactKeys.length > 0) {
		facts = invalidateFactsInState(facts, invalidateFactKeys);
	}

	let newState: DagState = { ...state, tasks, facts };
	newState = resolveCompletedParents(newState);

	const complete = isDagComplete(newState);
	if (complete) return { state: newState, nextTaskId: null, isComplete: true };

	const { nextTaskId } = selectNextToDrive(newState);
	return { state: newState, nextTaskId, isComplete: false };
}

/** VERIFYING or RUNNING failure (verify pipeline failed, or agent self-reported FAILED). */
export function handleTaskFailure(
	state: DagState,
	taskId: string,
	reason: string,
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const task = state.tasks[taskId];
	if (!task) return { state, nextTaskId: null, isComplete: false };

	const tasks = { ...state.tasks };
	const retries = task.verifyRetries + 1;
	const context = `${task.context}\n[verify-fail #${retries}] ${reason}`.slice(-CONTEXT_CAP);

	if (retries <= DAG_MAX_VERIFY_RETRIES) {
		// Retry
		tasks[taskId] = {
			...task,
			status: "READY",
			verifyRetries: retries,
			context,
			budgetRemaining: task.budgetRemaining, // restore budget for retry
		};
		const newState: DagState = { ...state, tasks, currentTaskId: null };
		const { nextTaskId } = selectNextToDrive(newState);
		return { state: newState, nextTaskId, isComplete: false };
	}

	// Terminal FAILED
	tasks[taskId] = {
		...task,
		status: "FAILED",
		verifyRetries: retries,
		context,
		resultSummary: `失败: ${reason}`,
		budgetRemaining: null,
	};

	let newState: DagState = { ...state, tasks };
	newState = cascadeTerminalFailure(newState, taskId);
	newState = resolveCompletedParents(newState);

	const complete = isDagComplete(newState);
	if (complete) return { state: newState, nextTaskId: null, isComplete: true };

	const { nextTaskId } = selectNextToDrive(newState);
	return { state: newState, nextTaskId, isComplete: false };
}

/** Cascade terminal FAILURE along dependsOn edges. */
function cascadeTerminalFailure(state: DagState, failedId: string): DagState {
	const tasks = { ...state.tasks };
	for (const [id, task] of Object.entries(tasks)) {
		if (task.dependsOn.includes(failedId) && isTaskActive(task.status)) {
			tasks[id] = {
				...task,
				status: "FAILED",
				resultSummary: `级联失败: 依赖任务 ${failedId} 已失败。`,
				budgetRemaining: null,
			};
			// Recursively cascade
			const cascaded = cascadeTerminalFailure({ ...state, tasks }, id);
			Object.assign(tasks, cascaded.tasks);
		}
	}
	return { ...state, tasks };
}

// ===========================================================================
// ADR
// ===========================================================================

/** Write an Architecture Decision Record to the global blackboard. */
export function proposeAdr(state: DagState, title: string, decision: string): DagState {
	const adr: AdrEntry = {
		id: `ADR_${randomUUID().slice(0, 6)}`,
		title,
		decision,
		createdAt: Date.now(),
	};
	return { ...state, adrs: [...state.adrs, adr] };
}

// ===========================================================================
// Dynamic DAG adjustment (runtime mutation)
// ===========================================================================

/** Validate and apply a runtime DAG mutation from the Executor. */
export function adjustDag(state: DagState, mutation: DagMutation): { result: DagAdjustmentResult; state: DagState } {
	switch (mutation.action) {
		case "add":
			return adjustDagAdd(state, mutation);
		case "remove":
			return adjustDagRemove(state, mutation);
		case "split":
			return adjustDagSplit(state, mutation);
	}
}

function adjustDagAdd(state: DagState, mutation: DagMutation): { result: DagAdjustmentResult; state: DagState } {
	if (!mutation.tasks || mutation.tasks.length === 0) {
		return { result: { accepted: false, reason: "add 操作需要至少一个任务定义。" }, state };
	}

	const tasks = { ...state.tasks };
	const newIds: string[] = [];

	for (const def of mutation.tasks) {
		const id = generateTaskId(tasks);
		for (const depKey of def.dependsOn) {
			if (!(depKey in tasks)) {
				return { result: { accepted: false, reason: `依赖任务 "${depKey}" 不存在于 DAG 中。` }, state };
			}
		}

		tasks[id] = makeTask({
			id,
			title: def.title,
			description: def.description,
			kind: def.kind ?? "standard",
			boundary: def.boundary ?? "",
			dependsOn: def.dependsOn,
		});
		newIds.push(id);
	}

	return {
		result: { accepted: true, reason: `已添加 ${newIds.length} 个新任务。`, newTaskIds: newIds },
		state: { ...state, tasks },
	};
}

function adjustDagRemove(state: DagState, mutation: DagMutation): { result: DagAdjustmentResult; state: DagState } {
	if (!mutation.taskId) {
		return { result: { accepted: false, reason: "remove 操作需要 taskId。" }, state };
	}

	const task = state.tasks[mutation.taskId];
	if (!task) {
		return { result: { accepted: false, reason: `任务 "${mutation.taskId}" 不存在。` }, state };
	}
	if (!isTaskActive(task.status)) {
		return { result: { accepted: false, reason: `任务 "${mutation.taskId}" 已经结束，无法删除。` }, state };
	}
	const hasDependents = Object.values(state.tasks).some((t) => t.dependsOn.includes(mutation.taskId!));
	if (hasDependents) {
		return { result: { accepted: false, reason: `任务 "${mutation.taskId}" 有其他任务依赖它，无法删除。` }, state };
	}

	const tasks = { ...state.tasks };
	tasks[mutation.taskId] = { ...task, status: "FAILED", resultSummary: "执行者主动删除。" };

	return {
		result: { accepted: true, reason: `已删除任务 "${mutation.taskId}"。` },
		state: { ...state, tasks },
	};
}

function adjustDagSplit(state: DagState, mutation: DagMutation): { result: DagAdjustmentResult; state: DagState } {
	if (!mutation.parentId || !mutation.tasks || mutation.tasks.length < 2) {
		return { result: { accepted: false, reason: "split 操作需要 parentId 和至少 2 个新任务定义。" }, state };
	}

	const parent = state.tasks[mutation.parentId];
	if (!parent) {
		return { result: { accepted: false, reason: `父任务 "${mutation.parentId}" 不存在。` }, state };
	}
	if (!isTaskActive(parent.status)) {
		return { result: { accepted: false, reason: `父任务 "${mutation.parentId}" 已经结束，无法拆分。` }, state };
	}

	const tasks = { ...state.tasks };
	const childIds: string[] = [];
	let prevId: string | null = null;

	for (const def of mutation.tasks) {
		const id = generateTaskId(tasks);
		const deps = [...(def.dependsOn ?? [])];
		if (prevId) deps.push(prevId);
		tasks[id] = makeTask({
			id,
			title: def.title,
			description: def.description,
			kind: def.kind ?? "standard",
			boundary: def.boundary ?? "",
			dependsOn: deps,
			parentId: mutation.parentId,
		});
		childIds.push(id);
		prevId = id;
	}

	tasks[mutation.parentId!] = {
		...parent,
		status: "BLOCKED",
		childrenIds: [...new Set([...parent.childrenIds, ...childIds])],
	};

	return {
		result: {
			accepted: true,
			reason: `已将任务 "${mutation.parentId}" 拆分为 ${childIds.length} 个子任务。`,
			newTaskIds: childIds,
		},
		state: { ...state, tasks },
	};
}

// ===========================================================================
// Internal helpers (fact operations)
// ===========================================================================

function mergeFactsIntoState(existing: Fact[], newFacts: Fact[]): Fact[] {
	const merged = [...existing];
	const keyMap = new Map<string, number>();
	for (let i = 0; i < merged.length; i++) {
		keyMap.set(merged[i].key, i);
	}
	for (const nf of newFacts) {
		const idx = keyMap.get(nf.key);
		if (idx !== undefined) {
			const existingFact = merged[idx];
			if (existingFact.value !== nf.value && existingFact.status !== "EXPIRED") {
				merged[idx] = { ...existingFact, status: "CONFLICT", updatedAt: Date.now() };
			}
		} else {
			merged.push(nf);
		}
	}
	return merged;
}

function invalidateFactsInState(facts: Fact[], keys: string[]): Fact[] {
	const keySet = new Set(keys);
	return facts.map((f) => (keySet.has(f.key) ? { ...f, status: "EXPIRED" as const, updatedAt: Date.now() } : f));
}

// ===========================================================================
// Public facts helpers (re-exported for tools layer)
// ===========================================================================

export { generateFactId };
