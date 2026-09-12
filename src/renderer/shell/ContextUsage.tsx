import { useEffect, useId, useState } from "react";
import type { SessionContextState } from "../../shared/timeline";
import { pushEscapeLayer } from "../escape-stack";
import "./ContextUsage.css";

export function ContextUsage({ context, loading }: {
  context: SessionContextState;
  loading: boolean;
}) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = (hovered || focused) && !dismissed;
  useEffect(() => {
    if (open) return pushEscapeLayer(() => setDismissed(true));
  }, [open]);
  const available = context.status !== "unavailable";
  const used = available ? context.usedTokens : null;
  const capacity = available ? context.contextWindow : 0;
  const remaining = used === null ? null : Math.max(0, capacity - used);
  const remainingPercent = remaining === null ? null : remaining / capacity * 100;
  const percent = remainingPercent === null ? "—"
    : remainingPercent > 0 && remainingPercent < 1 ? "<1%"
    : `${Math.floor(remainingPercent)}%`;
  const status = loading ? "Loading…"
    : context.status === "compacting" ? "Compacting…"
    : !available ? "Unavailable"
    : used === null ? "Pending" : undefined;
  const known = !status && used !== null;
  const ratio = known ? Math.min(1, used / capacity) : 0;
  const format = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const label = status ?? `~${percent} left`;

  return (
    <div className="context-usage" data-open={open || undefined}
      onMouseEnter={() => { setHovered(true); setDismissed(false); }}
      onMouseLeave={() => setHovered(false)}>
      <button type="button" className="context-usage-trigger"
        data-testid="context-usage" aria-label={`Context: ${label}`}
        aria-describedby={id} onFocus={() => { setFocused(true); setDismissed(false); }}
        onBlur={() => setFocused(false)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"
          className={loading || context.status === "compacting" ? "context-usage-spinning" : undefined}>
          <circle cx="10" cy="10" r="7.5" strokeWidth="3"
            className={known ? "context-usage-track" : "context-usage-unknown"}
            strokeDasharray={known ? undefined : "2 3"} />
          {known && ratio > 0 ? <circle cx="10" cy="10" r="7.5"
            className="context-usage-fill" strokeWidth="3" strokeLinecap="round"
            pathLength="100" strokeDasharray={`${ratio * 100} 100`}
            transform="rotate(-90 10 10)" /> : null}
        </svg>
      </button>
      <div id={id} role="tooltip" className="context-usage-details">
        <strong>Context{status ? ` · ${status}` : ""}</strong>
        {available && !loading ? <dl>
          <dt>Model</dt><dd>{context.provider}/{context.model}</dd>
          <dt>Used</dt><dd>{known ? `~${format(used!)} tokens` : "—"}</dd>
          <dt>Capacity</dt><dd>{format(capacity)} tokens</dd>
          <dt>Remaining</dt><dd>{known ? `~${format(remaining!)} tokens · ${percent}` : "—"}</dd>
          {known && used! > capacity ? <><dt>Over by</dt><dd>~{format(used! - capacity)} tokens</dd></> : null}
        </dl> : null}
      </div>
    </div>
  );
}
