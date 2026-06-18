# Changelog

All notable changes to `@earendil-works/pi-agile-dag` are documented here.
This package follows the same lockstep versioning as the rest of the monorepo.

## [Unreleased]

### Breaking Changes

- **State machine rewrite**: `TaskStatus` changed from `TODO/ESTIMATING/READY/IN_PROGRESS/BLOCKED/DONE/FAILED` to `CREATED/READY/RUNNING/VERIFYING/BLOCKED/DONE/FAILED`. `TaskNode` lost `storyPoints`/`fixDepth` and gained `complexity`/`risk`/`confidence`/`retryCount`. Sessions persisted before this rewrite are discarded by `restoreFromBranch` (no lossless migration).
- **`play_agile_poker` → `assess_task`**: Fibonacci poker replaced by a four-dimension self-assessment (`complexity`/`risk`/`confidence`/`is_spike`, each 1-10). `complexity > 8` forces decomposition (was `>= 8`).
- **`submit_task_result` gate**: `SUCCESS` no longer marks DONE directly — it enters `VERIFYING` and the engine runs the verification pipeline. New status `FAILED_NEED_SPIKE` replaces the `need_new_tasks` parameter (removed).
- **`PI_AGILE_VERIFY_CMD` is now required**: if unset, every `SUCCESS` submission fails verification and rolls back.

### Added

- **`VERIFYING` state + verification pipeline**: on `submit_task_result(SUCCESS)` the engine runs `PI_AGILE_VERIFY_CMD` (via `sh -c` / `cmd /c`, 5 min timeout). Pass → Git commit → DONE; fail → `git reset --hard` + `git clean -fd` → retry.
- **Git as transaction boundary**: `git.ts` (`isWorkspaceClean`/`commitAll`/`hardReset`). A dirty workspace hard-blocks task start; passed verification auto-commits (`feat(dag): <id> <title>`); failure auto-resets. `git add -A` handles adds/modifies/deletes; "nothing to commit" is tolerated.
- **Heuristic recommendation formula**: `recommendNextTask` scores `W_CRITICAL(15)*downstream + W_SPIKE(100)*isSpike − W_COMPLEXITY(5)*complexity + W_CONFIDENCE(2)*confidence`. Spike probes dominate.
- **Verify-retry**: `handleTaskFailure` retries a failing task up to `DAG_MAX_VERIFY_RETRIES = 2` (back to READY/RUNNING with `[verify-fail #N]` context), then terminal-FAILED with cascade.
- **`/dag resume` re-runs VERIFYING**: a task interrupted mid-verification is detected and the pipeline re-executes on resume.
- New constants: `DAG_COMPLEXITY_THRESHOLD`, `DAG_MAX_VERIFY_RETRIES`, `DAG_VERIFY_CMD_ENV`, `DAG_VERIFY_TIMEOUT_MS`, `DAG_GIT_TIMEOUT_MS`, `W_CRITICAL`/`W_SPIKE`/`W_COMPLEXITY`/`W_CONFIDENCE`.
- `STATUS_ICON` centralized in `types.ts` (was duplicated in `command.ts` and `ui.ts`).
- `/dag status` now shows complexity/risk/confidence and retry count per task.

### Changed

- Engine functions renamed: `pushNextToEstimate`→`pushNextToAssess`, `applyPokerScore`→`applyAssessment`, `createSpikeTask`→`deriveSpike` (spike now starts READY, selected via W_SPIKE), `startExecution`→`startTask`, `selectNextBestTask`→`recommendNextTask`.
- `submitResult` split into three pure functions: `transitionToVerifying`, `completeTaskSuccess`, `handleTaskFailure`. Git/verify side effects live in the tools layer.
- `TaskKind` narrowed to `"standard" | "spike" | "contract"` (bugfix removed).
- `decompose_task` `kind` union narrowed to `standard`/`contract`; status checks use `CREATED`/`RUNNING`.
- Spike skips verification and Git commit (read-only probe, no code output).
- `showHelloWorld` version bumped to `v3.1.0`.

### Removed

- `StoryPoints`, `VALID_STORY_POINTS`, `isStoryPoints`, `DAG_POKER_THRESHOLD`.
- `bugfix` task kind and the Micro Fail-Fix loop (replaced by verify-retry).
- `fixDepth` / `DAG_MAX_FIX_DEPTH` (replaced by `retryCount` / `DAG_MAX_VERIFY_RETRIES`).
- `play_agile_poker` tool and the `need_new_tasks` parameter of `submit_task_result`.
