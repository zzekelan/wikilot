import {
  reduceTimelineDelta,
  reduceSessionContext,
  type SessionRuntimeStatus,
  type TimelineDelta,
  type TimelineDeltaEvent,
  type TimelineItem,
  type TimelineSnapshot,
} from "../../shared/timeline";
import { sessionIdentityKey } from "./session-identity";

export type TimelineReadModel = {
  has(workspaceId: string, sessionId: string): boolean;
  hydrate(workspaceId: string, sessionId: string, items: TimelineItem[]): void;
  remove(workspaceId: string, sessionId: string): void;
  apply(
    workspaceId: string,
    sessionId: string,
    delta: TimelineDelta,
    at?: number,
  ): TimelineDeltaEvent | undefined;
  snapshot(workspaceId: string, sessionId: string): TimelineSnapshot;
};

/** Session-owned live projections partitioned by explicit identity. */
export function createTimelineReadModel(): TimelineReadModel {
  const snapshots = new Map<string, TimelineSnapshot>();

  return {
    has(workspaceId, sessionId) {
      return snapshots.has(sessionIdentityKey(workspaceId, sessionId));
    },

    hydrate(workspaceId, sessionId, items) {
      snapshots.set(sessionIdentityKey(workspaceId, sessionId), {
        workspaceId,
        sessionId,
        sequence: 0,
        status: "unloaded",
        context: { status: "unavailable" },
        items,
      });
    },

    remove(workspaceId, sessionId) {
      snapshots.delete(sessionIdentityKey(workspaceId, sessionId));
    },

    apply(workspaceId, sessionId, delta, at = Date.now()) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      const current = snapshots.get(key);
      if (!current) return undefined;
      const sequence = current.sequence + 1;
      const status: SessionRuntimeStatus =
        delta.type === "session_status" ? delta.status : current.status;
      const next = {
        ...current,
        sequence,
        status,
        context: reduceSessionContext(current.context, delta),
        items: reduceTimelineDelta(current.items, delta, at),
      };
      snapshots.set(key, next);
      return {
        workspaceId,
        sessionId,
        sequence,
        at,
        delta,
      };
    },

    snapshot(workspaceId, sessionId) {
      const snapshot = snapshots.get(sessionIdentityKey(workspaceId, sessionId));
      if (!snapshot) throw new Error("Timeline Snapshot is not loaded for this Session");
      return {
        ...snapshot,
        items: snapshot.items,
      };
    },
  };
}
