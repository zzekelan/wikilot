import {
  reduceTimelineDelta,
  reduceSessionContext,
  type SessionContextState,
  type SessionRuntimeStatus,
  type TimelineDeltaEvent,
  type TimelineItem,
  type TimelineSnapshot,
} from "../../shared/timeline";

export type TimelineStreamState = {
  context: SessionContextState;
  workspaceId?: string;
  sessionId?: string;
  sequence: number;
  status: SessionRuntimeStatus;
  items: TimelineItem[];
  needsSnapshot: boolean;
  /** Deltas arriving while recovery is in flight, replayed after the Snapshot. */
  pending: TimelineDeltaEvent[];
};

export function initialTimelineStream(): TimelineStreamState {
  return {
    sequence: 0,
    status: "unloaded",
    context: { status: "unavailable" },
    items: [],
    needsSnapshot: true,
    pending: [],
  };
}

function isSameSession(
  state: TimelineStreamState,
  event: { workspaceId: string; sessionId: string },
): boolean {
  return (
    state.workspaceId === event.workspaceId && state.sessionId === event.sessionId
  );
}

function applyContiguous(
  state: TimelineStreamState,
  event: TimelineDeltaEvent,
): TimelineStreamState {
  return {
    ...state,
    sequence: event.sequence,
    context: reduceSessionContext(state.context, event.delta),
    status:
      event.delta.type === "session_status"
        ? event.delta.status
        : state.status,
    items: reduceTimelineDelta(state.items, event.delta, event.at),
  };
}

/** Replace local state with a non-stale Snapshot, then replay buffered Deltas. */
export function applyTimelineSnapshot(
  state: TimelineStreamState,
  snapshot: TimelineSnapshot,
): TimelineStreamState {
  const sameSession = isSameSession(state, snapshot);
  if (sameSession && snapshot.sequence < state.sequence) return state;

  let next: TimelineStreamState = {
    workspaceId: snapshot.workspaceId,
    sessionId: snapshot.sessionId,
    sequence: snapshot.sequence,
    status: snapshot.status,
    context: snapshot.context,
    items: snapshot.items,
    needsSnapshot: false,
    pending: [],
  };
  if (!sameSession) return next;

  const pending = state.pending
    .filter((event) => event.sequence > snapshot.sequence)
    .sort((left, right) => left.sequence - right.sequence);
  for (const event of pending) {
    if (event.sequence <= next.sequence) continue;
    if (event.sequence !== next.sequence + 1) {
      return { ...next, needsSnapshot: true, pending: pending.filter((item) => item.sequence >= event.sequence) };
    }
    next = applyContiguous(next, event);
  }
  return next;
}

/** Apply only the next Delta; duplicates are ignored and gaps pause the stream. */
export function applyTimelineDelta(
  state: TimelineStreamState,
  event: TimelineDeltaEvent,
): TimelineStreamState {
  if (!isSameSession(state, event) || event.sequence <= state.sequence) {
    return state;
  }
  if (state.needsSnapshot) {
    return state.pending.some((pending) => pending.sequence === event.sequence)
      ? state
      : { ...state, pending: [...state.pending, event] };
  }
  if (event.sequence !== state.sequence + 1) {
    return { ...state, needsSnapshot: true, pending: [event] };
  }
  return applyContiguous(state, event);
}
