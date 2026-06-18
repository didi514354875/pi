/**
 * Shared mutable extension state.
 *
 * Held at module scope (like the tools extension's `enabledTools` set) so every
 * tool, command, and hook operates on a single source of truth. `setState` is
 * the single mutation seam: it updates the reference and persists to the session.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DAG_STATE_ENTRY_TYPE, type DagState } from "./types.ts";

let dagState: DagState | undefined;
let extensionApi: ExtensionAPI | undefined;

export function getApi(): ExtensionAPI | undefined {
	return extensionApi;
}

export function getState(): DagState | undefined {
	return dagState;
}

export function setApi(api: ExtensionAPI | undefined): void {
	extensionApi = api;
}

/** Replace the DAG state, persist it, and refresh the statusline/widget. */
export function setState(state: DagState | undefined, ctx?: ExtensionContext): void {
	dagState = state;
	persist();
	if (ctx) {
		void refreshStatus(ctx);
	}
}

/** Clear all state (used on /dag clear and shutdown). */
export function clearState(ctx?: ExtensionContext): void {
	dagState = undefined;
	if (ctx) {
		ctx.ui.setStatus("dynamic-dag", undefined);
		ctx.ui.setWidget("dynamic-dag", undefined);
	}
}

function persist(): void {
	extensionApi?.appendEntry<DagState>(DAG_STATE_ENTRY_TYPE, dagState);
}

/** Import cycle seam: ui.updateStatus is assigned at index load. */
let refreshStatus: (ctx: ExtensionContext) => Promise<void> = async () => {};

export function setRefreshStatus(fn: (ctx: ExtensionContext) => Promise<void>): void {
	refreshStatus = fn;
}
