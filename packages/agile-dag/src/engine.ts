/**
 * Pure DAG state-machine functions (v3.1).
 *
 * All functions here are pure: no I/O, no side effects. Git commit/reset and
 * verification-pipeline execution live in the tools layer (git.ts / verify.ts),
 * which calls these transitions before/after the side-effecting work.
 */
import { randomUUID } from "node:crypto";
import { invalidateFacts, makeFact, mergeFacts } from "./facts.ts";
import type { ParsedTask } from "./parser.ts";
import {
	type AdrEntry,
	DAG_COMPLEXITY_THRESHOLD,
	DAG_MAX_VERIFY_RETRIES,
	type DagState,
	type Fact,
	isTaskActive,
	type TaskKind,
	type TaskNode,
	type TaskStatus,
	W_COMPLEXITY,
	W_CONFIDENCE,
	W_CRITICAL,
	W_SPIKE,
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

/** Count how many tasks directly depend on `taskId`. */
function countDependents(state: DagState, taskId: string): number {
	let count = 0;
	for (const task of Object.values(state.tasks)) {
		if (task.dependsOn.includes(taskId)) count++;
	}
	return count;
}
/** Build a fresh task node with v3.2 defaults. */
function makeTask(over: Partial<TaskNode> & Pick<TaskNode, "id" | "title" | "description">): TaskNode {
	return {
		status: "CREATED",
		complexity: 0,
		risk: 0,
		confidence: 0,
		dependsOn: [],
		parentId: null,
		context: "",
		resultSummary: null,
		iteration: 0,
		kind: "standard",
		boundary: "",
		spikeForTaskId: null,
		retryCount: 0,
		proposedTargetFiles: [],
		...over,
	};
}

/**
 * Create root tasks from parsed plan input.
 *
 * If the knowledge graph is empty (a fresh session, not a restore), a day-zero
 * initialization Spike is inserted as a prerequisite of every business root
 * task. It harvests the project skeleton into facts so subsequent assessments
 * can satisfy the Proof-of-Knowledge gate. Restored sessions with existing
 * facts skip this.
 *
 * Root tasks start as CREATED; the first unblocked one is pushed as current
 * (awaiting assess_task).
 */
export function ingestPlan(state: DagState | null, plan: ParsedTask[]): DagState {
	const base = normalizeState(state);
	const tasks: Record<string, TaskNode> = { ...base.tasks };
	const keyToId = new Map<string, string>();
	const created: { id: string; dependsOnKeys: string[] }[] = [];

	// Day-zero probe: only when the knowledge graph is empty.
	const initSpikeId = base.facts.length === 0 ? createInitSpike(tasks) : null;

	for (const parsed of plan) {
		const id = generateTaskId(tasks);
		tasks[id] = makeTask({
			id,
			title: parsed.title,
			description: parsed.description,
			dependsOn: [],
		});
		keyToId.set(parsed.key, id);
		created.push({ id, dependsOnKeys: parsed.dependsOn });
	}

	for (const { id, dependsOnKeys } of created) {
		const resolved: string[] = [];
		for (const key of dependsOnKeys) {
			const depId = keyToId.get(key);
			if (depId && depId !== id) resolved.push(depId);
		}
		// Every business root task waits on the day-zero spike (if any).
		if (initSpikeId) resolved.push(initSpikeId);
		tasks[id] = { ...tasks[id], dependsOn: resolved };
	}

	const rootTaskIds = [...base.rootTaskIds, ...(initSpikeId ? [initSpikeId] : []), ...created.map((c) => c.id)];
	const newState: DagState = {
		tasks,
		rootTaskIds,
		currentTaskId: null,
		totalIterations: base.totalIterations,
		facts: base.facts,
		adrs: base.adrs,
	};
	// If a day-zero spike was created it is already READY; start it immediately
	// via selectNextToDrive so the agent begins exploring. Otherwise push the
	// first CREATED task for assessment.
	if (initSpikeId) {
		const { state: driven } = selectNextToDrive(newState);
		return driven;
	}
	return pushNextToAssess(newState);
}

/**
 * Build the day-zero initialization Spike — a READY read-only probe that
 * harvests the project skeleton (root files, README, dependency manifests)
 * into the knowledge graph. Mutates `tasks` in place and returns the new id.
 */
function createInitSpike(tasks: Record<string, TaskNode>): string {
	const id = generateTaskId(tasks);
	tasks[id] = makeTask({
		id,
		title: "项目初始化探针",
		description:
			"只读调研项目骨架：根目录结构、README、依赖文件（package.json / requirements.txt / go.mod 等）、技术栈与核心目录。完成后调用 submit_spike_result，把每个核心目录或文件作为 fact（key=路径，value=简述），并用 evidence_paths 标注证据路径。禁止 edit/write。",
		status: "READY",
		complexity: 3,
		risk: 1,
		confidence: 9,
		kind: "spike",
		boundary: "",
		spikeForTaskId: null,
	});
	return id;
}

/**
 * Ensure a restored DagState carries every v3.2 field. Sessions persisted
 * before the v3.2 rewrite (tasks missing `proposedTargetFiles`, or facts in
 * the v3.1 `Record<string,string>` form) cannot always be migrated losslessly:
 *  - Tasks missing `proposedTargetFiles` → backfilled to `[]`.
 *  - Pre-v3.1 tasks (storyPoints without complexity) → already rejected by
 *    persist.isLegacyFormat, so we only backfill optional fields here.
 *  - Facts are validated as Fact[] by persist; here we only backfill missing
 *    optional sub-fields (evidencePaths/status/confidence) defensively.
 */
export function normalizeState(state: DagState | null): DagState {
	if (!state) return emptyBlackboardlessState();
	const tasks = { ...state.tasks };
	for (const [id, task] of Object.entries(tasks)) {
		if (
			task.kind === undefined ||
			task.boundary === undefined ||
			task.spikeForTaskId === undefined ||
			task.retryCount === undefined ||
			task.complexity === undefined ||
			task.risk === undefined ||
			task.confidence === undefined ||
			task.proposedTargetFiles === undefined
		) {
			tasks[id] = {
				...task,
				kind: task.kind ?? "standard",
				boundary: task.boundary ?? "",
				spikeForTaskId: task.spikeForTaskId ?? null,
				retryCount: (task as TaskNode & { retryCount?: number }).retryCount ?? 0,
				complexity: (task as TaskNode & { complexity?: number }).complexity ?? 0,
				risk: (task as TaskNode & { risk?: number }).risk ?? 0,
				confidence: (task as TaskNode & { confidence?: number }).confidence ?? 0,
				proposedTargetFiles: (task as TaskNode & { proposedTargetFiles?: string[] }).proposedTargetFiles ?? [],
			};
		}
	}
	// Defensive facts backfill: persist.isLegacyFormat already rejects malformed
	// shapes, but a partially-persisted Fact may miss optional fields.
	const rawFacts = state.facts as unknown;
	let facts: Fact[];
	if (!Array.isArray(rawFacts)) {
		facts = [];
	} else {
		facts = (rawFacts as Array<Partial<Fact>>).map((f) => ({
			id: f.id ?? `F_recovered_${Math.random().toString(16).slice(2, 8)}`,
			key: f.key ?? "",
			value: f.value ?? "",
			source: f.source ?? "INIT",
			confidence: f.confidence ?? 0.9,
			evidencePaths: f.evidencePaths ?? [],
			status: f.status ?? "VALID",
			createdAt: f.createdAt ?? 0,
			updatedAt: f.updatedAt ?? 0,
		}));
	}
	return {
		tasks,
		rootTaskIds: state.rootTaskIds,
		currentTaskId: state.currentTaskId,
		totalIterations: state.totalIterations,
		facts,
		adrs: state.adrs ?? [],
	};
}

function emptyBlackboardlessState(): DagState {
	return { tasks: {}, rootTaskIds: [], currentTaskId: null, totalIterations: 0, facts: [], adrs: [] };
}

/**
 * Mark the best unblocked CREATED task as current (awaiting assess_task).
 *
 * First releases any BLOCKED tasks whose only blockers were dependency edges
 * (e.g. a Spike prerequisite that has since completed) back to CREATED.
 */
export function pushNextToAssess(state: DagState): DagState {
	const working = releaseDependencyBlockedTasks(state);
	if (working.currentTaskId) return working;
	for (const task of Object.values(working.tasks)) {
		if (task.status === "CREATED" && isTaskUnblocked(working, task.id)) {
			return { ...working, currentTaskId: task.id };
		}
	}
	return working;
}

/**
 * Move BLOCKED tasks whose children are all settled AND whose dependency edges
 * are all DONE back to CREATED, so they re-enter the assessment queue. A task
 * waiting on its own in-progress decomposition children stays BLOCKED.
 */
function releaseDependencyBlockedTasks(state: DagState): DagState {
	let tasks = state.tasks;
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of Object.values(tasks)) {
			if (task.status !== "BLOCKED") continue;
			const children = Object.values(tasks).filter((t) => t.parentId === task.id);
			if (children.some((c) => c.status !== "DONE" && c.status !== "FAILED")) continue;
			if (!isTaskUnblocked({ ...state, tasks }, task.id)) continue;
			tasks = { ...tasks, [task.id]: { ...task, status: "CREATED" as const } };
			changed = true;
		}
	}
	return tasks === state.tasks ? state : { ...state, tasks };
}

