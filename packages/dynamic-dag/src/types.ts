/**
 * Dynamic-DAG core data model.
 *
 * Implements the design spec's stateful-host / stateless-worker architecture
 * with tool-call budgeting, 3-stage decomposition review, and runtime DAG
 * adjustment.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ===========================================================================
// Task lifecycle
// ===========================================================================

/** Lifecycle of a task node in the DAG. */
export type TaskStatus =
	| "CREATED" // not yet assessed
	| "ESTIMATING" // agent is scoring complexity (agile poker)
	| "SPIKING" // read-only spike probe is running
	| "DECOMPOSING" // agent is decomposing a complex task
	| "READY" // scored, unblocked, ready to execute
	| "RUNNING" // agent is executing
	| "VERIFYING" // engine is running the verification pipeline
	| "BLOCKED" // has unresolved children, spike dependency, or exhausted decompose retries
	| "DONE"
	| "FAILED";

/** Kind of task node — drives prompt rendering and tool allowlist. */
export type TaskKind = "standard" | "spike" | "decompose";

// ===========================================================================
// Facts & ADRs (identical model to agile-dag)
// ===========================================================================

export type FactStatus = "VALID" | "CONFLICT" | "EXPIRED";

/** A single objective fact harvested by Spike tasks (or seeded at day-zero). */
export interface Fact {
	/** Stable id: `F_<6hex>`. */
	id: string;
	/** Semantic key, e.g. "auth_library". For path-facts the key IS the glob path. */
	key: string;
	/** Value, e.g. "PyJWT" or a short descriptor. */
	value: string;
	/** Task id that produced this fact (the Spike id, or "INIT" for day-zero). */
	source: string;
	/** 0.0-1.0. Spike-reported; day-zero facts default 0.9. */
	confidence: number;
	/** File paths cited as evidence. */
	evidencePaths: string[];
	status: FactStatus;
	createdAt: number;
	updatedAt: number;
}

/** A single architecture decision record on the global blackboard. */
export interface AdrEntry {
	id: string;
	title: string;
	decision: string;
	createdAt: number;
}

// ===========================================================================
// Task node
// ===========================================================================

export interface TaskNode {
	/** "T_<8hex>" generated via randomUUID slice. */
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	kind: TaskKind;
	/** 1-10 self-assessed complexity. 8+ forces decomposition. */
	complexity: number;
	/** 1-10 self-assessed risk. */
	risk: number;
	/** 1-10 self-assessed confidence. */
	confidence: number;
	/** Task ids that must be DONE before this becomes READY-eligible. */
	dependsOn: string[];
	/** null = root task from plan input. */
	parentId: string | null;
	/** Task ids that directly depend on this task. */
	childrenIds: string[];
	/** Accumulated context appended from predecessors' result summaries. */
	context: string;
	/** Set on submit_task_result; feeds successor context. */
	resultSummary: string | null;
	/** How many times executed (retry guard). */
	iteration: number;
	/** Verification-failure retry count. */
	verifyRetries: number;
	/** Decomposition rejection retry count. */
	decomposeRetries: number;
	/** DoD boundary redline (comma-separated globs); "" = no restriction. */
	boundary: string;
	/** When kind==="spike", the task id this probe was derived from. */
	spikeForTaskId: string | null;
	/** Files declared at assessment as planned modification targets. */
	proposedTargetFiles: string[];
	/** Remaining tool-call budget during RUNNING; null when not running. */
	budgetRemaining: number | null;
}

// ===========================================================================
// DAG state
// ===========================================================================

export interface DagState {
	tasks: Record<string, TaskNode>;
	rootTaskIds: string[];
	/** The task the agent is currently working on (ESTIMATING/SPIKING/DECOMPOSING/RUNNING). */
	currentTaskId: string | null;
	totalIterations: number;
	/** Global knowledge graph of objective facts harvested by Spike tasks. */
	facts: Fact[];
	/** Global architecture decision records. */
	adrs: AdrEntry[];
	/** Whether the DAG is paused (user-initiated or exhaustion). */
	paused: boolean;
}

// ===========================================================================
// Budget
// ===========================================================================

/** Budget tier mapping: complexity → max tool calls + strategy label. */
export interface BudgetTier {
	maxToolCalls: number;
	strategy: string;
}

