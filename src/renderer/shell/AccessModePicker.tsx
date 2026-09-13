import { useEffect, useId, useRef, useState } from "react";
import { Check, ShieldCheck, ShieldOff } from "lucide-react";
import type { AccessMode } from "../../shared/workspace";
import { pushEscapeLayer } from "../escape-stack";
import "./AccessModePicker.css";

const MODES = [
  { id: "auto-review", label: "Auto Review", description: "Review tool actions before execution.", Icon: ShieldCheck },
  { id: "full-access", label: "Full Access", description: "Run tools without automatic review.", Icon: ShieldOff },
] as const;

export function AccessModePicker({ mode, disabled, onChange }: {
  mode: AccessMode;
  disabled: boolean;
  onChange(mode: AccessMode): Promise<unknown>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = MODES.find((item) => item.id === mode)!;

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const removeEscape = pushEscapeLayer(() => { setOpen(false); trigger.current?.focus(); });
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => { removeEscape(); document.removeEventListener("mousedown", outside); };
  }, [open]);

  async function select(value: AccessMode) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (value !== mode) await onChange(value);
      setOpen(false);
      trigger.current?.focus();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  }

  return <div ref={root} className="composer-access-control">
    <button ref={trigger} type="button" className="composer-model-chip composer-access-trigger"
      data-testid="composer-access-mode" aria-label={`Access mode: ${selected.label}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled || saving} onClick={() => { setOpen(!open); setError(null); }}>
      <selected.Icon size={16} aria-hidden="true" />
      <span>{selected.label}</span>
    </button>
    {open && !disabled ? <div id={id} ref={menu} className="composer-picker composer-access-menu"
      role="menu" aria-label="Access mode" onKeyDown={(event) => {
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (index + 1) % items.length
          : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : undefined;
        if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
        if (event.key === "Tab") setOpen(false);
      }}>
      {MODES.map(({ id, label, description, Icon }) => <button key={id} type="button"
        className="composer-picker-option" role="menuitemradio" aria-checked={mode === id}
        disabled={saving} onClick={() => void select(id)}>
        <Icon size={16} aria-hidden="true" />
        <span className="composer-access-option-label"><span>{label}</span><small>{description}</small></span>
        {mode === id ? <Check size={14} className="composer-picker-check" aria-hidden="true" /> : null}
      </button>)}
      {error ? <p role="alert" className="composer-access-error">{error}</p> : null}
    </div> : null}
  </div>;
}
