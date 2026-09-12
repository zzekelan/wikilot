import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, Copy, ImageOff, RefreshCw } from "lucide-react";
import type { ContextClip } from "../../shared/session";
import { buildRenderEntries, type RenderEntry } from "./timeline-activity";
import {
  formatToolDisplayName,
  toolPrimaryDetail,
} from "./tool-labels";
import type {
  AssistantPart,
  TimelineItem,
  ToolPart,
} from "../../shared/timeline";
import { PromptCommandBadge } from "./PromptCommandBadge";
import { ContextClipDetails } from "./ContextClipDetails";
import { MarkdownText, type MarkdownTextProps } from "../markdown";

type AssistantItem = Extract<TimelineItem, { kind: "assistant" }>;
type GroupEntry = Extract<RenderEntry, { kind: "group" }>;
type FoldedEntry = Extract<RenderEntry, { kind: "folded" }>;
type ToolImageUrl = (imageRef: string) => string;

/** Long tool output stays clamped behind a show more/less toggle (neo D5). */
const OUTPUT_LINE_LIMIT = 10;
const FINAL_ACTIVITY_FOLD_DELAY_MS = 1200;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Per-tool wall time on completed rows ("1.2s"); sub-second tools stay quiet. */
function formatToolDuration(part: ToolPart): string | undefined {
  if (part.endedAt === undefined) return undefined;
  const seconds = (part.endedAt - part.at) / 1000;
  if (seconds < 1) return undefined;
  return `${seconds.toFixed(1)}s`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="activity-chevron-slot" aria-hidden="true">
      <ChevronLeft size={12} className={open ? "chevron chevron-open" : "chevron"} />
    </span>
  );
}

