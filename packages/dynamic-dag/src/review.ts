/**
 * 3-stage decomposition review pipeline.
 *
 * Stage 1 — Static JSON schema validation.
 * Stage 2 — Architect LLM semantic review (fail-open).
 * Stage 3 — Topological cycle detection on dependsOn edges.
 *
 * Rejection increments decomposeRetries on the parent. After DECOMPOSE_MAX_RETRIES
 * (2) the parent is marked BLOCKED and the user is notified.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ArchitectReviewResult, reviewDecomposition } from "./architect.ts";
import type { DagState, DecompositionReview, TaskNode } from "./types.ts";
import { DECOMPOSE_MAX_RETRIES } from "./types.ts";

// ===========================================================================
// Stage 1 — Static schema validation
// ===========================================================================

interface ChildDef {
	title: string;
	description: string;
	complexity?: number;
	kind?: string;
	boundary?: string;
	dependsOn?: string[];
}

function validateSchema(state: DagState, children: ChildDef[]): DecompositionReview | null {
	if (!Array.isArray(children) || children.length === 0) {
		return {
			status: "REJECTED",
			failed_criteria: "SCHEMA_VIOLATION",
			reason: "子任务列表为空。至少需要一个子任务。",
		};
	}

	// Collect all known task ids for dependsOn validation
	const knownIds = new Set(Object.keys(state.tasks));

	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!child.title || typeof child.title !== "string" || child.title.trim().length === 0) {
			return {
				status: "REJECTED",
				failed_criteria: "SCHEMA_VIOLATION",
				reason: `子任务 ${i + 1} 缺少 title。`,
			};
		}
		if (!child.description || typeof child.description !== "string" || child.description.trim().length === 0) {
			return {
				status: "REJECTED",
				failed_criteria: "SCHEMA_VIOLATION",
				reason: `子任务 "${child.title}" 缺少 description。`,
			};
		}
		// Each child complexity must be <= 5 (or undefined — will be assessed)
		if (child.complexity !== undefined && child.complexity > 5) {
			return {
				status: "REJECTED",
				failed_criteria: "SCHEMA_VIOLATION",
				reason: `子任务 "${child.title}" 复杂度 ${child.complexity} 超过上限 5。必须拆分为更小的任务。`,
			};
		}
		// dependsOn references must exist in DAG or within the batch
		if (child.dependsOn) {
			for (const dep of child.dependsOn) {
				if (!knownIds.has(dep)) {
					return {
						status: "REJECTED",
						failed_criteria: "IO_CONTRACT_MISMATCH",
						reason: `子任务 "${child.title}" 依赖 "${dep}"，但该任务不存在于 DAG 中。`,
					};
				}
			}
		}
	}

	return null; // passed
}

// ===========================================================================
// Stage 3 — Topological cycle detection
// ===========================================================================

function detectCycles(children: ChildDef[]): DecompositionReview | null {
	// Build adjacency from children's dependsOn
	// Map of child index → its dependencies (by task id)
	const childIds: string[] = [];
	const adjacency = new Map<string, Set<string>>();

	for (let i = 0; i < children.length; i++) {
		const tempId = `_child_${i}`;
		childIds.push(tempId);
		const deps = new Set<string>();
		const child = children[i];
		if (child.dependsOn) {
			for (const dep of child.dependsOn) {
				deps.add(dep);
			}
		}
		adjacency.set(tempId, deps);
	}

	// DFS-based cycle detection
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();

	for (const id of childIds) {
		color.set(id, WHITE);
	}

	function dfs(node: string): string[] | null {
		const c = color.get(node);
		if (c === GRAY) return [node]; // cycle detected
		if (c === BLACK) return null;

		color.set(node, GRAY);
		const deps = adjacency.get(node);
		if (deps) {
			for (const dep of deps) {
				const cycle = dfs(dep);
				if (cycle) {
					cycle.unshift(node);
					return cycle;
				}
			}
		}
		color.set(node, BLACK);
		return null;
	}

	for (const id of childIds) {
		const cycle = dfs(id);
		if (cycle) {
			// Translate _child_N back to readable names
			const cycleNames = cycle
				.filter((n) => n.startsWith("_child_"))
				.map((n) => {
					const idx = childIds.indexOf(n);
					return idx >= 0 ? children[idx].title : n;
				});
			return {
				status: "REJECTED",
				failed_criteria: "CYCLE_DETECTED",
				reason: `检测到循环依赖: ${cycleNames.join(" → ")}。`,
				refinement_suggestion: "请检查 dependsOn 关系，移除形成环路的依赖。",
			};
		}
	}

	return null; // passed
}

// ===========================================================================
// 3-stage pipeline entry
// ===========================================================================

export interface ReviewResult {
	review: DecompositionReview;
	/** Updated DagState (parent's decomposeRetries incremented on reject, or BLOCKED on exhaustion). */
	state: DagState;
}

