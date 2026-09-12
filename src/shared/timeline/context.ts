import type { SessionContextState, TimelineDelta } from "./types.ts";

/** Context is ephemeral Session state, reset whenever its Runtime is replaced. */
export function reduceSessionContext(
  current: SessionContextState,
  delta: TimelineDelta,
): SessionContextState {
  if (delta.type === "context_usage") return delta.context;
  if (delta.type === "session_status" &&
      ["starting", "stopping", "unloaded"].includes(delta.status)) {
    return { status: "unavailable" };
  }
  return current;
}