/** Height/opacity collapse via grid-rows transition (stands in for framer-motion). */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={open ? "collapsible collapsible-open" : "collapsible"}>
      <div className="collapsible-inner">{children}</div>
    </div>
  );
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const onCopy = async () => {
    setCopied(false);
    setFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className={`icon-btn${copied ? " icon-btn-copied" : ""}${className ? ` ${className}` : ""}`}
      title={failed ? "Could not copy. Try again." : copied ? "Copied" : "Copy message"}
      aria-label={failed ? "Could not copy. Try again." : copied ? "Copied" : "Copy message"}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function TimestampDivider({ label }: { label: string }) {
  return (
    <div className="msg-timestamp">
      <span className="msg-timestamp-pill">{label}</span>
    </div>
  );
}

/** Live reasoning streams expanded; once it ends it auto-collapses after 1s (neo D3). */
function ReasoningBlock({ text, live }: { text: string; live: boolean }) {
  const [expanded, setExpanded] = useState(live);
  const [showCompletedLabel, setShowCompletedLabel] = useState(!live);
  const wasLiveRef = useRef(live);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (live) {
      wasLiveRef.current = true;
      setShowCompletedLabel(false);
      setExpanded(true);
      return;
    }
    if (!wasLiveRef.current) {
      setShowCompletedLabel(true);
      setExpanded(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setExpanded(false);
      setShowCompletedLabel(true);
      wasLiveRef.current = false;
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [live]);

  // Pin the reasoning scroller to its newest line while streaming.
  useEffect(() => {
    if (!live || !expanded) return;
    const frame = window.requestAnimationFrame(() => {
      const node = contentRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, live, text]);

  const label = live || !showCompletedLabel ? "thinking" : "reasoning";

  return (
    <div className={live ? "reasoning reasoning-live" : "reasoning"}>
      <button
        type="button"
        className="activity-row"
        aria-expanded={expanded}
        aria-live={live ? "polite" : undefined}
        onClick={() => setExpanded((value) => !value)}
      >
        <span
          className={
            live ? "activity-label activity-label-live activity-grow" : "activity-label activity-grow"
          }
        >
          {label}
        </span>
        <Chevron open={expanded} />
      </button>
      <Collapsible open={expanded}>
        <div
          ref={contentRef}
          className={
            live ? "reasoning-content reasoning-content-live" : "reasoning-content"
          }
        >
          {text}
        </div>
      </Collapsible>
    </div>
  );
}

function ToolOutput({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.split("\n").length > OUTPUT_LINE_LIMIT;
  return (
    <>
      <pre
        className={`tool-details-block tool-output${
          isLong && !expanded ? " tool-output-clamped" : ""
        }`}
      >
        {text}
      </pre>
      {isLong ? (
        <button
          type="button"
          className="tool-more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

function ToolImagePreview({
  imageRef,
  alt,
  imageUrl,
}: {
  imageRef: string;
  alt: string;
  imageUrl: ToolImageUrl;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [visible, setVisible] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const src = imageUrl(imageRef);

  useEffect(() => {
    const node = previewRef.current;
    if (!node || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting === true),
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={previewRef} className="tool-image-preview" data-state={state}>
      {state !== "ready" ? (
        <div className="tool-image-placeholder" role={state === "error" ? "alert" : "status"}>
          {state === "error" ? <ImageOff size={18} /> : null}
          <span>{state === "error" ? "Preview unavailable" : "Loading preview…"}</span>
          {state === "error" ? (
            <button
              type="button"
              className="tool-image-retry"
              onClick={() => {
                setState("loading");
                setAttempt((value) => value + 1);
              }}
            >
              <RefreshCw size={14} />
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {visible && (
        <img
          key={attempt}
          src={src}
          alt={alt}
          loading="lazy"
          hidden={state !== "ready"}
          onLoad={() => setState("ready")}
          onError={() => setState("error")}
        />
      )}
    </div>
  );
}

function ToolResultDetails({
  part,
  imageUrl,
}: {
  part: ToolPart;
  imageUrl?: ToolImageUrl;
}) {
  const result = part.result;
  if (!result) return null;
  const metadata = result.metadata;
  return (
    <>
      {result.text !== undefined ? <ToolOutput text={result.text} /> : null}
      {metadata ? (
        <dl className="tool-pdf-metadata">
          <div><dt>Path</dt><dd>{metadata.path}</dd></div>
          <div><dt>Pages</dt><dd>{metadata.pages.map((page) => page.page).join(", ")} of {metadata.pageCount}</dd></div>
          {metadata.pages.map((page, index) => <div key={index}><dt>Page {page.page}</dt><dd>{page.width} × {page.height}</dd></div>)}
        </dl>
      ) : null}
      {imageUrl ? result.images?.map((image, index) => (
        <ToolImagePreview
          key={image.imageRef}
          imageRef={image.imageRef}
          imageUrl={imageUrl}
          alt={metadata?.pages[index] ? `${metadata.path} page ${metadata.pages[index].page}` : `Tool result image ${index + 1}`}
        />
      )) : null}
    </>
  );
}

function ToolActiveRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const title = formatToolDisplayName(part.toolName);
  const progressLine = part.progress
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const subtitle = progressLine ?? toolPrimaryDetail(part.toolName, part.args) ?? "";
  const hasDetails = part.args !== undefined;

  return (
    <div className="anim-in" data-testid="timeline-tool">
      <button
        type="button"
        className="activity-row"
        aria-expanded={hasDetails ? open : undefined}
        onClick={hasDetails ? () => setOpen((value) => !value) : undefined}
      >
        <span className="activity-row-main">
          <span className="activity-label activity-label-live activity-tool-name activity-truncate">{title}</span>
          {subtitle ? (
            <>
              <span className="activity-sep">·</span>
              <span className="activity-sub">{subtitle}</span>
            </>
          ) : null}
        </span>
        {hasDetails ? <Chevron open={open} /> : <span className="activity-chevron-slot" />}
      </button>
      {hasDetails ? (
        <Collapsible open={open}>
          <div className="tool-details">
            <pre className="tool-details-block">{safeJson(part.args)}</pre>
          </div>
        </Collapsible>
      ) : null}
    </div>
  );
}

function CompletedToolRow({ part, imageUrl }: { part: ToolPart; imageUrl?: ToolImageUrl }) {
  const [open, setOpen] = useState(false);
  const isError = part.status === "error";
  const title = formatToolDisplayName(part.toolName);
  const detail = toolPrimaryDetail(part.toolName, part.args);
  const duration = formatToolDuration(part);
  const hasDetails =
    part.args !== undefined ||
    part.result?.text !== undefined ||
    part.result?.metadata !== undefined ||
    Boolean(part.result?.images?.length);

  return (
    <div data-testid="timeline-tool">
      <button
        type="button"
        className="activity-row"
        aria-expanded={hasDetails ? open : undefined}
        onClick={hasDetails ? () => setOpen((value) => !value) : undefined}
      >
        <span className="activity-row-main">
          <span
            className={`activity-label activity-tool-name activity-truncate${
              isError ? " activity-label-error" : ""
            }`}
          >
            {title}
          </span>
          {detail ? (
            <>
              <span className="activity-sep">·</span>
              <span className="activity-sub">{detail}</span>
            </>
          ) : null}
          {isError ? <span className="activity-fail">— failed</span> : null}
        </span>
        {duration && !isError ? (
          <span className="activity-meta">{duration}</span>
        ) : null}
        {hasDetails ? <Chevron open={open} /> : <span className="activity-chevron-slot" />}
      </button>
      {hasDetails ? (
        <Collapsible open={open}>
          <div className="tool-details">
            {part.args !== undefined ? (
              <pre className="tool-details-block">{safeJson(part.args)}</pre>
            ) : null}
            <ToolResultDetails part={part} imageUrl={open ? imageUrl : undefined} />
          </div>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** ≥2 consecutive completed same-name tools collapse under one header (neo D6). */
function ToolGroupView({ entry, imageUrl }: { entry: GroupEntry; imageUrl?: ToolImageUrl }) {
  const [expanded, setExpanded] = useState(entry.parts.length <= 3);
  const failedCount = entry.parts.filter((part) => part.status === "error").length;

  return (
    <div className="anim-in">
      <button
        type="button"
        className="activity-row"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="activity-row-main">
          <span className="activity-label activity-truncate">{entry.label}</span>
          <span className="activity-meta">({entry.parts.length})</span>
          {failedCount > 0 ? (
            <span className="activity-fail">· {failedCount} failed</span>
          ) : null}
        </span>
        <Chevron open={expanded} />
      </button>
      <Collapsible open={expanded}>
        <div className="group-children">
          {entry.parts.map((part) => (
            <CompletedToolRow key={part.toolCallId} part={part} imageUrl={imageUrl} />
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

/** Folded prior activity: muted summary row, expands to the folded parts (neo D7). */
function FoldedActivity({ entry, imageUrl }: { entry: FoldedEntry; imageUrl?: ToolImageUrl }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="anim-in">
      <button
        type="button"
        className="activity-row activity-row-completed"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="activity-label activity-grow activity-truncate">
          {entry.label}
        </span>
        <Chevron open={expanded} />
      </button>
      <Collapsible open={expanded}>
        <div className="activity-children">
          {entry.children.map((child) => (
            <EntryView
              key={entryKey(child)}
              entry={child}
              liveReasoningIndex={-1}
              liveTextIndex={-1}
              imageUrl={imageUrl}
            />
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

function PartView({
  part,
  live,
  streaming,
  imageUrl,
  markdownLinks,
}: {
  part: AssistantPart;
  live: boolean;
  streaming: boolean;
  imageUrl?: ToolImageUrl;
  markdownLinks?: Pick<MarkdownTextProps, "resolveLink" | "onNavigate" | "linkRevision">;
}) {
  if (part.kind === "text") {
    return (
      <div className={streaming ? "msg-text msg-text-live anim-in" : "msg-text anim-in"}>
        <MarkdownText text={part.text} {...markdownLinks} />
      </div>
    );
  }
  if (part.kind === "reasoning") {
    return <ReasoningBlock text={part.text} live={live} />;
  }
  return part.status === "running" ? (
    <ToolActiveRow part={part} />
  ) : (
    <CompletedToolRow part={part} imageUrl={imageUrl} />
  );
}

function entryKey(entry: RenderEntry): string {
  switch (entry.kind) {
    case "part":
      return entry.part.kind === "tool"
        ? `tool-${entry.part.toolCallId}`
        : `part-${entry.index}`;
    case "group":
      return `group-${entry.parts[0]?.toolCallId ?? entry.label}`;
    case "folded":
      return `folded-${entry.index}`;
  }
}

function EntryView({
  entry,
  liveReasoningIndex,
  liveTextIndex,
  markdownLinks,
  imageUrl,
}: {
  entry: RenderEntry;
  liveReasoningIndex: number;
  liveTextIndex: number;
  imageUrl?: ToolImageUrl;
  markdownLinks?: Pick<MarkdownTextProps, "resolveLink" | "onNavigate" | "linkRevision">;
}) {
  switch (entry.kind) {
    case "part":
      return (
        <PartView
          part={entry.part}
          live={entry.part.kind === "reasoning" && entry.index === liveReasoningIndex}
          streaming={entry.part.kind === "text" && entry.index === liveTextIndex}
          imageUrl={imageUrl}
          markdownLinks={markdownLinks}
        />
      );
    case "group":
      return <ToolGroupView entry={entry} imageUrl={imageUrl} />;
    case "folded":
      return <FoldedActivity entry={entry} imageUrl={imageUrl} />;
  }
}

function AssistantMessage({
  item,
  liveItem,
  markdownLinks,
  imageUrl,
}: {
  item: AssistantItem;
  liveItem: boolean;
  markdownLinks?: Pick<MarkdownTextProps, "resolveLink" | "onNavigate" | "linkRevision">;
  imageUrl?: ToolImageUrl;
}) {
  const parts = item.parts;
  const lastPart = parts.at(-1);
  const latestReasoningIndex = parts.reduce(
    (latest, part, index) => part.kind === "reasoning" ? index : latest,
    -1,
  );
  const liveReasoningIndex =
    liveItem && lastPart?.kind === "reasoning" ? latestReasoningIndex : -1;
  const liveTextIndex = liveItem && lastPart?.kind === "text" ? parts.length - 1 : -1;
  const hasFinalText = lastPart?.kind === "text" && parts.length > 1;
  const messageAtRef = useRef(item.at);
  const wasLiveRef = useRef(liveItem);

  if (messageAtRef.current !== item.at) {
    messageAtRef.current = item.at;
    wasLiveRef.current = liveItem;
  } else if (liveItem) {
    wasLiveRef.current = true;
  }

  // Fold earlier rounds after the next round starts; entering its tool phase
  // must not cancel the delay just because reasoning is no longer live.
  const [liveFoldIndex, setLiveFoldIndex] = useState(-1);

  // A different assistant message occupying this slot resets the fold state.
  useEffect(() => {
    setLiveFoldIndex(-1);
  }, [item.at]);

  useEffect(() => {
    if (latestReasoningIndex <= 0) return;
    const timer = window.setTimeout(() => {
      setLiveFoldIndex((current) => Math.max(current, latestReasoningIndex));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [latestReasoningIndex, item.at]);

  const animateFinalFold = hasFinalText && wasLiveRef.current;
  useEffect(() => {
    if (!animateFinalFold) return;
    const timer = window.setTimeout(() => {
      setLiveFoldIndex((current) => Math.max(current, parts.length));
    }, FINAL_ACTIVITY_FOLD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [animateFinalFold, parts.length]);

  let foldBeforeIndex = -1;
  if (hasFinalText) {
    // Let the final reasoning finish its own collapse before absorbing it into
    // the accumulated run summary. Restored messages render fully folded.
    foldBeforeIndex = animateFinalFold ? liveFoldIndex : parts.length;
  } else if (liveItem) {
    foldBeforeIndex = liveFoldIndex;
  } else {
    // Completed message: fold immediately when a later reasoning exists.
    const lateReasoningIndex = parts.findIndex(
      (part, index) => index > 0 && part.kind === "reasoning",
    );
    if (lateReasoningIndex > 0) {
      foldBeforeIndex = lateReasoningIndex;
    }
  }

  const entries = useMemo(
    () => buildRenderEntries(parts, { foldBeforeIndex }),
    [parts, foldBeforeIndex],
  );

  return (
    <div data-testid="timeline-assistant">
      {entries.map((entry) => (
        <EntryView
          key={entryKey(entry)}
          entry={entry}
          liveReasoningIndex={liveReasoningIndex}
          liveTextIndex={liveTextIndex}
          markdownLinks={markdownLinks}
          imageUrl={imageUrl}
        />
      ))}
      {!liveItem && lastPart?.kind === "text" && lastPart.text.trim() ? (
        <CopyButton text={lastPart.text} className="msg-assistant-copy" />
      ) : null}
    </div>
  );
}

function UserMessage({ item, onClipNavigate }: {
  item: Extract<TimelineItem, { kind: "user" }>;
  onClipNavigate?: (clip: ContextClip) => void;
}) {
  return (
    <div className="msg-user" data-testid="timeline-user">
      <div className="msg-user-wrap">
        {item.clips?.length ? (
          <ContextClipDetails
            clips={item.clips}
            className="timeline-clips"
            align="right"
            onNavigate={onClipNavigate}
          />
        ) : null}
        {item.command ? <PromptCommandBadge command={item.command} /> : item.text.trim().length > 0 ? (
          <div className="msg-user-bubble">
            <div className="msg-user-text">{item.text}</div>
          </div>
        ) : null}
        {!item.command && item.text.trim().length > 0 ? (
          <CopyButton text={item.text} className="msg-user-copy" />
        ) : null}
      </div>
    </div>
  );
}

export type MessageViewProps = {
  item: TimelineItem;
  sessionBusy: boolean;
  isLast: boolean;
  timestampLabel?: string;
  markdownLinks?: Pick<MarkdownTextProps, "resolveLink" | "onNavigate" | "linkRevision">;
  onClipNavigate?: (clip: ContextClip) => void;
  toolImageUrl?: ToolImageUrl;
};

export function MessageView({
  item,
  sessionBusy,
  isLast,
  timestampLabel,
  markdownLinks,
  onClipNavigate,
  toolImageUrl,
}: MessageViewProps) {
  return (
    <div>
      {timestampLabel ? <TimestampDivider label={timestampLabel} /> : null}
      {item.kind === "user" ? (
        <UserMessage item={item} onClipNavigate={onClipNavigate} />
      ) : item.kind === "error" ? (
        <div className="msg-error" data-testid="timeline-error" role="alert">
          {item.message}
        </div>
      ) : (
        <AssistantMessage item={item} liveItem={isLast && sessionBusy} markdownLinks={markdownLinks} imageUrl={toolImageUrl} />
      )}
    </div>
  );
}
