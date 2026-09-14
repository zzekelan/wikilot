import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, History, Pencil, X } from "lucide-react";
import type { Version, VersionsSnapshot } from "../../shared/versions";
import { client } from "../client";
import { pushEscapeLayer } from "../escape-stack";
import { recordUiGesture } from "../telemetry";
import { CurrentChanges } from "./CurrentChanges";
import "./VersionsDrawer.css";

/** A Workspace action beside its rail trigger, independent of Workspace Tabs. */
export function VersionsDrawer({ workspaceId, sessionId, enabled, beforeSave }: {
  workspaceId: string;
  sessionId?: string;
  enabled: boolean;
  beforeSave?: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<VersionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Version | null>(null);
  const [restoring, setRestoring] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [manual, setManual] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [position, setPosition] = useState({ left: 12, top: 80, width: 328, maxHeight: 500 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);

  const close = useCallback((focus = false) => {
    setOpen(false);
    setRestoreTarget(null);
    if (focus) triggerRef.current?.focus();
  }, []);
  useEffect(() => { if (!enabled) close(); }, [enabled, close]);
  const refresh = useCallback(async (offset = 0) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const next = await client.getVersions(workspaceId, offset);
      if (!mounted.current || id !== requestId.current) return;
      setSnapshot(previous => offset && previous
        ? { ...next, versions: [...previous.versions, ...next.versions.filter(v => !previous.versions.some(old => old.id === v.id))] }
        : next);
    } catch (error) {
      if (mounted.current && id === requestId.current) setError(error instanceof Error ? error.message : String(error));
    } finally { if (mounted.current && id === requestId.current) setLoading(false); }
  }, [workspaceId]);

  useEffect(() => {
    if (!open || busy) return;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 150); };
    const unsubscribe = client.subscribeEvents(event => {
      if ("type" in event && (event.type === "workspace_files_changed" || event.type === "workspace_versions_changed") && event.workspaceId === workspaceId) update();
    }, update);
    window.addEventListener("focus", update);
    return () => { clearTimeout(timer); unsubscribe(); window.removeEventListener("focus", update); };
  }, [open, busy, refresh, workspaceId]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = triggerRef.current!.getBoundingClientRect();
      const width = Math.min(328, window.innerWidth - 24);
      const sideLeft = triggerRef.current!.closest("aside")!.getBoundingClientRect().right + 8;
      const fits = sideLeft + width <= window.innerWidth - 12;
      const left = fits ? sideLeft : Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const top = Math.max(12, Math.min(fits ? rect.top : rect.bottom + 6, window.innerHeight - 160));
      setPosition({ left, top, width, maxHeight: window.innerHeight - top - 12 });
    }
    place();
    const observer = new ResizeObserver(place); observer.observe(triggerRef.current!);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const pop = pushEscapeLayer(() => close(true));
    function dismiss(event: Event) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    }
    document.addEventListener("pointerdown", dismiss); document.addEventListener("focusin", dismiss);
    return () => { pop(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("focusin", dismiss); };
  }, [open, close]);
  useEffect(() => { if (manual && open) messageRef.current?.focus(); }, [manual, open]);

  useEffect(() => {
    if (restoreTarget) confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [restoreTarget]);

  async function restore() {
    if (!restoreTarget || busy) return;
    setBusy(true); setRestoring(true); setError(null); setNotice("");
    try {
      if (beforeSave && !(await beforeSave())) throw new Error("Save your open documents before restoring a version.");
      const result = await client.restoreVersion(workspaceId, restoreTarget.id);
      if (!mounted.current) return;
      setRestoreTarget(null);
      setNotice(result.restored ? "Version restored" : "Already at this version");
      await refresh();
      if (panelRef.current) panelRef.current.scrollTop = 0;
    } catch (error) {
      if (mounted.current) { setError(error instanceof Error ? error.message : String(error)); await refresh(); }
    } finally { if (mounted.current) { setBusy(false); setRestoring(false); } }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !snapshot || (manual && !message.trim())) return;
    setBusy(true); setRestoreTarget(null); setError(null); setNotice("");
    try {
      if (beforeSave && !(await beforeSave())) throw new Error("Save your open documents before saving a version.");
      const result = await client.saveVersion(workspaceId, { ...(manual ? { message: message.trim() } : {}), ...(sessionId ? { sessionId } : {}) });
      if (!mounted.current) return;
      setNotice(result.saved ? "Version saved" : "");
      setMessage(""); setManual(false);
      await refresh();
      if (panelRef.current) panelRef.current.scrollTop = 0;
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally { if (mounted.current) setBusy(false); }
  }

  return <>
    <button ref={triggerRef} type="button" className={`sidebar-primary-row${open ? " versions-trigger-active" : ""}`}
      aria-label="Versions" title="Versions" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? "versions-drawer" : undefined} disabled={!enabled}
      onClick={() => { setOpen(!open); if (!open) { setNotice(""); setError(null); recordUiGesture("versions.open", { "wikilot.gesture": "versions.open" }); } }}>
      <History size={16} aria-hidden="true" /><span className="sidebar-primary-row-label">Versions</span>
      <ChevronRight size={15} className="versions-chevron" aria-hidden="true" />
    </button>
    {open && enabled ? createPortal(<section ref={panelRef} id="versions-drawer" className="versions-drawer" role="dialog" aria-label="Versions" style={position}>
      <header className="versions-header"><span>Versions</span><button type="button" className="icon-btn" aria-label="Close versions" onClick={() => close(true)}><X size={15} /></button></header>
      <form className="versions-save" onSubmit={event => void save(event)}>
        {snapshot ? <CurrentChanges workspaceId={workspaceId} snapshot={snapshot} /> : <div className="versions-status">{loading ? "Loading…" : "Unavailable"}</div>}
        {manual ? <textarea ref={messageRef} className="workspace-input versions-message" rows={3} placeholder="Version message" aria-label="Version message" value={message} disabled={busy} onChange={event => setMessage(event.target.value)} /> : null}
        <div className="versions-actions">
          <button type="submit" className="btn-secondary versions-save-button" disabled={busy || !snapshot || (manual && !message.trim())}>
            {busy && !restoring ? "Saving…" : "Save version"}
          </button>
          <button type="button" className={manual ? "btn-secondary" : "icon-btn versions-write"} aria-label={manual ? "Cancel message" : "Write version message"}
            title={manual ? undefined : "Write message"} disabled={busy}
            onClick={() => setManual(!manual)}>{manual ? "Cancel" : <Pencil size={15} />}</button>
        </div>
        <div className="versions-notice" aria-live="polite">{notice}</div>
      </form>
      {error ? <div className="versions-error" role="alert"><span>{error}</span><button type="button" className="versions-text-button" disabled={busy} onClick={() => { setError(null); void refresh(); }}>Refresh</button></div> : null}
      {snapshot ? <div className="versions-history"><div className="versions-history-label">Recent versions</div>
        {snapshot.versions.length ? <ol>{snapshot.versions.map((version, index) => <li key={version.id}>
          <div className="versions-title">{version.message}</div>
          <div className="versions-meta"><time dateTime={version.date} title={new Date(version.date).toLocaleString()}>{new Date(version.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {new Date(version.date).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time><span>{version.files} {version.files === 1 ? "file" : "files"}</span>
            {index === 0 ? <span className="versions-current">Current</span> : <button type="button" className="versions-text-button versions-restore" disabled={busy}
              aria-label={`Restore ${version.message.split("\n")[0]}`} onClick={event => { restoreTriggerRef.current = event.currentTarget; setRestoreTarget(version); setError(null); setNotice(""); }}>Restore</button>}
          </div>
          {restoreTarget?.id === version.id ? <div ref={confirmRef} className="versions-confirm" role="group" aria-label="Restore version confirmation">
            <div>Restore this version?</div><p>Replace current files. Keep version history.</p>
            <div className="versions-confirm-actions"><button type="button" className="versions-text-button" disabled={busy} onClick={() => { setRestoreTarget(null); restoreTriggerRef.current?.focus(); }}>Cancel</button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void restore()}>{restoring ? "Restoring…" : "Restore version"}</button></div>
          </div> : null}
        </li>)}</ol> : <div className="versions-empty">No saved versions</div>}
        {snapshot.nextOffset !== null ? <button type="button" className="versions-text-button" disabled={loading || busy} onClick={() => void refresh(snapshot.nextOffset!)}>{loading ? "Loading…" : "Load more"}</button> : null}
      </div> : null}
    </section>, document.body) : null}
  </>;
}
