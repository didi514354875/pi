/**
 * Pure fact-graph operations.
 *
 * Provides path-based fact lookup (Proof-of-Knowledge gate), fact merging with
 * conflict detection, and fact invalidation.
 */
import { sep } from "node:path";
import type { DagState, Fact } from "./types.ts";

/** Normalize a path to posix separators (`\\` → `/`). Windows-aware, no-op on posix. */
export function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Generate a stable fact id `F_<6hex>`. */
export function generateFactId(existing: Fact[]): string {
	const crypto = (globalThis as { crypto?: { randomUUID(): string } }).crypto;
	const ids = new Set(existing.map((f) => f.id));
	for (;;) {
		let hex = "";
		if (crypto) {
			hex = crypto.randomUUID().slice(0, 6);
		} else {
			hex = Math.random().toString(16).slice(2, 8);
		}
		const id = `F_${hex}`;
		if (!ids.has(id)) return id;
	}
}

/**
 * Find the strongest non-EXPIRED fact by semantic key.
 * EXPIRED facts never authorize work, so they are excluded.
 */
export function getActiveFact(state: DagState, key: string): Fact | undefined {
	return state.facts.find((f) => f.key === key && f.status !== "EXPIRED");
}

/**
 * All facts (any status) whose key OR evidencePaths contain `path`.
 * Used for diagnostics and conflict inspection. Path is posix-normalized.
 */
export function factsSupportingPath(state: DagState, path: string): Fact[] {
	const posix = toPosix(path);
	return state.facts.filter((f) => f.key.includes(posix) || f.evidencePaths.some((ep) => toPosix(ep).includes(posix)));
}

/**
 * Does any non-EXPIRED fact cover `filePath`? Returns the strongest supporting
 * fact (highest confidence) or undefined. Matching is prefix-based: the fact's
 * key (or any evidencePaths entry) must be a prefix of the normalized filePath.
 */
export function findFactForPath(state: DagState, filePath: string): Fact | undefined {
	const posix = toPosix(filePath);
	const segments = posix.split("/");
	let best: Fact | undefined;
	let bestConfidence = -1;

	for (const fact of state.facts) {
		if (fact.status === "EXPIRED") continue;
		// Match fact key as prefix
		if (matchesPrefix(fact.key, posix, segments)) {
			if (fact.confidence > bestConfidence) {
				best = fact;
				bestConfidence = fact.confidence;
			}
			continue;
		}
		// Match evidence paths as prefix
		for (const ep of fact.evidencePaths) {
			if (matchesPrefix(toPosix(ep), posix, segments)) {
				if (fact.confidence > bestConfidence) {
					best = fact;
					bestConfidence = fact.confidence;
				}
				break;
			}
		}
	}
	return best;
}

/** Whether `prefix` (posix) is a prefix of `fullPath` (posix), segment-aware. */
function matchesPrefix(prefix: string, fullPath: string, fullSegments: string[]): boolean {
	if (!prefix) return false;
	if (fullPath.startsWith(prefix)) return true;
	// Segment-aware: "app/auth" matches "app/auth/routes.py"
	const prefixSegs = prefix.split("/");
	if (prefixSegs.length > fullSegments.length) return false;
	for (let i = 0; i < prefixSegs.length; i++) {
		if (prefixSegs[i] !== fullSegments[i]) return false;
	}
	return true;
}

/**
 * Merge new facts into state, handling CONFLICT (same key, different value).
 * Fact arrays are deduplicated by id.
 */
export function mergeFacts(state: DagState, newFacts: Fact[]): DagState {
	const existing = state.facts;
	const keyMap = new Map<string, number>();
	for (let i = 0; i < existing.length; i++) {
		keyMap.set(existing[i].key, i);
	}

	const merged = [...existing];
	for (const nf of newFacts) {
		const idx = keyMap.get(nf.key);
		if (idx !== undefined) {
			const ef = merged[idx];
			if (ef.value !== nf.value && ef.status !== "EXPIRED") {
				merged[idx] = { ...ef, status: "CONFLICT", updatedAt: Date.now() };
			}
		} else {
			merged.push(nf);
			keyMap.set(nf.key, merged.length - 1);
		}
	}

	return { ...state, facts: merged };
}

/**
 * Mark facts whose key matches any of `keys` as EXPIRED.
 * Non-matching facts are untouched. Returns a new state.
 */
export function invalidateFacts(state: DagState, keys: string[]): DagState {
	const keySet = new Set(keys);
	const facts = state.facts.map((f) =>
		keySet.has(f.key) ? { ...f, status: "EXPIRED" as const, updatedAt: Date.now() } : f,
	);
	return { ...state, facts };
}

/** Build a Fact from Spike/seed input. Assigns id and timestamps. */
export function makeFact(
	input: {
		key: string;
		value: string;
		source: string;
		confidence: number;
		evidencePaths: string[];
	},
	existing: Fact[] = [],
): Fact {
	return {
		id: generateFactId(existing),
		key: input.key,
		value: input.value,
		source: input.source,
		confidence: input.confidence,
		evidencePaths: input.evidencePaths,
		status: "VALID",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}
