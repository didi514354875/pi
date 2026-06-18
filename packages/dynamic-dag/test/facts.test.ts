import { describe, expect, it } from "vitest";
import { findFactForPath, getActiveFact, invalidateFacts, mergeFacts, toPosix } from "../src/facts.ts";
import type { DagState, Fact } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid Fact factory for tests. */
function fact(over: Partial<Fact> & Pick<Fact, "key" | "value">): Fact {
	return {
		id: over.id ?? `F_test_${Math.random().toString(16).slice(2, 8)}`,
		key: over.key,
		value: over.value,
		source: over.source ?? "test",
		confidence: over.confidence ?? 0.8,
		evidencePaths: over.evidencePaths ?? [],
		status: over.status ?? "VALID",
		createdAt: over.createdAt ?? 0,
		updatedAt: over.updatedAt ?? 0,
	};
}

/** Create a DagState with the given facts, all other fields at defaults. */
function stateWith(facts: Fact[]): DagState {
	return {
		tasks: {},
		rootTaskIds: [],
		currentTaskId: null,
		totalIterations: 0,
		facts,
		adrs: [],
		paused: false,
	};
}

// ---------------------------------------------------------------------------
// toPosix
// ---------------------------------------------------------------------------

describe("toPosix", () => {
	it("converts backslashes to forward slashes", () => {
		expect(toPosix("a\\b\\c.py")).toBe("a/b/c.py");
	});

	it("leaves posix paths unchanged", () => {
		expect(toPosix("a/b/c.py")).toBe("a/b/c.py");
	});

	it("handles mixed separators", () => {
		expect(toPosix("a\\b/c.py")).toBe("a/b/c.py");
	});
});

// ---------------------------------------------------------------------------
// getActiveFact
// ---------------------------------------------------------------------------

describe("getActiveFact", () => {
	it("returns VALID fact by key", () => {
		const state = stateWith([fact({ key: "db", value: "MySQL" })]);
		expect(getActiveFact(state, "db")?.value).toBe("MySQL");
	});

	it("skips EXPIRED fact (returns undefined)", () => {
		const state = stateWith([fact({ key: "db", value: "MySQL", status: "EXPIRED" })]);
		expect(getActiveFact(state, "db")).toBeUndefined();
	});

	it("returns CONFLICT fact as fallback", () => {
		const f = fact({ key: "db", value: "MySQL", status: "CONFLICT" });
		const state = stateWith([f]);
		expect(getActiveFact(state, "db")?.value).toBe("MySQL");
	});

	it("returns undefined for missing key", () => {
		const state = stateWith([fact({ key: "db", value: "MySQL" })]);
		expect(getActiveFact(state, "nonexistent")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// findFactForPath
// ---------------------------------------------------------------------------

describe("findFactForPath", () => {
	it("finds a fact by exact evidence path match", () => {
		const f = fact({ key: "app", value: "main file", evidencePaths: ["app/index.ts"] });
		const state = stateWith([f]);
		expect(findFactForPath(state, "app/index.ts")?.value).toBe("main file");
	});

	it("finds a fact by prefix match (dir covers file)", () => {
		const f = fact({ key: "auth", value: "auth module", evidencePaths: ["app/auth"] });
		const state = stateWith([f]);
		expect(findFactForPath(state, "app/auth/login.py")?.value).toBe("auth module");
	});

	it("finds a fact by key match", () => {
		const f = fact({ key: "app/db.py", value: "database module" });
		const state = stateWith([f]);
		expect(findFactForPath(state, "app/db.py")?.value).toBe("database module");
	});

	it("returns undefined when path is not covered", () => {
		const f = fact({ key: "app", value: "main", evidencePaths: ["app/auth"] });
		const state = stateWith([f]);
		expect(findFactForPath(state, "other/unrelated.py")).toBeUndefined();
	});

	it("rejects EXPIRED facts even if path matches", () => {
		const f = fact({
			key: "app",
			value: "main",
			evidencePaths: ["app/index.ts"],
			status: "EXPIRED",
		});
		const state = stateWith([f]);
		expect(findFactForPath(state, "app/index.ts")).toBeUndefined();
	});

	it("returns highest-confidence fact when multiple match", () => {
		const f1 = fact({ key: "app", value: "low", evidencePaths: ["app/x"], confidence: 0.1 });
		const f2 = fact({ key: "app", value: "high", evidencePaths: ["app/x"], confidence: 0.9 });
		const state = stateWith([f1, f2]);
		expect(findFactForPath(state, "app/x/main.ts")?.value).toBe("high");
	});
});

// ---------------------------------------------------------------------------
// mergeFacts
// ---------------------------------------------------------------------------

describe("mergeFacts", () => {
	it("appends a new fact when key does not exist", () => {
		const state = stateWith([]);
		const f = fact({ key: "db", value: "MySQL" });
		const merged = mergeFacts(state, [f]);
		expect(merged.facts).toHaveLength(1);
		expect(merged.facts[0].value).toBe("MySQL");
	});

	it("detects CONFLICT for same key but different value", () => {
		const f1 = fact({ key: "db", value: "MySQL" });
		const state = stateWith([f1]);
		const f2 = fact({ key: "db", value: "PostgreSQL" });
		const merged = mergeFacts(state, [f2]);

		// The old fact (MySQL) is marked CONFLICT. The incoming fact is
		// NOT pushed — only the existing entry is updated.
		expect(merged.facts).toHaveLength(1);
		const old = merged.facts[0];
		expect(old.status).toBe("CONFLICT");
		expect(old.value).toBe("MySQL");
	});

	it("returns state with same facts when input is empty", () => {
		const state = stateWith([fact({ key: "db", value: "MySQL" })]);
		const result = mergeFacts(state, []);
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0].key).toBe("db");
	});

	it("leaves existing fact unchanged when same key and same value", () => {
		const f1 = fact({ key: "db", value: "MySQL" });
		const state = stateWith([f1]);
		const f2 = fact({ key: "db", value: "MySQL" });
		const merged = mergeFacts(state, [f2]);

		expect(merged.facts).toHaveLength(1);
		expect(merged.facts[0].status).toBe("VALID");
	});
});

// ---------------------------------------------------------------------------
// invalidateFacts
// ---------------------------------------------------------------------------

describe("invalidateFacts", () => {
	it("marks matching facts as EXPIRED", () => {
		const f1 = fact({ key: "db", value: "MySQL" });
		const f2 = fact({ key: "framework", value: "FastAPI" });
		const state = stateWith([f1, f2]);
		const invalidated = invalidateFacts(state, ["db"]);

		expect(invalidated.facts.find((f) => f.key === "db")?.status).toBe("EXPIRED");
		expect(invalidated.facts.find((f) => f.key === "framework")?.status).toBe("VALID");
	});

	it("returns equivalent state for non-matching keys", () => {
		const state = stateWith([fact({ key: "db", value: "MySQL" })]);
		const result = invalidateFacts(state, ["nonexistent"]);
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0].status).toBe("VALID");
	});

	it("returns equivalent state with empty keys", () => {
		const state = stateWith([fact({ key: "db", value: "MySQL" })]);
		const result = invalidateFacts(state, []);
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0].status).toBe("VALID");
	});

	it("preserves EXPIRED status on already-EXPIRED facts", () => {
		const f = fact({ key: "db", value: "MySQL", status: "EXPIRED" });
		const state = stateWith([f]);
		const result = invalidateFacts(state, ["db"]);
		expect(result.facts[0].status).toBe("EXPIRED");
		expect(result.facts[0].key).toBe("db");
		expect(result.facts[0].value).toBe("MySQL");
	});
});