/** Assessment payload supplied by assess_task. */
export interface Assessment {
	complexity: number;
	risk: number;
	confidence: number;
	isSpike: boolean;
	/**
	 * Files this task intends to modify (spikes and decompositions may leave
	 * this empty). Used by the Proof-of-Knowledge gate and the runtime boundary
	 * block.
	 */
	proposedTargetFiles: string[];
}

/**
 * Record an assessment and decide the next action.
 *
 *  - "spike":     isSpike — caller derives a read-only probe via deriveSpike.
 *  - "decompose": complexity > threshold — caller demands decomposition.
 *  - "ready":     otherwise — task moved to READY; the proposedTargetFiles are
 *                 recorded and their comma-joined path becomes the `boundary`
 *                 glob (Step 5 runtime barrier).
 */
export function applyAssessment(
	state: DagState,
	taskId: string,
	assessment: Assessment,
): { state: DagState; action: "ready" | "decompose" | "spike" } {
	const task = state.tasks[taskId];
	if (!task) return { state, action: "ready" };

	const updated: TaskNode = {
		...task,
		complexity: assessment.complexity,
		risk: assessment.risk,
		confidence: assessment.confidence,
		proposedTargetFiles: assessment.proposedTargetFiles,
	};
	if (assessment.isSpike) {
		const tasks = { ...state.tasks, [taskId]: updated };
		return { state: { ...state, tasks }, action: "spike" };
	}
	if (assessment.complexity > DAG_COMPLEXITY_THRESHOLD) {
		const tasks = { ...state.tasks, [taskId]: updated };
		return { state: { ...state, tasks }, action: "decompose" };
	}
	// "ready" — write proposedTargetFiles as the runtime boundary.
	const boundary = assessment.proposedTargetFiles.join(",");
	const tasks = {
		...state.tasks,
		[taskId]: { ...updated, status: "READY" as const, boundary },
	};
	return { state: { ...state, tasks }, action: "ready" };
}

