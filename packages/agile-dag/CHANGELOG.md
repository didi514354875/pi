# Changelog

All notable changes to `@earendil-works/pi-agile-dag` are documented here.
This package follows the same lockstep versioning as the rest of the monorepo.

## [Unreleased]

### Added

- **Spike probe card (`-1`)**: `play_agile_poker` now accepts `-1` for black-box tasks. Scoring `-1` freezes the original task and derives a read-only Spike prerequisite via `createSpikeTask`.
- **`submit_spike_result` tool**: closes a Spike task and harvests objective Key-Value facts into the global blackboard (`DagState.facts`). Absolutely no TODO/planning output permitted.
- **Spike read-only enforcement**: a `tool_call` hook hard-blocks `edit`/`write` while a Spike task is current (`bash` is intentionally not blocked; the prompt redline covers it).
- **Micro Fail-Fix loop**: a `FAILED` task under the fix-depth cap (`DAG_MAX_FIX_DEPTH = 2`) is frozen `BLOCKED` and a clean-context Bug Fix prerequisite is derived, instead of going terminal. At/above the cap the task stays terminal `FAILED`.
- **Architect review gate**: `decompose_task` calls an in-process Architect LLM (`reviewDecomposition` via `completeSimple`) before committing a split. Fail-open: any missing model/key/parse error approves.
- **Contract nodes & DoD boundary redline**: `decompose_task` accepts optional `kind` (`"standard"` | `"contract"`) and `boundary` per sub-task; both are rendered into the task prompt.
- **`propose_adr` tool + ADR blackboard**: writes a standing architecture decision to `DagState.adrs`, carried by every subsequent task prompt.
- **3-tier KV-cache system prompt**: `buildDagSystemPrompt(state, task)` layers static rules, the low-frequency facts/ADR blackboard, and the high-frequency current-task block to maximize prefix-cache hits.
- **`TaskKind`** (`"standard" | "spike" | "contract" | "bugfix"`), `AdrEntry`, and `DAG_MAX_FIX_DEPTH` types/constants.
- Task tree (`/dag status`) now shows kind badges (`[Spike]`/`[Contract]`/`[BugFix]`) and boundary markers.
- `normalizeState` backfills the new fields for sessions persisted before this change.

### Fixed

- Spike tasks were created in `ESTIMATING` but never advanced to `IN_PROGRESS` (they skip Agile Poker by design), so `submit_spike_result` rejected them with "不是当前正在执行的任务" / "不在执行状态". `createSpikeTask` now creates the Spike directly as `IN_PROGRESS` and sets it current, so the Worker can explore and submit facts immediately.
- `play_agile_poker`'s `-1` branch reported only the original task id in its tool result, never the newly-created Spike task id. The Worker then called `submit_spike_result` with the original id, which `ensureCurrentTask` rejected because `currentTaskId` had already moved to the Spike. The result text now explicitly surfaces the Spike task id and instructs the Worker to use it for `submit_spike_result`.
- **Failed-dependency deadlock**: a task that depended on a terminally-FAILED task (via `dependsOn` edge, not parent-child) could never unblock — `isTaskUnblocked` requires DONE. `submitResult` now cascades FAILED to all transitive dependents when a terminal FAILURE occurs, so the DAG can complete.
- **Resume state restore**: `resumeCurrent` used `getFirstTask` which only scanned root tasks and never restored `currentTaskId` or the task's active status. A paused READY task would be sent to `play_agile_poker` (which requires ESTIMATING) and rejected. Rewritten to find the first READY task and restart it via `startExecution`, falling back to `pushNextToEstimate` for ESTIMATING→TODO paused tasks.
- **decompose_task invariant gaps**: the tool didn't check `currentTaskId` (unlike every other tool) and returned no child id. Now gated on `currentTaskId` and the return text includes the first child's id and title.

### Changed

- `applyPokerScore` now returns `{ state, action: "ready" | "decompose" | "spike" }` instead of `{ state, mustDecompose }`.
- `StoryPoints` widened to include `-1`; `VALID_STORY_POINTS` updated accordingly.

### Removed

- Continuation re-push: the `agent_end` hook no longer re-injects the current task via `sendUserMessage`, and the `input` continuation-marker hook is gone. The engine now advances only through `submit_task_result` / `submit_spike_result`. Recover an early yield with `/dag resume`.
- `ContinuationMarker`, `getContinuation`, and `setContinuation` removed from shared state.
