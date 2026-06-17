import { describe, expect, it } from "vitest";
import { parsePlanInput } from "../src/parser.ts";

describe("parsePlanInput — XML", () => {
	it("parses <proposed_plan> with multiple tasks", () => {
		const input = `<proposed_plan>
<task id="T1">Setup database</task>
<task id="T2" depends_on="T1">Build API</task>
<task id="T3" depends_on="T2">Write tests</task>
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
<task>First task</task>
<task>Second task</task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(2);
		expect(result[0].key).toBe("T0");
		expect(result[1].key).toBe("T1");
	});

	it("parses single task in proposed_plan", () => {
		const input = `<proposed_plan><task id="only">Just one</task></proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Just one");
	});
});

describe("parsePlanInput — Markdown", () => {
	it("parses numbered list under Plan: header", () => {
		const input = `Here is the plan:

Plan:
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
		const input = `Plan:
1. First step
2. Second step
3. Third step`;

		const result = parsePlanInput(input);
		expect(result[0].dependsOn).toEqual([]);
		expect(result[1].dependsOn).toEqual([result[0].key]);
		expect(result[2].dependsOn).toEqual([result[1].key]);
	});

	it("handles markdown with bold/code formatting", () => {
		const input = `Plan:
1. **Create** the \`config\` file
2. Update settings`;

		const result = parsePlanInput(input);
		expect(result).toHaveLength(2);
		expect(result[0].title).toBe("Create the config file");
	});

	it("handles parenthesized numbering", () => {
		const input = `Plan:
1) First
2) Second`;

		const result = parsePlanInput(input);
		expect(result).toHaveLength(2);
	});

	it("returns null for Plan: header with no valid items", () => {
		// Falls through to free text
		const input = `Plan:\n\nSome description text without numbered items`;
		const result = parsePlanInput(input);
		// Free text fallback produces a single root task
		expect(result).toHaveLength(1);
	});
});

describe("parsePlanInput — Free text", () => {
	it("creates a single root task from free text", () => {
		const input = "Do everything that needs to be done";
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Do everything that needs to be done");
		expect(result[0].dependsOn).toEqual([]);
		expect(result[0].key).toBe("T0");
	});

	it("uses first line as title, full text as description", () => {
		const input = "First line is title\nSecond line is body\nThird line too";
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("First line is title");
		expect(result[0].description).toContain("Second line is body");
	});

	it("handles multi-line epic description", () => {
		const input = "Refactor the entire authentication system\n\nThis involves OAuth, JWT, and session management.";
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].description).toContain("OAuth");
	});
});

describe("parsePlanInput — Edge cases", () => {
	it("returns empty array for empty string", () => {
		expect(parsePlanInput("")).toEqual([]);
	});

	it("returns empty array for whitespace-only input", () => {
		expect(parsePlanInput("   \n\t  \n ")).toEqual([]);
	});

	it("cleans bold/code prefixes from titles", () => {
		const input = `<proposed_plan>
<task id="T1">**Important** \`task\` name</task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result[0].title).toBe("Important task name");
	});

	it("capitalizes first letter of title", () => {
		const input = `<proposed_plan>
<task id="T1">lowercase start</task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result[0].title.charAt(0)).toBe("L");
	});

	it("truncates very long titles", () => {
		const longTitle = "A".repeat(200);
		const input = `<proposed_plan>
<task id="T1">${longTitle}</task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result[0].title.length).toBeLessThanOrEqual(80);
		expect(result[0].title.endsWith("...")).toBe(true);
	});

	it("prefers XML over markdown when both present", () => {
		const input = `Plan:
1. Markdown item

<proposed_plan>
<task id="X">XML item</task>
</proposed_plan>`;
		const result = parsePlanInput(input);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("XML item");
	});
});
