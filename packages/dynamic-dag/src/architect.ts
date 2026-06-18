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
export interface ArchitectReviewResult {
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
): Promise<ArchitectReviewResult> {
	const model = ctx.model;
	if (!model) return { approved: true, guidance: "无需模型，自动批准。" };

	let apiKey: string | undefined;
	try {
		apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	} catch {
		return { approved: true, guidance: "API key 不可用，自动批准。" };
	}
	if (apiKey === undefined) return { approved: true, guidance: "API key 未配置，自动批准。" };

	const childrenList = children
		.map((c, i) => `子任务 ${i + 1}:\n  标题: ${c.title}\n  描述: ${c.description}`)
		.join("\n\n");

	const userContent =
		`父任务：\n  ${parentTask.title}\n  ${parentTask.description}\n\n` +
		`拟拆解为以下子任务：\n${childrenList}\n\n请评审。`;

	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
	};

	try {
		const msg = await completeSimple(model, context, {
			apiKey,
			signal: ctx.signal,
		});
		return parseDecision(extractText(msg.content));
	} catch {
		return { approved: true, guidance: "架构师评审服务不可用，自动批准。" };
	}
}

/** Pull the first text part out of an AssistantMessage content array. */
function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	for (const part of content) {
		if (part.type === "text" && part.text) return part.text;
	}
	return "";
}

/** Parse the Architect's JSON decision. Any failure → APPROVE (fail-open). */
function parseDecision(raw: string): ArchitectReviewResult {
	try {
		const trimmed = raw.trim();
		// Handle markdown code fences
		let json = trimmed;
		if (json.startsWith("```")) {
			const end = json.indexOf("\n", 3);
			json = json.slice(end + 1);
			const closeIdx = json.lastIndexOf("```");
			if (closeIdx !== -1) json = json.slice(0, closeIdx);
		}
		const parsed = JSON.parse(json.trim());
		if (parsed.decision === "APPROVE" || parsed.decision === "REJECT") {
			return {
				approved: parsed.decision === "APPROVE",
				guidance: parsed.guidance ?? "",
			};
		}
		return { approved: true, guidance: "无法解析评审结果，自动批准。" };
	} catch {
		return { approved: true, guidance: "无法解析评审 JSON，自动批准。" };
	}
}