/** Complexity-to-budget lookup. Complexity 8+ is never in this map — it forces decomposition. */
export const BUDGET_MATRIX: Record<number, BudgetTier> = {
	"-1": { maxToolCalls: 10, strategy: "spike_readonly" },
	"1": { maxToolCalls: 3, strategy: "trivial" },
	"2": { maxToolCalls: 3, strategy: "trivial" },
	"3": { maxToolCalls: 5, strategy: "small" },
	"5": { maxToolCalls: 15, strategy: "medium" },
};

/** Complexity above this forces decomposition. */
export const BUDGET_DECOMPOSE_THRESHOLD = 8;

// ===========================================================================
// Decomposition review
// ===========================================================================

/** Criteria that can cause a decomposition rejection. */
export type RejectCriteria =
	| "SCHEMA_VIOLATION"
	| "IO_CONTRACT_MISMATCH"
	| "INCOMPLETE"
	| "REDUNDANT"
	| "UNSOLVABLE"
	| "CYCLE_DETECTED";

/** Result of the 3-stage decomposition review pipeline. */
export interface DecompositionReview {
	status: "APPROVED" | "REJECTED";
	failed_criteria?: RejectCriteria;
	reason?: string;
	refinement_suggestion?: string;
}

/** Max decomposition rejection retries before the parent is BLOCKED. */
export const DECOMPOSE_MAX_RETRIES = 2;

// ===========================================================================
// DAG adjustment (runtime mutation)
// ===========================================================================

/** A runtime DAG mutation requested by the Executor. */
export interface DagMutation {
	/** "add" inserts a new task; "remove" deletes an unstarted leaf; "split" replaces a task with children. */
	action: "add" | "remove" | "split";
	/** For "add"/"split": the new task(s) to insert. */
	tasks?: { title: string; description: string; dependsOn: string[]; kind?: TaskKind; boundary?: string }[];
	/** For "remove": task id to delete. */
	taskId?: string;
	/** For "split": the task id being replaced. */
	parentId?: string;
	/** Reason for the adjustment (shown to user). */
	reason: string;
}

/** Result of a DAG mutation request. */
export interface DagAdjustmentResult {
	accepted: boolean;
	reason: string;
	/** If accepted, the ids of the newly created tasks. */
	newTaskIds?: string[];
}

// ===========================================================================
// Constants
// ===========================================================================

/** Session custom-entry type tag used for persistence. */
export const DAG_STATE_ENTRY_TYPE = "dynamic-dag-state";

/** Verification-failure retry cap before a task becomes terminal FAILED. */
export const DAG_MAX_VERIFY_RETRIES = 2;

/** Confidence below this marks a fact CONFLICT candidate. */
export const DAG_FACT_CONFLICT_THRESHOLD = 0.5;

/** Env var name holding the verification command (REQUIRED). */
export const DAG_VERIFY_CMD_ENV = "PI_DYNAMIC_DAG_VERIFY_CMD";

/** Verification command timeout (ms). */
export const DAG_VERIFY_TIMEOUT_MS = 300_000;

/** Git operation timeout (ms). */
export const DAG_GIT_TIMEOUT_MS = 30_000;

// Heuristic recommendation weights (design spec §3.1).
/** Weight for downstream dependency count (criticality). */
export const W_CRITICAL = 15;
/** Weight bonus for spike probes (always run the probe first). */
export const W_SPIKE = 100;
/** Weight penalty for complexity (prefer simpler tasks). */
export const W_COMPLEXITY = 5;
/** Weight bonus for confidence (prefer well-understood tasks). */
export const W_CONFIDENCE = 2;

/** Statuses that still represent unfinished work. */
const ACTIVE_STATUSES: readonly TaskStatus[] = [
	"CREATED",
	"ESTIMATING",
	"SPIKING",
	"DECOMPOSING",
	"READY",
	"RUNNING",
	"VERIFYING",
	"BLOCKED",
];

export function isTaskActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

/** Single source of truth for status icon rendering. */
export const STATUS_ICON: Record<TaskStatus, string> = {
	CREATED: "○",
	ESTIMATING: "◌",
	SPIKING: "🔍",
	DECOMPOSING: "⚙",
	READY: "▶",
	RUNNING: "●",
	VERIFYING: "✓",
	BLOCKED: "⏸",
	DONE: "✔",
	FAILED: "✖",
};

// Re-export ExtensionAPI type so side-effect modules (git.ts / verify.ts) can
// import getApi() without depending on the coding-agent package directly.
export type { ExtensionAPI };
