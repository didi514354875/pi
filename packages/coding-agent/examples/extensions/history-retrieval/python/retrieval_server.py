"""JSON-RPC server over stdin/stdout for BM25 history retrieval."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from history_index import HistoryIndex


def main() -> None:
	persist_path = sys.argv[1] if len(sys.argv) > 1 else None
	index = HistoryIndex(Path(persist_path) if persist_path else None)
	index.load()

	for raw_line in sys.stdin:
		line = raw_line.strip()
		if not line:
			continue
		rid = None
		try:
			req = json.loads(line)
			rid = req.get("id")
			method = req.get("method")
			params = req.get("params", {})

			if method == "add_message":
				index.add_message(params["role"], params["text"])
				resp: dict = {"id": rid, "result": {"ok": True}}
			elif method == "search":
				turns = index.search(params["query"], top_k=params.get("k", 3))
				resp = {"id": rid, "result": {"turns": turns}}
			elif method == "search_with_recency":
				turns = index.search_with_recency(
					params["query"],
					top_k=params.get("k", 10),
					recency_weight=params.get("recency_weight", 1.0),
				)
				resp = {"id": rid, "result": {"turns": turns}}
			elif method == "get_recent_non_compacted_turn_ids":
				ids = index.get_recent_non_compacted_turn_ids(params.get("n", 2))
				resp = {"id": rid, "result": {"turn_ids": ids}}
			elif method == "mark_compacted":
				index.mark_compacted()
				resp = {"id": rid, "result": {"ok": True}}
			elif method == "save":
				index.save()
				resp = {"id": rid, "result": {"ok": True}}
			elif method == "clear":
				index.clear()
				resp = {"id": rid, "result": {"ok": True}}
			else:
				resp = {"id": rid, "error": f"unknown method: {method}"}
		except Exception as e:
			resp = {"id": rid, "error": str(e)}
		sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
		sys.stdout.flush()


if __name__ == "__main__":
	main()
