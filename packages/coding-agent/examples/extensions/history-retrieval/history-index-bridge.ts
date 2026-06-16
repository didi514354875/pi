/**
 * Bridge to the Python BM25 retrieval engine via stdio JSON-RPC.
 *
 * Spawns a long-lived Python subprocess that runs retrieval_server.py.
 * Communication is newline-delimited JSON: {id, method, params} → {id, result|error}.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** A single conversation turn returned from the retrieval engine. */
export interface Turn {
	turn_id: number;
	timestamp: number;
	role: "user" | "assistant";
	text: string;
	is_compacted: boolean;
	score: number;
}

interface SearchResult {
	turns: Turn[];
}

interface SearchWithRecencyResult {
	turns: (Turn & { boosted_score?: number })[];
}

interface OkResult {
	ok: true;
}

interface PendingReq {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 10_000;

const PYTHON_CANDIDATES = ["python3", "python", "py"];

/** Detect the first available Python interpreter on the system. Returns null if none found. */
export function detectPython(): string | null {
	for (const candidate of PYTHON_CANDIDATES) {
		try {
			const result = spawnSync(candidate, ["--version"], { stdio: "pipe" });
			if (result.status === 0) {
				return candidate;
			}
		} catch {
			// try next candidate
		}
	}
	return null;
}

/** Verify that the Python environment has numpy and orjson installed. */
export function checkPythonDeps(pythonPath: string): boolean {
	try {
		const result = spawnSync(pythonPath, ["-c", "import numpy, orjson"], { stdio: "pipe" });
		return result.status === 0;
	} catch {
		return false;
	}
}

export class HistoryIndexBridge {
	private proc: ChildProcess | null = null;
	private readonly pending = new Map<string, PendingReq>();
	private buffer = "";
	private started = false;
	private startPromise: Promise<void> | null = null;
	private readonly pythonPath: string;
	private readonly scriptDir: string;
	private readonly persistPath: string;

	constructor(pythonPath: string, scriptDir: string, persistPath: string) {
		this.pythonPath = pythonPath;
		this.scriptDir = scriptDir;
		this.persistPath = persistPath;
	}
	/** Whether the Python subprocess is alive and accepting requests. */
	get isStarted(): boolean {
		return this.started;
	}

	async start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = this._start();
		return this.startPromise;
	}

	private async _start(): Promise<void> {
		const scriptPath = join(this.scriptDir, "python", "retrieval_server.py");
		this.proc = spawn(this.pythonPath, [scriptPath, this.persistPath], {
			stdio: ["pipe", "pipe", "inherit"],
		});

		this.proc.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") {
				this.rejectAll(new Error(`Python interpreter not found: ${this.pythonPath}`));
			} else {
				this.rejectAll(err);
			}
		});

		this.proc.on("exit", (code, signal) => {
			if (!this.started) return;
			this.started = false;
			this.startPromise = null;
			this.proc = null;
			if (this.pending.size > 0) {
				this.rejectAll(new Error(`Python process exited (code=${code}, signal=${signal})`));
			}
		});

		this.proc.stdout?.setEncoding("utf-8");
		this.proc.stdout?.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl = this.buffer.indexOf("\n");
			while (nl >= 0) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				this.handleResponse(line);
				nl = this.buffer.indexOf("\n");
			}
		});

		this.started = true;
	}

	private handleResponse(line: string): void {
		let resp: { id?: string; result?: unknown; error?: string };
		try {
			resp = JSON.parse(line);
		} catch {
			return; // ignore malformed lines
		}
		const pending = this.pending.get(resp.id ?? "");
		if (!pending) return;

		clearTimeout(pending.timer);
		this.pending.delete(resp.id ?? "");
		if (resp.error !== undefined) {
			pending.reject(new Error(resp.error));
		} else {
			pending.resolve(resp.result);
		}
	}

	private rejectAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
		if (!this.started || !this.proc?.stdin) {
			return Promise.reject(new Error("Bridge not started"));
		}
		const id = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms: ${method}`));
			}, RPC_TIMEOUT_MS);

			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			});

			this.proc!.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	async addMessage(role: string, text: string): Promise<void> {
		await this.call<OkResult>("add_message", { role, text });
	}

	async search(query: string, k = 3): Promise<Turn[]> {
		const result = await this.call<SearchResult>("search", { query, k });
		return result.turns;
	}

	async searchWithRecency(query: string, k = 10, recencyWeight = 1.0): Promise<(Turn & { boosted_score?: number })[]> {
		const result = await this.call<SearchWithRecencyResult>("search_with_recency", {
			query,
			k,
			recency_weight: recencyWeight,
		});
		return result.turns;
	}

	async getRecentNonCompactedTurnIds(n = 2): Promise<number[]> {
		const result = await this.call<{ turn_ids: number[] }>("get_recent_non_compacted_turn_ids", { n });
		return result.turn_ids;
	}

	async markCompacted(): Promise<void> {
		await this.call<OkResult>("mark_compacted", {});
	}

	async save(): Promise<void> {
		await this.call<OkResult>("save", {});
	}

	async clear(): Promise<void> {
		await this.call<OkResult>("clear", {});
	}

	stop(): void {
		this.started = false;
		this.startPromise = null;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
		}
		this.pending.clear();
		this.proc?.stdin?.end();
		this.proc?.kill();
		this.proc = null;
	}
}