/**
 * Run the full 3-stage review pipeline on a proposed decomposition.
 *
 * - stage1 failure → REJECTED, retry
 * - stage2 (Architect LLM) failure → REJECTED, retry (fail-open on infra error = APPROVE)
 * - stage3 failure → REJECTED, retry
 *
 * On rejection: increment parent.decomposeRetries. If >= DECOMPOSE_MAX_RETRIES,
 * mark parent BLOCKED and add a notification reason.
 */
export async function runDecompositionReview(
	state: DagState,
	parentTask: TaskNode,
	children: ChildDef[],
	ctx: ExtensionContext,
): Promise<ReviewResult> {
	const tasks = { ...state.tasks };

	// Stage 1: Static schema validation
	const schemaResult = validateSchema(state, children);
	if (schemaResult) {
		return handleRejection(state, parentTask, schemaResult, tasks);
	}

	// Stage 2: Architect semantic review
	let architectResult: ArchitectReviewResult;
	try {
		architectResult = await reviewDecomposition(ctx, parentTask, children);
	} catch {
		architectResult = { approved: true, guidance: "评审服务异常，自动批准。" };
	}

	if (!architectResult.approved) {
		const review: DecompositionReview = {
			status: "REJECTED",
			failed_criteria:
				architectResult.guidance.includes("SOLVABLE") ||
				architectResult.guidance.includes("可解") ||
				architectResult.guidance.includes("可行性")
					? "UNSOLVABLE"
					: architectResult.guidance.includes("完备") || architectResult.guidance.includes("completeness")
						? "INCOMPLETE"
						: architectResult.guidance.includes("冗余") || architectResult.guidance.includes("redundant")
							? "REDUNDANT"
							: architectResult.guidance.includes("契约") || architectResult.guidance.includes("contract")
								? "IO_CONTRACT_MISMATCH"
								: undefined,
			reason: architectResult.guidance,
		};
		return handleRejection(state, parentTask, review, tasks);
	}

	// Stage 3: Topological cycle detection
	const cycleResult = detectCycles(children);
	if (cycleResult) {
		return handleRejection(state, parentTask, cycleResult, tasks);
	}

	// All stages passed
	return {
		review: { status: "APPROVED" },
		state,
	};
}

function handleRejection(
	state: DagState,
	parentTask: TaskNode,
	review: DecompositionReview,
	tasks: Record<string, TaskNode>,
): ReviewResult {
	const retries = parentTask.decomposeRetries + 1;

	if (retries >= DECOMPOSE_MAX_RETRIES) {
		// Exhausted retries — BLOCK the parent
		tasks[parentTask.id] = {
			...parentTask,
			status: "BLOCKED",
			decomposeRetries: retries,
			resultSummary: `分解失败（已重试 ${retries} 次）: ${review.reason}`,
		};
		return {
			review: {
				...review,
				reason: `${review.reason}\n\n已超过最大重试次数 (${DECOMPOSE_MAX_RETRIES})，任务已挂起。请手动处理或修改需求后重试。`,
			},
			state: { ...state, tasks },
		};
	}

	// Retry — keep in DECOMPOSING, increment retries
	tasks[parentTask.id] = {
		...parentTask,
		decomposeRetries: retries,
	};
	return {
		review,
		state: { ...state, tasks },
	};
}
