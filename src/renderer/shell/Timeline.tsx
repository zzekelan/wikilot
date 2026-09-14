import { PromptCommandBubble, type PendingPrompt } from "./PromptCommandBadge";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { mergeToolOnlyAssistantItems } from "./timeline-activity";
import { formatTimestampLabel, shouldShowTimestamp } from "./timestamps";
import { MessageView } from "./MessageView";
import { TimelineScrollbar } from "./TimelineScrollbar";
import type { ContextClip } from "../../shared/session";
import type { TimelineItem } from "../../shared/timeline";
import type { MarkdownTextProps } from "../markdown";
import "./Timeline.css";

export type TimelineProps = {
  items: TimelineItem[];
  sessionBusy?: boolean;
  /** Empty-state content (the shell's getting-started checklist). */
  emptyContent?: ReactNode;
  /** Snapshot restore in flight: show a loading state instead of emptyContent. */
  loading?: boolean;
  /** Locally echoed Prompt between send and its first streamed Delta. */
  pendingPrompt?: PendingPrompt | null;
  markdownLinks?: Pick<MarkdownTextProps, "resolveLink" | "onNavigate" | "linkRevision">;
  onClipNavigate?: (clip: ContextClip) => void;
  toolImageUrl?: (imageRef: string) => string;
};

/** Distance from the bottom (px) that still counts as "stuck" (neo VirtualTimeline). */
const STICK_THRESHOLD_PX = 48;

export function Timeline({
  items,
  sessionBusy = false,
  emptyContent,
  loading = false,
  pendingPrompt = null,
  markdownLinks,
  onClipNavigate,
  toolImageUrl,
}: TimelineProps) {
  // Merge consecutive tool-only assistant messages before projecting rows (neo D9).
  const merged = useMemo(() => mergeToolOnlyAssistantItems(items), [items]);
  // The pending Prompt rides the virtualized list as one extra tail row so it
  // scrolls with the conversation and is replaced in place by the real Delta.
  const rowCount = merged.length + (pendingPrompt ? 1 : 0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const previousCountRef = useRef(rowCount);
  const [atBottom, setAtBottom] = useState(true);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 100,
    overscan: 5,
    useAnimationFrameWithResizeObserver: true,
  });

  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    if (rowCount > 0) {
      virtualizer.scrollToIndex(rowCount - 1, { align: "end" });
    }
  }, [virtualizer, rowCount]);

  // New items while stuck: pin to the bottom on the next frame.
  useEffect(() => {
    if (rowCount > previousCountRef.current && stickToBottomRef.current) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(rowCount - 1, { align: "end" });
      });
    }
    previousCountRef.current = rowCount;
  }, [rowCount, virtualizer]);

  // Growing rows (streaming deltas) keep the viewport pinned while stuck.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [virtualizer.getTotalSize()]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
    stickToBottomRef.current = nearBottom;
    setAtBottom(nearBottom);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      if (!el) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        el.scrollBy({ top: 80, behavior: "smooth" });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        el.scrollBy({ top: -80, behavior: "smooth" });
      } else if (event.key === "End") {
        event.preventDefault();
        scrollToBottom();
      } else if (event.key === "Home") {
        event.preventDefault();
        el.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [scrollToBottom],
  );

  if (merged.length === 0 && !pendingPrompt) {
    return (
      <section
        className="timeline timeline-empty"
        aria-label="Timeline"
        data-testid="timeline"
      >
        {loading ? (
          <p className="timeline-loading" role="status" data-testid="timeline-loading">
            Restoring Session…
          </p>
        ) : (
          (emptyContent ?? null)
        )}
      </section>
    );
  }

  return (
    <section className="timeline" aria-label="Timeline" data-testid="timeline">
      <div
        ref={scrollRef}
        className="timeline-scroll"
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        style={{ overflowAnchor: "none" }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const isPendingRow = virtualRow.index === merged.length;
            const item = isPendingRow ? undefined : merged[virtualRow.index];
            const previous =
              virtualRow.index > 0 ? merged[virtualRow.index - 1] : undefined;
            const timestampLabel =
              !isPendingRow && shouldShowTimestamp(previous?.at, item!.at)
                ? formatTimestampLabel(item!.at)
                : undefined;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="timeline-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {isPendingRow ? (
                  <div className="anim-in msg-user msg-user-pending" data-testid="timeline-pending">
                    <div className="msg-user-wrap">
                      {pendingPrompt && typeof pendingPrompt === "object" ? <PromptCommandBubble command={pendingPrompt.command} text={pendingPrompt.text} /> : (
                        <div className="msg-user-bubble">
                          <div className="msg-user-text">{pendingPrompt}</div>
                        </div>
                      )}
                      <span className="msg-user-pending-hint">Sending…</span>
                    </div>
                  </div>
                ) : (
                  <MessageView
                    item={item!}
                    sessionBusy={sessionBusy}
                    isLast={virtualRow.index === merged.length - 1}
                    timestampLabel={timestampLabel}
                    markdownLinks={markdownLinks}
                    onClipNavigate={onClipNavigate}
                    toolImageUrl={toolImageUrl}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <TimelineScrollbar viewportRef={scrollRef} />
      <button
        type="button"
        aria-label="Scroll to bottom"
        className={atBottom ? "timeline-fab timeline-fab-hidden" : "timeline-fab"}
        // The hidden state is visual only (opacity); keep it out of the tab order.
        tabIndex={atBottom ? -1 : undefined}
        onClick={scrollToBottom}
      >
        <ChevronDown size={16} />
      </button>
    </section>
  );
}
