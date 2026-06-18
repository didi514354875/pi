import { describe, expect, it } from "vitest";
import { parsePlanInput } from "../src/parser.ts";

// ===========================================================================
// XML — <proposed_plan>
// ===========================================================================

describe("parsePlanInput — XML proposed_plan", () => {
	it("parses <proposed_plan> with multiple tasks", () => {
		const input = `<proposed_plan>
<task id="T1">
<title>Setup database</title>
<description>Set up the database schema</description>
</task>
<task id="T2" depends_on="T1">
<title>Build API</title>
<description>Build the REST API</description>
</task>
<task id="T3" depends_on="T2">
<title>Write tests</title>
<description>Write integration tests</description>
</task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(3);
		expect(result[0].key).toBe("T1");
		expect(result[0].title).toBe("Setup database");
		expect(result[1].dependsOn).toEqual(["T1"]);
		expect(result[2].dependsOn).toEqual(["T2"]);
	});

	it("parses tasks without explicit ids (auto-indexed)", () => {
		const input = `<proposed_plan>
<task><title>First task</title><description>First</description></task>
<task><title>Second task</title><description>Second</description></task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(2);
		expect(result[0].key).toBe("task_0");
		expect(result[1].key).toBe("task_1");
	});

	it("parses a single task", () => {
		const input = `<proposed_plan><task id="only"><title>Just one</title><description>Solo</description></task></proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Just one");
	});
});

// ===========================================================================
// XML — <decomposition>
// ===========================================================================

describe("parsePlanInput — XML decomposition", () => {
	it("parses <decomposition> XML format with multiple tasks", () => {
		const input = `<decomposition>
<task id="D1">
<title>Sub-task A</title>
<description>First sub-task</description>
</task>
<task id="D2" depends_on="D1">
<title>Sub-task B</title>
<description>Second sub-task</description>
</task>
</decomposition>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(2);
		expect(result[0].key).toBe("D1");
		expect(result[0].title).toBe("Sub-task A");
		expect(result[1].dependsOn).toEqual(["D1"]);
	});

	it("prefers decomposition over proposed_plan when both present", () => {
		const input = `<decomposition>
<task><title>Decomp task</title><description>From decomposition</description></task>
</decomposition>
<proposed_plan>
<task><title>Plan task</title><description>From plan</description></task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Decomp task");
	});
});

// ===========================================================================
// Markdown
// ===========================================================================

describe("parsePlanInput — Markdown", () => {
	it("parses numbered list under Plan: header", () => {
		const input = `Here is the plan:

# Plan:
1. Create file structure
2. Write content
3. Run tests`;

		const result = parsePlanInput(input);
		expect(result).toHaveLength(3);
		expect(result[0].title).toBe("Create file structure");
		expect(result[1].title).toBe("Write content");
		expect(result[2].title).toBe("Run tests");
	});

	it("creates sequential dependencies between markdown items", () => {
		const input = `# Plan:
1. First step
2. Second step
3. Third step`;

		const result = parsePlanInput(input);
		expect(result).toHaveLength(3);
		expect(result[0].dependsOn).toEqual([]);
		expect(result[1].dependsOn).toEqual([result[0].key]);
		expect(result[2].dependsOn).toEqual([result[1].key]);
	});

	it("handles parenthesized numbering", () => {
		const input = `# Plan:
1) First
2) Second`;

		const result = parsePlanInput(input);
		expect(result).toHaveLength(2);
	});
});

// ===========================================================================
// Free-text fallback
// ===========================================================================

describe("parsePlanInput — Free text", () => {
	it("creates a single root task from free text", () => {
		const input = "Do everything that needs to be done";
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Do everything that needs to be done");
		expect(result[0].dependsOn).toEqual([]);
		expect(result[0].key).toBe("task_0");
	});

	it("uses first line as title, full text as description", () => {
		const input = "First line is title\nSecond line is body\nThird line too";
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("First line is title");
		expect(result[0].description).toContain("Second line is body");
	});
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe("parsePlanInput — Edge cases", () => {
	it("returns empty array for empty string", () => {
		expect(parsePlanInput("")).toEqual([]);
	});

	it("returns empty array for whitespace-only input", () => {
		expect(parsePlanInput("   \n\t  \n ")).toEqual([]);
	});
});
