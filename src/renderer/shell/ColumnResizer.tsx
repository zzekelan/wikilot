import { useRef, type KeyboardEvent, type PointerEvent } from "react";

type ColumnResizerProps = {
  /** Accessible name, e.g. "Resize Sidebar". */
  label: string;
  /** Incremental horizontal drag delta (px) since the previous move event. */
  onDrag: (deltaX: number) => void;
  /** Keyboard step (ArrowLeft/ArrowRight), in 16px increments. */
  onStep: (direction: -1 | 1) => void;
  /** Drag start/end, so the shell can suppress width transitions mid-drag. */
  onActiveChange?: (active: boolean) => void;
};

/**
 * Vertical separator between shell columns (Sidebar / Workspace Pane). Pointer-drag
 * with capture; keyboard-operable via arrow keys (WAI separator pattern).
 */
export function ColumnResizer({
  label,
  onDrag,
  onStep,
  onActiveChange,
}: ColumnResizerProps) {
  const lastXRef = useRef<number | null>(null);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    lastXRef.current = event.clientX;
    onActiveChange?.(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (
      lastXRef.current === null ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }
    const delta = event.clientX - lastXRef.current;
    lastXRef.current = event.clientX;
    if (delta !== 0) onDrag(delta);
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    lastXRef.current = null;
    onActiveChange?.(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onStep(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onStep(1);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className="shell-resizer"
      data-testid="column-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
