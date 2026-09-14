import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { FilePlus, FolderPlus, Pencil, Import, Trash2 } from "lucide-react";
import { pushEscapeLayer } from "../escape-stack";

export type FileTreeMenuTarget = { parent: string; entry?: { path: string; name: string; kind: "file" | "directory" }; x: number; y: number; trigger: HTMLElement };

export function FileTreeMenu({ target, onClose, onCreate, onRename, onImport, onTrash }: {
  target: FileTreeMenuTarget;
  onClose: () => void;
  onRename: () => void;
  onTrash: () => void;
  onImport: (kind: "file" | "directory") => void;
  onCreate: (kind: "file" | "directory") => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current!;
    const position = () => {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))}px`;
    };
    position();
    element.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) onClose();
    };
    const pop = pushEscapeLayer(() => { onClose(); target.trigger.focus(); });
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", position);
    return () => {
      pop();
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", position);
    };
  }, [target, onClose]);

  return createPortal(<div ref={menu} role="menu" aria-label="File actions" className="file-tree-menu"
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (index + 1) % items.length
        : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
      if (next !== null) { event.preventDefault(); items[next]!.focus(); }
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault(); event.stopPropagation(); onClose(); target.trigger.focus();
      }
    }}>
    {target.entry?.kind !== "file" ? <><button type="button" role="menuitem" onClick={() => onCreate("file")}><FilePlus size={15} />New file</button>
    <button type="button" role="menuitem" onClick={() => onCreate("directory")}><FolderPlus size={15} />New folder</button>
    <button type="button" role="menuitem" onClick={() => onImport("file")}><Import size={15} />Import files…</button>
    <button type="button" role="menuitem" onClick={() => onImport("directory")}><Import size={15} />Import folder…</button></> : null}
    {target.entry ? <><button type="button" role="menuitem" onClick={onRename}><Pencil size={15} />Rename</button>
    <button type="button" role="menuitem" onClick={onTrash}><Trash2 size={15} />Move to Trash</button></> : null}
  </div>, document.body);
}
