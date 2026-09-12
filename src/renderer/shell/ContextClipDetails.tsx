import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { File, FileText, Paperclip, X } from "lucide-react";
import { contextClipIdentity, type ContextClip } from "../../shared/session";
import { pushEscapeLayer } from "../escape-stack";
import "./ContextClipDetails.css";

type ContextClipDetailsProps = {
  clips: readonly ContextClip[];
  className?: string;
  align?: "left" | "right";
  showSources?: boolean;
  onNavigate?: (clip: ContextClip) => void;
  onRemove?: (index: number) => void;
};

function clipCountLabel(count: number): string {
  return `${count} ${count === 1 ? "clip" : "clips"}`;
}

function clipLocation(clip: ContextClip): string {
  const locator = clip.locator;
  if (locator.kind === "pdf") {
    const first = locator.spans[0]?.page;
    const last = locator.spans.at(-1)?.page;
    if (!first || !last) return "location unavailable";
    return first === last ? `page ${first}` : `pages ${first}-${last}`;
  }
  const lines = locator.lineStart
    ? locator.lineEnd && locator.lineEnd !== locator.lineStart
      ? `lines ${locator.lineStart}-${locator.lineEnd}`
      : `lines ${locator.lineStart}`
    : "location unavailable";
  return [locator.heading ? `\"${locator.heading}\"` : null, lines, locator.mode]
    .filter(Boolean)
    .join(" · ");
}

export function ContextClipDetails({
  clips,
  className = "",
  align = "left",
  showSources = false,
  onNavigate,
  onRemove,
}: ContextClipDetailsProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>();
  const [popoverDirection, setPopoverDirection] = useState<"above" | "below">("above");

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const wrapper = wrapperRef.current;
      const popover = popoverRef.current;
      if (!wrapper || !popover) return;
      const gap = 8;
      const wrapperRect = wrapper.getBoundingClientRect();
      const drawer = wrapper.closest(".wide-session-drawer");
      const chrome = document.querySelector(".shell-chrome");
      const topEdge = Math.max(
        drawer?.getBoundingClientRect().top ?? 0,
        chrome?.getBoundingClientRect().bottom ?? 0,
      );
      const visibleComposer = Array.from(document.querySelectorAll(".composer-card"))
        .find((element) => element.getBoundingClientRect().height > 0);
      const ownComposer = visibleComposer?.contains(wrapper) ? visibleComposer : null;
      const ownComposerRect = ownComposer?.getBoundingClientRect();
      const bottomEdge = visibleComposer && !ownComposer
        ? visibleComposer.getBoundingClientRect().top
        : window.innerHeight;
      const aboveAnchor = ownComposerRect?.top ?? wrapperRect.top;
      const availableAbove = Math.max(0, aboveAnchor - topEdge - gap);
      const availableBelow = Math.max(0, bottomEdge - wrapperRect.bottom - gap);
      const openAbove = availableAbove >= availableBelow;
      const maxHeight = openAbove ? availableAbove : availableBelow;
      setPopoverDirection(openAbove ? "above" : "below");
      const currentBottom = parseFloat(getComputedStyle(popover).bottom) || 0;
      const composerClearance = ownComposerRect
        ? popover.getBoundingClientRect().bottom - (ownComposerRect.top - gap)
        : 0;
      setPopoverStyle({
        maxHeight: Math.max(48, Math.min(16 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16), Math.floor(maxHeight))),
        ...(openAbove && ownComposerRect ? { bottom: currentBottom + composerClearance } : {}),
      });
    };
    place();
    popoverRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [clips.length, open]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (
        !triggerRef.current?.contains(event.target as Node)
        && !popoverRef.current?.contains(event.target as Node)
      ) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    const popEscape = pushEscapeLayer(close);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      popEscape();
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (clips.length === 0) return null;
  const label = clipCountLabel(clips.length);
  return (
    <div
      ref={wrapperRef}
      className={`context-clip-details${align === "right" ? " context-clip-align-right" : ""} ${className}`.trim()}
      data-testid={className || "context-clips"}
    >
      <button
        ref={triggerRef}
        type="button"
        className="context-clip-capsule"
        aria-label={label}
        aria-description={showSources ? clips.slice(0, 2).map((clip) => `${clip.source.path} · ${clipLocation(clip)}`).join("; ") : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Paperclip size={12} aria-hidden="true" />
        {showSources ? <>
          {clips.slice(0, 2).map((clip, index) => <span className="context-clip-summary" key={index} title={`${clip.source.path} · ${clipLocation(clip)}`}>
            {clip.source.path.split("/").at(-1)} · {clip.locator.kind === "pdf" ? `p.${clip.locator.spans[0]?.page ?? "?"}` : clip.locator.heading || `line ${clip.locator.lineStart ?? "?"}`}
          </span>)}
          {clips.length > 2 ? <span className="context-clip-overflow">+{clips.length - 2}</span> : null}
        </> : label}
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className={`context-clip-popover context-clip-popover-${popoverDirection}`}
          role="dialog"
          aria-label="Context Clips"
          tabIndex={-1}
          style={popoverStyle}
        >
          <div className="context-clip-list">
            {clips.map((clip, index) => (
              <div className="context-clip-row" key={contextClipIdentity(clip)}>
                <button
                  type="button"
                  className="context-clip-source"
                  aria-label={`Open clip ${index + 1} source`}
                  onClick={() => {
                    setOpen(false);
                    onNavigate?.(clip);
                  }}
                >
                  {clip.source.kind === "pdf"
                    ? <File size={15} aria-hidden="true" />
                    : <FileText size={15} aria-hidden="true" />}
                  <span>
                    <strong>{clip.source.path}</strong>
                    <small>{clipLocation(clip)}</small>
                    <span className="context-clip-excerpt">{clip.text}</span>
                  </span>
                </button>
                {onRemove ? (
                  <button
                    type="button"
                    className="icon-btn context-clip-remove"
                    aria-label={`Remove clip ${index + 1}`}
                    title="Remove Clip"
                    onClick={() => onRemove(index)}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
