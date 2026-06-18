/**
 * Multi-source plan parser.
 *
 * Accepts four input shapes, tried in order:
 *  1. `<proposed_plan>` XML blocks with <task> elements.
 *  2. `<decomposition>` XML blocks with <task> elements (Decomposer output).
 *  3. Markdown numbered lists under a "Plan:" header.
 *  4. Free-text fallback → a single root task.
 *
 * Each parsed task carries a stable `key` (from the source's own id when
 * available, otherwise an index) so the engine can resolve `dependsOn`
 * references between siblings before ids exist.
 */
export interface ParsedTask {
	title: string;
	description: string;
	dependsOn: string[];
	/** Stable key within this parse batch; used to resolve dependsOn in the engine. */
	key: string;
}

const TITLE_CAP = 80;

/** Strip bold/code prefixes and cap for display. */
function cleanTitle(text: string): string {
	const cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	const capped = cleaned.length > TITLE_CAP ? `${cleaned.slice(0, TITLE_CAP - 3)}...` : cleaned;
	return capped.length > 0 ? capped.charAt(0).toUpperCase() + capped.slice(1) : capped;
}

// ===========================================================================
// XML parsing
// ===========================================================================

interface XmlTask {
	id?: string;
	title: string;
	description: string;
	depends_on?: string;
}

/** Extract tasks from `<proposed_plan>` or `<decomposition>` XML blocks. */
function parseXmlBlocks(text: string, tagName: string): ParsedTask[] | null {
	const openTag = `<${tagName}>`;
	const closeTag = `</${tagName}>`;
	const start = text.indexOf(openTag);
	if (start === -1) return null;
	const end = text.indexOf(closeTag, start);
	if (end === -1) return null;

	const block = text.slice(start + openTag.length, end);
	const tasks: XmlTask[] = [];

	// Extract <task> elements
	const taskRegex = /<task\b([^>]*)>([\s\S]*?)<\/task>/gi;
	let match = taskRegex.exec(block);
	while (match !== null) {
		const attrs = match[1];
		const body = match[2];

		// Parse attributes
		const idMatch = /\bid\s*=\s*"([^"]*)"/.exec(attrs);
		const depsMatch = /\bdepends_on\s*=\s*"([^"]*)"/.exec(attrs);

		// Parse body: <title> and <description>
		const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(body);
		const descMatch = /<description>([\s\S]*?)<\/description>/i.exec(body);

		const title = titleMatch ? cleanTitle(titleMatch[1]) : "未命名任务";
		const description = descMatch ? descMatch[1].trim() : body.trim();

		tasks.push({
			id: idMatch?.[1] ?? undefined,
			title,
			description,
			depends_on: depsMatch?.[1] ?? undefined,
		});
		match = taskRegex.exec(block);
	}

	if (tasks.length === 0) return null;

	return tasks.map((t, i) => ({
		title: t.title,
		description: t.description,
		dependsOn: t.depends_on
			? t.depends_on
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [],
		key: t.id ?? `task_${i}`,
	}));
}

/** Extract tasks from `<proposed_plan>` XML blocks. */
function parseXmlPlan(text: string): ParsedTask[] | null {
	return parseXmlBlocks(text, "proposed_plan");
}

/** Extract tasks from `<decomposition>` XML blocks. */
function parseXmlDecomposition(text: string): ParsedTask[] | null {
	return parseXmlBlocks(text, "decomposition");
}

// ===========================================================================
// Markdown parsing
// ===========================================================================

/** Extract numbered-list tasks under a "Plan:" header. */
function parseMarkdownPlan(text: string): ParsedTask[] | null {
	// Find "Plan:" header
	const planMatch = /^#{1,3}\s*Plan\s*:?\s*$/im.exec(text);
	if (!planMatch) return null;

	const afterHeader = text.slice(planMatch.index + planMatch[0].length);
	const lines = afterHeader.split("\n");
	const tasks: ParsedTask[] = [];
	let currentTitle = "";
	let currentDesc = "";
	let inList = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		// Match numbered list item: "1. Title" or "1) Title"
		const itemMatch = /^\s*(\d+)[.)]\s+(.+)/.exec(line);

		if (itemMatch) {
			// Save previous task
			if (inList && currentTitle) {
				tasks.push({
					title: cleanTitle(currentTitle),
					description: currentDesc || currentTitle,
					dependsOn: tasks.length > 0 ? [tasks[tasks.length - 1].key] : [],
					key: `task_${tasks.length}`,
				});
			}
			currentTitle = itemMatch[2].trim();
			currentDesc = itemMatch[2].trim();
			inList = true;
		} else if (inList && line.trim() && !line.startsWith("#") && !/^\d+[.)]/.test(line.trim())) {
			// Continuation line for description
			currentDesc += `\n${line.trim()}`;
		} else if (inList && line.trim() === "") {
			// Blank line ends the list
			break;
		}
	}

	// Save last task
	if (inList && currentTitle) {
		tasks.push({
			title: cleanTitle(currentTitle),
			description: currentDesc || currentTitle,
			dependsOn: tasks.length > 0 ? [tasks[tasks.length - 1].key] : [],
			key: `task_${tasks.length}`,
		});
	}

	return tasks.length > 0 ? tasks : null;
}

// ===========================================================================
// Free-text fallback
// ===========================================================================

/** Free-text fallback: single root task. */
function parseFreeText(text: string): ParsedTask[] {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const lines = trimmed.split("\n");
	const firstLine = lines[0].trim();
	const title = cleanTitle(firstLine);
	const description = trimmed;

	return [{ title, description, dependsOn: [], key: "task_0" }];
}

// ===========================================================================
// Main entry
// ===========================================================================

/**
 * Parse plan input text into tasks.
 *
 * Returns an empty array only when the input is blank or whitespace-only.
 */
export function parsePlanInput(text: string): ParsedTask[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) return [];

	// Try XML formats (decomposition takes priority — more structured)
	const decomposition = parseXmlDecomposition(trimmed);
	if (decomposition) return decomposition;

	const xml = parseXmlPlan(trimmed);
	if (xml) return xml;

	// Try Markdown
	const md = parseMarkdownPlan(trimmed);
	if (md) return md;

	// Fallback
	return parseFreeText(trimmed);
}
