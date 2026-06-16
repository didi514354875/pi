/**
 * History Retrieval Extension
 *
 * Indexes every user/assistant message into a BM25 engine and exposes a
 * ContextRetrieval tool so the LLM can recall decisions, file paths, or
 * error messages that were compacted or rotated out of the context window.
 *
 * The BM25 engine runs in a long-lived Python subprocess; communication is
 * JSON-RPC over stdio (see ./python/retrieval_server.py).
 *
 * Setup:
 * 1. Install Python 3 with numpy and orjson: pip install numpy orjson
 * 2. Load: pi -e ./examples/extensions/history-retrieval
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkPythonDeps, detectPython, HistoryIndexBridge, type Turn } from "./history-index-bridge.ts";

const searchSchema = Type.Object({
	query: Type.String({ description: "Natural-language query to search past conversation turns." }),
	k: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of top matches (default 3)." })),
});

interface SearchResultDetails {
	turns: Turn[];
	error?: string;
}

/** Extract plain text from a pi message (user or assistant). */
function extractText(message: { content: unknown }): string | null {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const texts = content.filter((c): c is { type: "text"; text: string } => c?.type === "text").map((c) => c.text);
		return texts.length > 0 ? texts.join("\n") : null;
	}
	return null;
}

function formatAutoCitation(turn: Turn & { score: number }, _type: string): string {
	const text = turn.text.replace(/\n/g, "\n> ");
	return (
		`[Auto-retrieved from past conversation — relevance: ${turn.score.toFixed(2)}]\n` +
		`> **${turn.role}**\n> ${text}`
	);
}

function formatWorkingCitation(turn: Turn & { score: number }): string {
	const text = turn.text.replace(/\n/g, "\n> ");
	return `[Relevant context from our current conversation]\n> **${turn.role}**\n> ${text}`;
}

function formatRecencyCitation(turn: Turn, boostedScore: number): string {
	const text = turn.text.replace(/\n/g, "\n> ");
	return `[Recently discussed — relevance: ${boostedScore.toFixed(2)}]\n` + `> **${turn.role}**\n> ${text}`;
}

