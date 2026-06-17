/**
 * Agile-DAG core data model.
 *
 * The task DAG is an invisible backend state machine. The agent only sees the
 * current task (injected via system prompt) and interacts through 3 tools.
 * These types are the load-bearing structures every other module operates on.
 */

/** Lifecycle of a task node in the DAG. */
export type TaskStatus =
	| "TODO" // created, not yet estimated
	| "ESTIMATING" // pushed to agent, awaiting play_agile_poker
	| "READY" // points <= threshold, cleared to execute
	| "BLOCKED" // has unresolved child tasks (parent waiting on decomposition)
	| "IN_PROGRESS" // agent is executing
	| "DONE"
	| "FAILED";

/** Fibonacci-like agile poker values. `-1` is the Spike probe card (black-box task). */
export type StoryPoints = 1 | 2 | 3 | 5 | 8 | 13 | -1;

/** Valid poker values, as a runtime-checked set. */
export const VALID_STORY_POINTS: readonly number[] = [1, 2, 3, 5, 8, 13, -1];

export function isStoryPoints(value: unknown): value is StoryPoints {
	return typeof value === "number" && VALID_STORY_POINTS.includes(value);
}

/** Kind of task node — drives prompt rendering and read-only enforcement. */
export type TaskKind = "standard" | "spike" | "contract" | "bugfix";

export interface TaskNode {
	/** "T_<8hex>" generated via randomUUID slice. */
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	storyPoints: StoryPoints | null;
	/** Task ids that must be DONE before this becomes READY-eligible. */
	dependsOn: string[];
	/** null = root task from plan input. */
	parentId: string | null;
	/** Accumulated context appended from predecessors' result summaries. */
	context: string;
	/** Set on submit_task_result; feeds successor context. */
	resultSummary: string | null;
	/** How many times executed (retry guard). */
	iteration: number;
	/** Discriminator for spike/contract/bugfix behavior. */
	kind: TaskKind;
	/** DoD boundary redline (e.g. "只允许修改 app/routes.py"); "" = no restriction. */
	boundary: string;
	/** When kind==="spike", the task id this probe was derived from. */
	spikeForTaskId: string | null;
	/** Depth of the bugfix chain derived from this task; guards against infinite fix loops. */
	fixDepth: number;
}

export interface DagState {
	tasks: Record<string, TaskNode>;
	rootTaskIds: string[];
	/** The ESTIMATING or IN_PROGRESS task the agent is currently working on. */
	currentTaskId: string | null;
	totalIterations: number;
	/** Global blackboard of objective facts harvested by Spike tasks (key = value). */
	facts: Record<string, string>;
	/** Global architecture decision records, carried by every subsequent task prompt. */
	adrs: AdrEntry[];
}

/** A single architecture decision record on the global blackboard. */
export interface AdrEntry {
	id: string;
	title: string;
	decision: string;
	createdAt: number;
}

/** Session custom-entry type tag used for persistence. */
export const DAG_STATE_ENTRY_TYPE = "agile-dag-state";

/** Story points >= this value force decomposition. */
export const DAG_POKER_THRESHOLD = 8;

/** Maximum bugfix-chain depth before a FAILED task becomes terminal. */
export const DAG_MAX_FIX_DEPTH = 2;

/** Statuses that still represent unfinished work. */
const ACTIVE_STATUSES: readonly TaskStatus[] = ["TODO", "ESTIMATING", "READY", "IN_PROGRESS", "BLOCKED"];

export function isTaskActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}
