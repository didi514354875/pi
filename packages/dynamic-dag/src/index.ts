/**
 * Dynamic-DAG Planner extension factory.
 *
 * Implements the "cognitive offloading" architecture from the agile-DAG design
 * spec: the LLM is a stateless worker; the host (this extension) owns the state
 * machine, tool-call budget, 3-stage decomposition review, and runtime DAG
 * adjustment.
 *
 * Load with:  pi -e ./packages/dynamic-dag
 * Command:    /dag <plan>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDagCommand } from "./command.ts";
import { registerDagHooks } from "./hooks.ts";
import { getState, setApi, setRefreshStatus } from "./state.ts";
import { registerDagTools } from "./tools.ts";
import { setDagStateGetter, updateStatus } from "./ui.ts";

export default function dynamicDag(pi: ExtensionAPI): void {
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
