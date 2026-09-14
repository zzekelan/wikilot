import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { ProtectedFileChangeResult } from "../workspace-pane";
import { recordUiGesture } from "../telemetry";

/** Selection and internal drag lifetime stay in the File Tree; the Pane owns document protection. */
export function useFileTreeMove(options: {
  activePath: string | null;
  visiblePaths: string[];
  disabled: boolean;
  expand: (path: string) => void;
  refresh: () => void;
  import?: (destination: string, transfer: DataTransfer) => Promise<void>;
  move?: (paths: string[], destination: string) => Promise<ProtectedFileChangeResult>;
}) {
  const [selected, setSelected] = useState<string[]>(options.activePath ? [options.activePath] : []);
  const anchor = useRef<string | null>(options.activePath);
  const dragging = useRef<string[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const pending = useRef(false);
  useEffect(() => { setSelected(options.activePath ? [options.activePath] : []); }, [options.activePath]);
  function clearHover() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTarget(null);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function select(path: string, event: MouseEvent) {
    if (options.disabled || pending.current) return false;
    if (event.shiftKey) {
      const start = options.visiblePaths.indexOf(anchor.current ?? path);
      const end = options.visiblePaths.indexOf(path);
      const range = start < 0 ? [path] : options.visiblePaths.slice(Math.min(start, end), Math.max(start, end) + 1);
      setSelected(event.metaKey || event.ctrlKey ? [...new Set([...selected, ...range])] : range);
    } else if (event.metaKey || event.ctrlKey) {
      setSelected(selected.includes(path) ? selected.filter(item => item !== path) : [...selected, path]);
      anchor.current = path;
    } else {
      setSelected([path]); anchor.current = path;
      return true;
    }
    return false;
  }
  function start(path: string, event: DragEvent) {
    if (options.disabled || pending.current || !options.move) { event.preventDefault(); return; }
    dragging.current = selected.includes(path) ? selected : [path];
    setSelected(dragging.current);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-wikilot-file-tree", "move");
  }
  function over(path: string | null, event: DragEvent) {
    event.stopPropagation();
    if (options.disabled || pending.current || path === null || dragging.current?.some(source => path === source || path.startsWith(`${source}/`))) {
      clearHover(); return;
    }
    event.preventDefault(); event.dataTransfer.dropEffect = dragging.current ? "move" : "copy";
    if (target === path) return;
    clearHover(); setTarget(path);
    if (path) timer.current = setTimeout(() => options.expand(path), 650);
  }
  function end() { dragging.current = null; clearHover(); }
  async function drop(path: string | null, event: DragEvent) {
    event.stopPropagation();
    const paths = dragging.current;
    const valid = path !== null && !paths?.some(source => path === source || path.startsWith(`${source}/`));
    end();
    event.preventDefault();
    if (options.disabled || pending.current) return;
    if (!paths) { if (path !== null) await options.import?.(path, event.dataTransfer); return; }
    if (!valid || !options.move) return;
    event.preventDefault(); pending.current = true; setMoving(true); setMessage(null);
    try {
      const result = await options.move(paths, path);
      if (result.status === "blocked") {
        setMessage(result.reason === "unconfirmed" ? "Could not confirm the file locations. Check the File Tree and disk; writes remain paused."
          : "Move stopped: could not save all edits. Your drafts are preserved.");
        recordUiGesture("workspace.files.move", { "wikilot.operation.blocked_reason": result.reason });
      } else {
        const { report } = result;
        setMessage(report.failures.length ? report.failures.map(failure => `${failure.source || "Destination"}: ${failure.message}`).join("\n") : null);
        setSelected(paths.filter(path => !report.relocated.some(({ from }) => path === from || path.startsWith(`${from}/`))));
        recordUiGesture("workspace.files.move", {
          "wikilot.operation.success_count": String(report.relocated.length),
          "wikilot.operation.failure_count": String(report.failures.length),
        });
        options.expand(path); options.refresh();
      }
    } catch { setMessage("Could not confirm the move. Check the File Tree and disk before trying again."); }
    finally { pending.current = false; setMoving(false); }
  }
  return { selected, select, selectMany: (paths: string[]) => { setSelected(paths); anchor.current = paths[0] ?? null; }, selectOnly: (path: string) => { setSelected([path]); anchor.current = path; }, target, start, over, drop, end, clearHover, message, moving };
}
