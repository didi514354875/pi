/**
 * Agile-DAG Planner extension factory.
 *
 * Strips the LLM of global-planning authority: the agent can only do
 * multiple-choice (poker score) and fill-in-the-blank (execute/submit). The
 * DAG structure, dependencies, and task selection are owned by this backend
 * state machine.
 *
 * Load with:  pi -e ./packages/agile-dag
 * Command:    /dag <plan>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDagCommand } from "./command.ts";
import { registerDagHooks } from "./hooks.ts";
import { getState, setApi, setRefreshStatus } from "./state.ts";
import { registerDagTools } from "./tools.ts";
import { setDagStateGetter, updateStatus } from "./ui.ts";

export default function agileDag(pi: ExtensionAPI): void {
	setApi(pi);

	// Wire the two import-cycle seams:
	//  - state.ts calls refreshStatus(ctx) after every mutation (set via setRefreshStatus)
	//  - ui.ts reads the current state via currentDagState() (set via setDagStateGetter)
	setDagStateGetter(getState);
	setRefreshStatus(updateStatus);

	registerDagTools(pi);
	registerDagCommand(pi);
	registerDagHooks(pi);
}