export default function historyRetrievalExtension(pi: ExtensionAPI): void {
	let bridge: HistoryIndexBridge | null = null;
	let indexedCount = 0;
	// Serialize addMessage calls so they write to Python stdin in order
	let writeChain: Promise<void> = Promise.resolve();
	/** Turn IDs recently auto-retrieved. Bounded to last 10. */
	const recentlyRetrieved = new Set<number>();
	// biome-ignore lint/correctness/noUnusedVariables: used for bookkeeping in before_agent_start handler
	let lastAutoRetrievedTurnId: number | null = null;

	const updateStatus = (ctx: ExtensionContext, extra?: string): void => {
		if (!ctx.hasUI) return;
		const count = `${indexedCount} turn${indexedCount === 1 ? "" : "s"} indexed`;
		ctx.ui.setStatus("history-retrieval", extra ? `${count} · ${extra}` : count);
	};

	const ensureBridge = (ctx: ExtensionContext): HistoryIndexBridge | null => {
		if (bridge) return bridge;

		const pythonPath = detectPython();
		if (!pythonPath) {
			ctx.ui.notify("History retrieval disabled: Python 3 not found", "warning");
			return null;
		}
		if (!checkPythonDeps(pythonPath)) {
			ctx.ui.notify("History retrieval disabled: run 'pip install numpy orjson'", "warning");
			return null;
		}

		const extDir = dirname(fileURLToPath(import.meta.url));
		const sessionDir = ctx.sessionManager.getSessionDir();
		const persistPath = join(sessionDir, "history-retrieval.json");
		bridge = new HistoryIndexBridge(pythonPath, extDir, persistPath);
		return bridge;
	};

	pi.on("session_start", async (_event, ctx) => {
		const b = ensureBridge(ctx);
		if (!b) return;
		try {
			await b.start();
			ctx.ui.notify("History retrieval active", "info");
			updateStatus(ctx);
		} catch (err) {
			ctx.ui.notify(
				`History retrieval failed to start: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const b = bridge;
		if (!b || !b.isStarted) return;

		const msg = event.message;
		if (msg.role !== "user" && msg.role !== "assistant") return;

		const text = extractText(msg as { content: unknown });
		if (!text) return;

		indexedCount++;
		// Chain writes to preserve stdin ordering
		writeChain = writeChain.then(() => b.addMessage(msg.role, text).catch(() => {}));
		updateStatus(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		await bridge?.markCompacted().catch(() => {});
		if (indexedCount > 0) {
			ctx.ui.notify(`Marked ${indexedCount} turns as compacted`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		if (bridge) {
			await bridge.save().catch(() => {});
			bridge.stop();
			bridge = null;
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!bridge?.isStarted) return;
		const query = event.prompt;
		if (query.length < 10) return; // short queries don't trigger auto-retrieval

		// Fetch candidates with recency boost (3x pool for re-ranking room)
		let candidates: (Turn & { boosted_score?: number })[];
		try {
			candidates = await bridge.searchWithRecency(query, 10, 1.0);
		} catch {
			return; // search failed — silently skip auto-retrieval this turn
		}
		if (!candidates.length) return;

		// Filter out recently retrieved IDs
		const fresh = candidates.filter((c) => !recentlyRetrieved.has(c.turn_id));
		if (!fresh.length) return;

		// Tier feature gates — mirror kimi-cli LoopControl defaults (all enabled)
		const tierAEnabled = true; // auto_retrieve_history
		const tierBEnabled = true; // auto_retrieve_working_memory
		const tierCEnabled = true; // auto_retrieve_recency_memory

		const injections: { type: string; content: string }[] = [];
		const usedIds = new Set<number>();
		let spent = 0;
		const tokenBudget = 2000;
		const wrapperOverhead = 15;
		const countTokens = (text: string): number => Math.ceil(text.length / 4);

		// A. Long-term memory — compacted turns above threshold (5.0)
		if (tierAEnabled) {
			const compacted = fresh.filter((c) => c.is_compacted && !usedIds.has(c.turn_id));
			if (compacted.length && compacted[0].score >= 5.0) {
				const best = compacted[0];
				const citation = formatAutoCitation(best, "long-term");
				const tokens = countTokens(citation) + wrapperOverhead;
				if (spent + tokens <= tokenBudget) {
					spent += tokens;
					usedIds.add(best.turn_id);
					injections.push({ type: "auto_retrieved_history", content: citation });
				}
			}
		}

		// B. Working memory — non-compacted turns, exclude last 2 from full index
		//    (last user+assistant pair already in context window tail)
		if (tierBEnabled) {
			const nonCompacted = fresh.filter((c) => !c.is_compacted && !usedIds.has(c.turn_id));
			// Fetch the last 2 non-compacted turn_ids from the full history index,
			// not just from the search candidates — matches kimi-cli which reads
			// self._history_index._turns to determine recent context.
			let recentExclude = new Set<number>();
			try {
				const recentIds = await bridge.getRecentNonCompactedTurnIds(2);
				recentExclude = new Set(recentIds);
			} catch {
				// If RPC fails, fall back to candidate-derived exclusion
				recentExclude = new Set(
					candidates
						.filter((c) => !c.is_compacted)
						.slice(-2)
						.map((c) => c.turn_id),
				);
			}
			const eligible = nonCompacted.filter((c) => !recentExclude.has(c.turn_id));
			if (eligible.length && eligible[0].score >= 5.0) {
				const best = eligible[0];
				const citation = formatWorkingCitation(best);
				const tokens = countTokens(citation) + wrapperOverhead;
				if (spent + tokens <= tokenBudget) {
					spent += tokens;
					usedIds.add(best.turn_id);
					injections.push({ type: "working_memory", content: citation });
				}
			}
		}

		// C. Recency memory — best boosted score above threshold (4.0)
		if (tierCEnabled) {
			const eligible = fresh.filter((c) => !usedIds.has(c.turn_id) && (c as any).boosted_score >= 4.0);
			if (eligible.length) {
				const best = eligible[0];
				const boostedScore = (best as any).boosted_score ?? best.score;
				const citation = formatRecencyCitation(best, boostedScore);
				const tokens = countTokens(citation) + wrapperOverhead;
				if (spent + tokens <= tokenBudget) {
					usedIds.add(best.turn_id);
					injections.push({ type: "recency_memory", content: citation });
				}
			}
		}

		// Cap to max 3 injections per turn — sync usedIds with trimmed injections
		// (kimi-cli trims both injections and used_turn_ids together)
		if (injections.length > 3) {
			injections.length = 3;
		}
		// Rebuild usedIds from the injections that survived the cap, mapping
		// injection type back to the turn that produced it. Since each injection
		// added exactly one turn_id to usedIds in tier order, we keep the first
		// N usedIds to match the first N injections.
		if (usedIds.size > injections.length) {
			const kept = Array.from(usedIds).slice(0, injections.length);
			usedIds.clear();
			for (const id of kept) usedIds.add(id);
		}

		if (!injections.length) return;

		// Update dedup tracking
		for (const id of usedIds) {
			recentlyRetrieved.add(id);
		}
		while (recentlyRetrieved.size > 10) {
			recentlyRetrieved.delete(Math.min(...recentlyRetrieved));
		}
		if (usedIds.size) lastAutoRetrievedTurnId = Math.max(...usedIds);

		// Inject as a user message (not systemPrompt) to preserve system prompt
		// prefix caching — modifying systemPrompt every turn invalidates the
		// Anthropic prompt cache. Using a custom message mirrors kimi-cli's
		// approach of appending a user message with <system-reminder> content.
		const combined = injections.map((i) => i.content).join("\n");
		return {
			message: {
				customType: "auto_retrieved_history",
				content: `<system-reminder>\n${combined}\n</system-reminder>`,
				display: false,
			},
		};
	});

	pi.registerTool({
		name: "ContextRetrieval",
		label: "Context-Retrieval",
		description:
			"Search archived conversation history for past turns matching a query. " +
			"Returns verbatim excerpts from user/assistant exchanges that were compacted or rotated " +
			"out of the active context window. Use to recall decisions, file paths, or error messages " +
			"no longer visible in the current conversation.",
		promptSnippet: "Search past conversation history for compacted/rotated content",
		promptGuidelines: [
			"When you need information from earlier in the conversation that is no longer visible (compacted or scrolled past), call ContextRetrieval with a natural-language query to find it",
			"Use ContextRetrieval proactively when the user references past decisions, file paths, or error messages you cannot see in the current context",
			"ContextRetrieval matches exact terms and n-grams, not synonyms — search with concrete words the user or you would have used (e.g. 'PostgreSQL', 'auth.ts', 'TypeError')",
		],
		parameters: searchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const b = bridge ?? ensureBridge(ctx);
			if (!b) {
				return {
					content: [{ type: "text", text: "History retrieval unavailable: Python not found." }],
					details: { turns: [], error: "python_not_found" } as SearchResultDetails,
				};
			}

			try {
				const k = Math.min(Math.max(params.k ?? 3, 1), 10);
				const results = await b.search(params.query, k);

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No matching past turns found." }],
						details: { turns: [] } as SearchResultDetails,
					};
				}

				const lines = [`Retrieved ${results.length} past turn(s):`];
				for (const r of results) {
					const marker = r.is_compacted ? " [compacted]" : "";
					const blockquoted = r.text.replace(/\n/g, "\n> ");
					lines.push(`> **${r.role}**${marker} (relevance: ${r.score.toFixed(2)})\n> ${blockquoted}`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n\n") }],
					details: { turns: results } as SearchResultDetails,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `History retrieval error: ${message}` }],
					details: { turns: [], error: message } as SearchResultDetails,
				};
			}
		},
	});
	pi.registerCommand("history-stats", {
		description: "Show history retrieval index statistics",
		handler: async (_args, ctx) => {
			const status = bridge ? (bridge.isStarted ? "running" : "stopped") : "not initialized";
			ctx.ui.notify(`History retrieval: ${status}, ${indexedCount} turns indexed`, "info");
		},
	});

	pi.registerCommand("history-search", {
		description: "Search conversation history (usage: /history-search <query>)",
		handler: async (args, ctx) => {
			const b = bridge ?? ensureBridge(ctx);
			if (!b || !b.isStarted) {
				ctx.ui.notify("History retrieval not running", "warning");
				return;
			}
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /history-search <query>", "warning");
				return;
			}
			try {
				const results = await b.search(query, 5);
				if (results.length === 0) {
					ctx.ui.notify("No matching turns found", "info");
					return;
				}
				const summary = results.map((r) => `[${r.score.toFixed(2)}] ${r.role}: ${r.text.slice(0, 80)}`).join("\n");
				ctx.ui.notify(`${results.length} match(es):\n${summary}`, "info");
			} catch (err) {
				ctx.ui.notify(`Search failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
