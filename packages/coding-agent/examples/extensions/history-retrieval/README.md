# History Retrieval Extension

Searches archived conversation history using BM25 retrieval. Indexes every
user/assistant message into a BM25 engine and exposes a `ContextRetrieval`
tool so the LLM can recall decisions, file paths, or error messages that
were compacted or rotated out of the context window.

## Requirements

Python 3 with `numpy` and `orjson`:

```bash
pip install numpy orjson
```

## Loading

```bash
pi -e ./examples/extensions/history-retrieval
```

Or copy this directory to `~/.pi/agent/extensions/` for auto-discovery.

## How it works

- Every user/assistant message is indexed into a BM25 engine running in a
  long-lived Python subprocess.
- When context is compacted, all prior turns are marked `[compacted]`.
- The LLM can call the `ContextRetrieval` tool to search past turns by
  natural-language query.
- The index is persisted per-session to `<sessionDir>/history-retrieval.json`
  and rebuilt on resume.

## Architecture

```
index.ts (pi extension: events + tool)
  └── history-index-bridge.ts (TS: subprocess lifecycle + JSON-RPC)
        └── python/retrieval_server.py (stdio JSON-RPC server)
              └── python/history_index.py (simplified HistoryIndex)
                    └── python/kimix/retrieval.py (BM25 engine, copied from kimi-cli)
```

## Recency-boosted search

The bridge exposes `searchWithRecency(k, recencyWeight)` which multiplies the
BM25 score by a time-decay factor:

```
boosted_score = bm25_score * (1 + recency_weight * exp(-hours_ago / 24.0))
```

This is used internally by auto-retrieval and can also be called from the
`ContextRetrieval` tool via the LLM's natural query.

## Auto-retrieval

On every agent turn, the extension searches past turns with recency boost and
injects the top match as a `<system-reminder>` user message. Using a message
(instead of modifying the system prompt) preserves the provider's prompt prefix
cache — modifying systemPrompt every turn would invalidate Anthropic's cached
system block. Three tiers are checked in order (first-candidate-wins, max 3
injections per turn):

1. **Long-term memory** — compacted turns with BM25 score >= 5.0
2. **Working memory** — non-compacted turns (excluding the last 2 already in
   context) with score >= 5.0
3. **Recency memory** — time-boosted turns with boosted score >= 4.0

Deduplication prevents the same turn from being injected in consecutive
queries. Token budget is capped at 2000 tokens per turn (heuristic counting).

### Controlled manually

Auto-retrieval is automatic. To trigger a manual search, ask the LLM to use
the `ContextRetrieval` tool.

## Python dependency detection

On startup, the extension checks for Python 3 (`python3` -> `python` -> `py`),
then verifies `numpy` and `orjson` are installed. If either check fails, the
extension degrades gracefully (tool responds with "unavailable") and shows a
notification.
