import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { pushEscapeLayer } from "../escape-stack";
import "./WideSession.css";

const DRAWER_MIN = 30;
const DRAWER_MAX = 85;
const DRAWER_STEP = 3;

type WideSessionProps = {
  timeline: ReactNode;
  composer: ReactNode;
  preview: string;
  timelineOpen: boolean;
  onTimelineOpenChange: (open: boolean) => void;
  drawerHeight: number;
  onDrawerHeightChange: (height: number) => void;
  timelineAvailable?: boolean;
  onOcclusionChange?: (height: number) => void;
};

export function WideSession({
  timeline,
  composer,
  preview,
  timelineOpen,
  onTimelineOpenChange,
  drawerHeight,
  onDrawerHeightChange,
  timelineAvailable = true,
  onOcclusionChange,
}: WideSessionProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, value));

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack || !onOcclusionChange) return;
    const measure = () => {
      const tops = Array.from(stack.children).map((child) => child.getBoundingClientRect()).filter((rect) => rect.height > 0).map((rect) => rect.top);
      onOcclusionChange(tops.length ? Math.ceil(window.innerHeight - Math.min(...tops) + 8) : 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(stack);
    for (const child of stack.children) observer?.observe(child);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      onOcclusionChange(0);
    };
  }, [onOcclusionChange, timelineOpen, timelineAvailable]);

  useEffect(() => {
    if (!timelineOpen) return;
    return pushEscapeLayer(closeTimeline);
  }, [onTimelineOpenChange, timelineOpen]);

  useEffect(() => {
    if (timelineOpen) requestAnimationFrame(() => gripRef.current?.focus());
  }, [timelineOpen]);

  function closeTimeline() {
    onTimelineOpenChange(false);
    requestAnimationFrame(() => toggleRef.current?.focus());
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = event.pointerId;
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (pointerRef.current !== event.pointerId) return;
    const rect = stackRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    onDrawerHeightChange(clamp(((rect.bottom - event.clientY) / rect.height) * 100));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    setDragging(false);
  }

  return (
    <div className="wide-session-stack" ref={stackRef}>
      {timelineOpen ? (
        <section
          className={`wide-session-drawer${dragging ? " wide-session-drawer-dragging" : ""}`}
          style={{ height: `${drawerHeight}%` }}
          aria-label="Timeline drawer"
        >
          <div
            ref={gripRef}
            className="wide-session-grip"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize Timeline Drawer"
            aria-valuemin={DRAWER_MIN}
            aria-valuemax={DRAWER_MAX}
            aria-valuenow={Math.round(drawerHeight)}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                onDrawerHeightChange(clamp(drawerHeight + DRAWER_STEP));
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                onDrawerHeightChange(clamp(drawerHeight - DRAWER_STEP));
              }
            }}
          >
            <span className="wide-session-grip-bar" />
          </div>
          <button ref={toggleRef} type="button" className="wide-session-timeline-bar wide-session-timeline-bar-open" aria-expanded="true" aria-label="Collapse Timeline" title="Collapse Timeline (Esc)" onClick={closeTimeline}>
            <span className="wide-session-timeline-preview">{preview}</span><ChevronDown className="wide-session-timeline-chevron" size={14} aria-hidden="true" />
          </button>
          <div className="wide-session-drawer-body">{timeline}</div>
        </section>
      ) : timelineAvailable ? (
        <button ref={toggleRef} type="button" className="wide-session-timeline-bar" aria-expanded="false" aria-label="Expand Timeline" title="Expand Timeline" onClick={() => onTimelineOpenChange(true)}>
          <span className="wide-session-timeline-preview">{preview}</span><ChevronUp className="wide-session-timeline-chevron" size={14} aria-hidden="true" />
        </button>
      ) : null}
      {composer}
    </div>
  );
}
