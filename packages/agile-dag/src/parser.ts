/**
 * Multi-source plan parser.
 *
 * Accepts three input shapes, tried in order:
 *  1. `<proposed_plan>` XML blocks with <task> elements.
 *  2. Markdown numbered lists under a "Plan:" header.
 *  3. Free-text fallback → a single root task.
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

interface XmlTask {
	id: string;
	title: string;
	description: string;
	dependsOn: string[];
}

/** Extract tasks from `<proposed_plan>` XML blocks. */
function parseXmlPlan(text: string): ParsedTask[] | null {
	const planMatch = text.match(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/i);
	if (!planMatch) return null;

	const body = planMatch[1];
	const taskPattern = /<task(?:\s+([^>]*))?>([\s\S]*?)<\/task>/gi;
	const xmlTasks: XmlTask[] = [];
	let match: RegExpExecArray | null = taskPattern.exec(body);
	let index = 0;
	while (match !== null) {
		const attrs = match[1] ?? "";
		const content = match[2].trim();
		const idMatch = attrs.match(/id\s*=\s*"([^"]*)"/i);
		const depMatch = attrs.match(/depends_on\s*=\s*"([^"]*)"/i);
		const rawId = idMatch?.[1]?.trim();
		const taskId = rawId && rawId.length > 0 ? rawId : `T${index}`;
		const dependsOn = depMatch?.[1] ? depMatch[1].split(/[,\s]+/).filter((s) => s.length > 0) : [];
		xmlTasks.push({ id: taskId, title: cleanTitle(content), description: content, dependsOn });
		index++;
		match = taskPattern.exec(body);
	}

	return xmlTasks.map((t) => ({
		title: t.title,
		description: t.description,
		dependsOn: t.dependsOn,
		key: t.id,
	}));
}

/** Extract numbered-list tasks under a "Plan:" header. */
function parseMarkdownPlan(text: string): ParsedTask[] | null {
	const headerMatch = text.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return null;

	const section = text.slice(text.indexOf(headerMatch[0]) + headerMatch[0].length);
	const pattern = /^\s*(\d+)[.)]\s+([^\n]+)/gm;
	const items: ParsedTask[] = [];
	let match: RegExpExecArray | null = pattern.exec(section);
	while (match !== null) {
		const raw = match[2].trim();
		if (raw.length < 3 || raw.startsWith("`") || raw.startsWith("/") || raw.startsWith("-")) {
			match = pattern.exec(section);
			continue;
		}
		const cleaned = cleanTitle(raw);
		if (cleaned.length <= 3) {
			match = pattern.exec(section);
			continue;
		}
		const key = `T${match[1]}`;
		items.push({ title: cleaned, description: cleaned, dependsOn: [], key });
		match = pattern.exec(section);
	}

	// Markdown lists are sequential: each item depends on its predecessor.
	const sequential: ParsedTask[] = [];
	for (let i = 0; i < items.length; i++) {
		const dependsOn = i > 0 ? [items[i - 1].key] : [];
		sequential.push({ ...items[i], dependsOn });
	}
	return sequential.length > 0 ? sequential : null;
}

/** Free-text fallback: single root task. */
function parseFreeText(text: string): ParsedTask[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) return [];
	const firstLine = trimmed.split("\n")[0]?.trim() ?? trimmed;
	return [
		{
			title: cleanTitle(firstLine),
			description: trimmed,
			dependsOn: [],
			key: "T0",
		},
	];
}

/**
 * Parse plan input text into tasks.
 *
 * Returns an empty array only when the input is blank or whitespace-only.
 */
export function parsePlanInput(text: string): ParsedTask[] {
	if (!text || text.trim().length === 0) return [];

	const xml = parseXmlPlan(text);
	if (xml && xml.length > 0) return xml;

	const markdown = parseMarkdownPlan(text);
	if (markdown && markdown.length > 0) return markdown;

	return parseFreeText(text);
}