/**
 * Freeze `taskId` (the black-box original) and derive a read-only Spike probe
 * as its new prerequisite. The original task is BLOCKED and depends on the
 * Spike. The Spike starts as READY — recommendNextTask selects it next via the
 * W_SPIKE bonus, then startTask transitions it to RUNNING.
 */
export function deriveSpike(state: DagState, taskId: string): DagState {
	const task = state.tasks[taskId];
	if (!task) return state;

	const spikeId = generateTaskId(state.tasks);
	const spike: TaskNode = makeTask({
		id: spikeId,
		title: `Spike: ${task.title}`,
		description: `探针任务：探索并萃取与「${task.title}」相关的客观事实（只读模式，禁止修改任何文件）。完成后调用 submit_spike_result 输出 Key-Value 事实。`,
		status: "READY",
		dependsOn: [...task.dependsOn],
		parentId: task.parentId,
		context: task.context,
		complexity: 5,
		risk: 5,
		confidence: 5,
		kind: "spike",
		boundary: "",
		spikeForTaskId: taskId,
	});

	const tasks: Record<string, TaskNode> = {
		...state.tasks,
		[spikeId]: spike,
		[taskId]: {
			...task,
			status: "BLOCKED" as const,
			dependsOn: [...task.dependsOn, spikeId],
		},
	};

	return { ...state, tasks, currentTaskId: null };
}

/**
 * Decompose a task into children, wire dependencies, and BLOCK the parent.
 *
 * Sequential: child[i] depends on child[i-1] (child[0] inherits parent deps).
 * Parallel: every child inherits the parent's dependsOn.
 * Children start as CREATED; the first is pushed as current (awaiting assess).
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
			[id]: makeTask({
				id,
				title: child.title,
				description: child.description,
				dependsOn,
				parentId,
				context: parent.context,
				kind: child.kind ?? "standard",
				boundary: child.boundary ?? "",
			}),
		};
		childIds.push(id);
	}

	return pushNextToAssess({ ...state, tasks, currentTaskId: null });
}

/** Input shape for submit_spike_result facts. */
export interface SpikeFactInput {
	key: string;
	value: string;
	confidence?: number;
	evidencePaths?: string[];
}

