/**
 * Architect review gate.
 *
 * Before a Worker's decomposition is committed to the DAG, an LLM with global
 * god-view ("Architect") reviews it for "reinventing the wheel" or directionally
 * wrong splits. On REJECT the decomposition is blocked and guidance is returned.
 *
 * Fail-open contract: if no model is configured, no API key resolves, the LLM
 * errors, or its JSON is unparseable, the review APPROVES. The Architect never
 * blocks the pipeline on infrastructure failure — only on a deliberate REJECT.
 */
import { type Context, completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskNode } from "./types.ts";

const SYSTEM_PROMPT =
	"你是全局上帝视野的架构师评审节点。评审 Worker 提交的任务拆解。若判定" +
	"“乱造轮子”或“方向南辕北辙”则 REJECT 并附指导意见；否则 APPROVE。" +
	'只输出 JSON：{"decision":"APPROVE"|"REJECT","guidance":"..."}';

export interface DecompositionReviewInput {
	title: string;
	description: string;
}

/** Result of an architect review: approval flag and (on reject) guidance. */
export interface DecompositionReview {
	approved: boolean;
	guidance: string;
}

/**
 * Ask the Architect to approve or reject a proposed decomposition.
 *
 * - `ctx.model` undefined → APPROVE (no model configured).
 * - API key unresolved → APPROVE.
 * - Any LLM/parse error → APPROVE (fail-open).
 */
export async function reviewDecomposition(
	ctx: ExtensionContext,
	parentTask: TaskNode,
	children: DecompositionReviewInput[],
): Promise<DecompositionReview> {
	const model = ctx.model;
	if (!model) return { approved: true, guidance: "" };

	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	} catch {
		return { approved: true, guidance: "" };
	}
	if (apiKey === undefined) return { approved: true, guidance: "" };

	const childList = children.map((c, i) => `  ${i + 1}. ${c.title}\n     ${c.description}`).join("\n");
	const userContent =
		`父任务：\n  ${parentTask.title}\n  ${parentTask.description}\n\n` +
		`拟拆解为以下子任务：\n${childList}\n\n请评审。`;

	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
	};

	let raw: string;
	try {
		const msg = await completeSimple(model, context, {
			apiKey,
			signal: ctx.signal,
		});
		raw = extractText(msg.content);
	} catch {
		return { approved: true, guidance: "" };
	}

	return parseDecision(raw);
}

/** Pull the first text part out of an AssistantMessage content array. */
function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}

/** Parse the Architect's JSON decision. Any failure → APPROVE (fail-open). */
function parseDecision(raw: string): DecompositionReview {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		return { approved: true, guidance: "" };
	}
	let parsed: { decision?: string; guidance?: string };
	try {
		parsed = JSON.parse(raw.slice(start, end + 1)) as { decision?: string; guidance?: string };
	} catch {
		return { approved: true, guidance: "" };
	}
	if (parsed.decision === "REJECT") {
		return { approved: false, guidance: parsed.guidance ?? "架构师驳回，但未给出指导意见。" };
	}
	return { approved: true, guidance: parsed.guidance ?? "" };
}
