/**
 * Agile-DAG core data model (v3.1).
 *
 * The task DAG is a backend state machine that owns the transaction boundary
 * (Git commit/reset) and the verification gate (test pipeline). The agent only
 * writes code and self-assesses complexity; "done" is confirmed by the engine.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Lifecycle of a task node in the DAG. */
export type TaskStatus =
	| "CREATED" // not yet assessed
	| "READY" // assessed, cleared to execute
	| "RUNNING" // agent is executing
	| "VERIFYING" // engine is running the verification pipeline
	| "BLOCKED" // has unresolved child tasks or spike dependency
	| "DONE"
	| "FAILED";

/** Kind of task node — drives prompt rendering and read-only enforcement. */
export type TaskKind = "standard" | "spike" | "contract";

/** Lifecycle of a fact in the knowledge graph. */
export type FactStatus = "VALID" | "CONFLICT" | "EXPIRED";

/**
 * A single objective fact harvested by Spike tasks (or seeded at day-zero).
 * Replaces the v3.1 `Record<string,string>` blackboard with a richer model
 * carrying provenance, confidence, and evidence paths for the Proof-of-
 * Knowledge gate.
 */
export interface Fact {
	/** Stable id: `F_<6hex>`. */
	id: string;
	/** Semantic key, e.g. "auth_library". For path-facts the key IS the glob path "app/auth.py". */
	key: string;
	/** Value, e.g. "PyJWT" or for path-facts a short descriptor "auth route handler". */
	value: string;
	/** Task id that produced this fact (the Spike id, or "INIT" for day-zero). */
	source: string;
	/** 0.0-1.0. Spike-reported; day-zero facts default 0.9. */
	confidence: number;
	/** File paths cited as evidence for this fact. Drives the Proof-of-Knowledge gate. */
	evidencePaths: string[];
	status: FactStatus;
	createdAt: number;
	updatedAt: number;
}
export interface TaskNode {
	/** "T_<8hex>" generated via randomUUID slice. */
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	/** 1-10 self-assessed complexity (replaces StoryPoints). */
	complexity: number;
	/** 1-10 self-assessed risk. */
	risk: number;
	/** 1-10 self-assessed confidence. */
	confidence: number;
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
	/** Discriminator for spike/contract behavior. */
	kind: TaskKind;
	/** DoD boundary redline (e.g. "只允许修改 app/routes.py"); "" = no restriction. */
	boundary: string;
	/** When kind==="spike", the task id this probe was derived from. */
	spikeForTaskId: string | null;
	/** Verification-failure retry count (replaces fixDepth). */
	retryCount: number;
	/**
	 * Files declared at assessment as the planned modification targets.
	 * Proof-of-Knowledge input (each must trace to a fact) AND the source of
	 * the runtime `boundary` glob (joined with ",").
	 */
	proposedTargetFiles: string[];
}
export interface DagState {
	tasks: Record<string, TaskNode>;
	rootTaskIds: string[];
	/** The CREATED or RUNNING task the agent is currently working on. */
	currentTaskId: string | null;
	totalIterations: number;
	/** Global knowledge graph of objective facts harvested by Spike tasks. */
	facts: Fact[];
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

/** complexity > this forces decomposition. */
export const DAG_COMPLEXITY_THRESHOLD = 8;
/** Verification-failure retry cap before a task becomes terminal FAILED. */
export const DAG_MAX_VERIFY_RETRIES = 2;

/**
 * Confidence below this marks a fact CONFLICT candidate (v3.2 marks only;
 * arbitration is a future scope). Day-zero facts default above this.
 */
export const DAG_FACT_CONFLICT_THRESHOLD = 0.5;

/** Env var name holding the verification command (REQUIRED). */
export const DAG_VERIFY_CMD_ENV = "PI_AGILE_VERIFY_CMD";

/** Verification command timeout (ms). */
export const DAG_VERIFY_TIMEOUT_MS = 300_000;

/** Git operation timeout (ms). */
export const DAG_GIT_TIMEOUT_MS = 30_000;

// Heuristic recommendation weights (design doc §3.1).
/** Weight for downstream dependency count (criticality). */
export const W_CRITICAL = 15;
/** Weight bonus for spike probes (always run the probe first). */
export const W_SPIKE = 100;
/** Weight penalty for complexity (prefer simpler tasks). */
export const W_COMPLEXITY = 5;
/** Weight bonus for confidence (prefer well-understood tasks). */
export const W_CONFIDENCE = 2;

/** Statuses that still represent unfinished work. */
const ACTIVE_STATUSES: readonly TaskStatus[] = ["CREATED", "READY", "RUNNING", "VERIFYING", "BLOCKED"];

export function isTaskActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

/** Single source of truth for status icon rendering (shared by command.ts / ui.ts). */
export const STATUS_ICON: Record<TaskStatus, string> = {
	CREATED: "□",
	READY: "○",
	RUNNING: "►",
	VERIFYING: "⚙",
	BLOCKED: "◂",
	DONE: "✓",
	FAILED: "✕",
};

// Re-export ExtensionAPI type so side-effect modules (git.ts / verify.ts) can
// import getApi() without depending on the coding-agent package directly.
export type { ExtensionAPI };