/**
 * Close a Spike task, merge its facts into the global knowledge graph, and
 * release the frozen original task back to CREATED for re-assessment.
 *
 * Day-zero spikes (spikeForTaskId === null) only merge facts — they have no
 * original task to unlock.
 *
 * Spikes are read-only probes with no code output: they skip verification and
 * Git commit.
 */
export function submitSpikeResult(
	state: DagState,
	spikeId: string,
	facts: SpikeFactInput[],
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const spike = state.tasks[spikeId];
	if (!spike || spike.kind !== "spike") {
		return { state, nextTaskId: null, isComplete: isDagComplete(state) };
	}

	const summary = facts
		.map((f) => `${f.key}=${f.value}`)
		.join("; ")
		.slice(0, RESULT_CONTEXT_CAP);

	let tasks: Record<string, TaskNode> = {
		...state.tasks,
		[spikeId]: { ...spike, status: "DONE" as const, resultSummary: summary },
	};

	// Convert inputs to Fact[] and merge.
	const newFacts = facts.map((f) =>
		makeFact(
			{
				key: f.key,
				value: f.value,
				source: spikeId,
				confidence: f.confidence ?? 0.8,
				evidencePaths: f.evidencePaths ?? [],
			},
			state.facts,
		),
	);
	let nextState: DagState = mergeFacts(state, newFacts);
	nextState = { ...nextState, tasks, currentTaskId: null };

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
		nextState = { ...nextState, tasks };
	}

	nextState = resolveCompletedParents(nextState);

	if (isDagComplete(nextState)) {
		return { state: nextState, nextTaskId: null, isComplete: true };
	}

	const assessing = pushNextToAssess(nextState);
	return { state: assessing, nextTaskId: assessing.currentTaskId, isComplete: false };
}

/** Transition a READY task to RUNNING and set it as current. */
export function startTask(state: DagState, taskId: string): DagState {
	const task = state.tasks[taskId];
	if (!task || task.status !== "READY") return state;
	const tasks = {
		...state.tasks,
		[taskId]: { ...task, status: "RUNNING" as const, iteration: task.iteration + 1 },
	};
	return { ...state, tasks, currentTaskId: taskId, totalIterations: state.totalIterations + 1 };
}

/**
 * Transition a RUNNING task to VERIFYING (engine runs the verify pipeline next).
 * Does not change currentTaskId — the verify result drives the next transition.
 */
export function transitionToVerifying(state: DagState, taskId: string): DagState {
	const task = state.tasks[taskId];
	if (!task || task.status !== "RUNNING") return state;
	const tasks = {
		...state.tasks,
		[taskId]: { ...task, status: "VERIFYING" as const },
	};
	return { ...state, tasks };
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

/**
 * Highest-scored READY + unblocked task per the v3.1 heuristic formula:
 *   score = W_CRITICAL * downstream + W_SPIKE * isSpike
 *           − W_COMPLEXITY * complexity + W_CONFIDENCE * confidence
 *
 * Spike probes dominate (W_SPIKE=100). Stable tie-break by insertion order.
 */
export function recommendNextTask(state: DagState): string | null {
	let bestId: string | null = null;
	let bestScore = -Infinity;
	for (const task of Object.values(state.tasks)) {
		if (task.status !== "READY" || !isTaskUnblocked(state, task.id)) continue;
		const downstream = countDependents(state, task.id);
		const spikeBonus = task.kind === "spike" ? 1 : 0;
		const score =
			W_CRITICAL * downstream +
			W_SPIKE * spikeBonus -
			W_COMPLEXITY * task.complexity +
			W_CONFIDENCE * task.confidence;
		if (score > bestScore) {
			bestScore = score;
			bestId = task.id;
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
					[dependent.id]: {
						...dependent,
						context: (dependent.context + addition).slice(0, CONTEXT_CAP),
					},
				};
			}
		}
	}
	return { ...state, tasks };
}

/** No CREATED/READY/RUNNING/VERIFYING/BLOCKED tasks remain. */
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
 * Select the next task to drive after a state transition:
 * prefer a READY task (recommendNextTask), else push the next CREATED task.
 */
function selectNextToDrive(state: DagState): { state: DagState; nextTaskId: string | null } {
	const readyId = recommendNextTask(state);
	if (readyId !== null) {
		return { state: startTask(state, readyId), nextTaskId: readyId };
	}
	const assessing = pushNextToAssess(state);
	return { state: assessing, nextTaskId: assessing.currentTaskId };
}

/**
 * VERIFYING → DONE (caller has already committed via Git).
 *
 * Marks the task DONE, resolves completed parents, and selects the next task.
 */
