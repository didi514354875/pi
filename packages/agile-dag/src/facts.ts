/**
 * Pure fact-graph operations (v3.2).
 *
 * All functions are pure and immutable — they return a new state and never
 * mutate the input. Shared by engine.ts (transitions) and tools.ts (validation).
 *
 * Path semantics: every evidence path and proposed-target path is normalized
 * to posix (`a/b/c.py`) before comparison. Proof-of-Knowledge uses prefix
 * matching — a fact whose evidence path is `app/auth` authorizes `app/auth.py`
 * and `app/auth/handlers.py`.
 */
import { sep } from "node:path";
import type { DagState, Fact } from "./types.ts";

/** Normalize a path to posix separators (`\\` → `/`). Windows-aware, no-op on posix. */
export function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Generate a stable fact id `F_<6hex>`. Caller controls randomness via Date.now/Math. */
function generateFactId(existing: Fact[]): string {
	const ids = new Set(existing.map((f) => f.id));
	const rand = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
	const id = `F_${rand}`;
	return ids.has(id) ? `F_${rand}${Date.now().toString(16).slice(0, 2)}` : id;
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
	return state.facts.filter((f) => {
		if (f.key === posix) return true;
		return f.evidencePaths.some((ev) => toPosix(ev) === posix);
	});
}

/**
 * Does any non-EXPIRED fact cover `filePath`? Returns the strongest supporting
 * fact (highest confidence), or undefined if none.
 *
 * Coverage rule (prefix match on posix paths): a fact's evidence path `app/auth`
 * covers `app/auth.py` and `app/auth/sub.py`. Exact matches also cover.
 */
export function findFactForPath(state: DagState, filePath: string): Fact | undefined {
	const posix = toPosix(filePath);
	let best: Fact | undefined;
	for (const f of state.facts) {
		if (f.status === "EXPIRED") continue;
		const covered = f.evidencePaths.some((ev) => {
			const evPosix = toPosix(ev);
			return evPosix === posix || posix.startsWith(`${evPosix}/`);
		});
		// A path-fact whose key IS the glob also counts as evidence.
		const keyCovers = f.key === posix || posix.startsWith(`${f.key}/`);
		if (!covered && !keyCovers) continue;
		if (!best || f.confidence > best.confidence) best = f;
	}
	return best;
}

/**
 * Merge new facts into state, handling CONFLICT (same key, different value)
 * and dedup by key.
 *
 *  - same key + same value → refresh updatedAt + union of evidencePaths.
 *  - same key + different value → old marked CONFLICT, new appended as VALID.
 *  - new key → appended as VALID.
 */
export function mergeFacts(state: DagState, newFacts: Fact[]): DagState {
	if (newFacts.length === 0) return state;
	const facts = [...state.facts];
	for (const incoming of newFacts) {
		const idx = facts.findIndex((f) => f.key === incoming.key && f.status !== "EXPIRED");
		if (idx === -1) {
			facts.push(incoming);
			continue;
		}
		const existing = facts[idx];
		if (existing.value === incoming.value) {
			// Reinforce: union evidence, refresh timestamp.
			const unionPaths = Array.from(new Set([...existing.evidencePaths, ...incoming.evidencePaths]));
			facts[idx] = {
				...existing,
				evidencePaths: unionPaths,
				updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
				status: "VALID",
			};
		} else {
			// Conflict: demote old, append new (both kept; getActiveFact returns VALID).
			facts[idx] = { ...existing, status: "CONFLICT" };
			facts.push(incoming);
		}
	}
	return { ...state, facts };
}

/**
 * Mark facts whose key matches any of `keys` as EXPIRED.
 * Non-matching facts are untouched. Returns a new state.
 */
export function invalidateFacts(state: DagState, keys: string[]): DagState {
	if (keys.length === 0) return state;
	const keySet = new Set(keys);
	let changed = false;
	const facts = state.facts.map((f) => {
		if (!keySet.has(f.key)) return f;
		if (f.status === "EXPIRED") return f;
		changed = true;
		return { ...f, status: "EXPIRED" as const, updatedAt: Date.now() };
	});
	return changed ? { ...state, facts } : state;
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
	const now = Date.now();
	return {
		id: generateFactId(existing),
		key: input.key,
		value: input.value,
		source: input.source,
		confidence: input.confidence,
		evidencePaths: input.evidencePaths,
		status: "VALID",
		createdAt: now,
		updatedAt: now,
	};
}