export function completeTaskSuccess(
	state: DagState,
	taskId: string,
	invalidateFactKeys?: string[],
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const task = state.tasks[taskId];
	if (!task) return { state, nextTaskId: null, isComplete: isDagComplete(state) };

	// Expire stated facts before marking DONE so downstream tasks see the latest truth.
	const expired = invalidateFacts(state, invalidateFactKeys ?? []);

	const summary = (task.resultSummary ?? "").slice(0, RESULT_CONTEXT_CAP);
	let tasks: Record<string, TaskNode> = {
		...state.tasks,
		[taskId]: { ...task, status: "DONE" as const, resultSummary: summary },
	};

	for (const dependent of Object.values(tasks)) {
		if (!dependent.dependsOn.includes(taskId)) continue;
		const addition = `\n[${task.title}]: ${summary}`.slice(0, RESULT_CONTEXT_CAP);
		tasks = {
			...tasks,
			[dependent.id]: {
				...dependent,
				context: (dependent.context + addition).slice(0, CONTEXT_CAP),
			},
		};
	}

	let nextState: DagState = { ...expired, tasks, currentTaskId: null };
	nextState = resolveCompletedParents(nextState);

	if (isDagComplete(nextState)) {
		return { state: nextState, nextTaskId: null, isComplete: true };
	}

	const { state: driven, nextTaskId } = selectNextToDrive(nextState);
	return { state: driven, nextTaskId, isComplete: false };
}

/**
 * VERIFYING or RUNNING failure (verify pipeline failed, or agent self-reported
 * FAILED). Caller has already run `git reset --hard` + `git clean -fd`.
 *
 * Under the retry cap the task returns to READY for a clean retry (the failure
 * reason is appended to its context as `[verify-fail #N]: ...`). At/above the
 * cap the task is terminal FAILED and the failure cascades to dependents.
 */
export function handleTaskFailure(
	state: DagState,
	taskId: string,
	reason: string,
): { state: DagState; nextTaskId: string | null; isComplete: boolean } {
	const task = state.tasks[taskId];
	if (!task) return { state, nextTaskId: null, isComplete: isDagComplete(state) };

	const newRetryCount = task.retryCount + 1;
	const terminal = newRetryCount >= DAG_MAX_VERIFY_RETRIES;
	const summary = reason.slice(0, RESULT_CONTEXT_CAP);

	if (!terminal) {
		const failNote = `\n[verify-fail #${newRetryCount}]: ${summary}`.slice(0, RESULT_CONTEXT_CAP);
		const tasks: Record<string, TaskNode> = {
			...state.tasks,
			[taskId]: {
				...task,
				status: "READY" as const,
				resultSummary: null,
				retryCount: newRetryCount,
				context: (task.context + failNote).slice(0, CONTEXT_CAP),
			},
		};
		const nextState: DagState = { ...state, tasks, currentTaskId: null };
		const { state: driven, nextTaskId } = selectNextToDrive(nextState);
		return { state: driven, nextTaskId, isComplete: false };
	}

	let tasks: Record<string, TaskNode> = {
		...state.tasks,
		[taskId]: { ...task, status: "FAILED" as const, resultSummary: summary, retryCount: newRetryCount },
	};

	const cascaded = cascadeTerminalFailure({ ...state, tasks }, taskId);
	tasks = cascaded.tasks;

	let nextState: DagState = { ...state, tasks, currentTaskId: null };
	nextState = resolveCompletedParents(nextState);

	if (isDagComplete(nextState)) {
		return { state: nextState, nextTaskId: null, isComplete: true };
	}

	const { state: driven, nextTaskId } = selectNextToDrive(nextState);
	return { state: driven, nextTaskId, isComplete: false };
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
 * When a task becomes terminally FAILED, every task that depends on it via a
 * `dependsOn` edge can never unblock (isTaskUnblocked requires DONE). This
 * function recursively marks them FAILED too.
 *
 * BLOCKED tasks still waiting on active decomposition children are skipped —
 * they are blocked by their children, not by the failed dependency edge;
 * resolveCompletedParents handles them when children settle.
 */
function cascadeTerminalFailure(state: DagState, failedId: string): DagState {
	let tasks = state.tasks;
	const queue = [failedId];
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const [depId, dep] of Object.entries(tasks)) {
			if (!dep.dependsOn.includes(id)) continue;
			if (!isTaskActive(dep.status)) continue;
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

// Re-export status names so the tools layer can reference them without a
// separate import site.
export type { TaskStatus };
