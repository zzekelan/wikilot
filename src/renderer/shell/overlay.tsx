import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { pushEscapeLayer } from "../escape-stack";
import "./overlay.css";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableChildren(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Cycle Tab within `ref` while `active` (modal dialogs and popovers). */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const focusables = focusableChildren(root);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const focused = document.activeElement as HTMLElement | null;
      // Focus outside the trap — or on the dialog shell itself (reached by
      // clicking padding) — re-enters at the edges instead of escaping.
      if (!root.contains(focused) || focused === root) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && focused === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [ref, active]);
}

/**
 * Capture the focused element when `active` turns on and return focus to it
 * when the overlay closes (or unmounts). Desktop focus convention: closing an
 * overlay lands back on its trigger.
 */
export function useFocusReturn(active: boolean): void {
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [active]);
}

export type ModalProps = {
  /** Accessible name for the dialog. */
  label: string;
  /** Dismissible Modals close on backdrop click and on the global Esc broadcast. */
  dismissible?: boolean;
  onClose?: () => void;
  /** Element to focus on open; defaults to the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
};

/**
 * Shared modal overlay: focus moves in on open, Tab cycles inside, and focus
 * returns to the triggering element on close. Esc closes only the newest
 * registered transient surface.
 */
export function Modal({
  label,
  dismissible = true,
  onClose,
  initialFocusRef,
  className,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true);
  useFocusReturn(true);

  // Focus the dialog on open.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const target = initialFocusRef?.current ?? focusableChildren(dialog)[0] ?? dialog;
    target.focus();
    // Open-time behavior only; children re-render without stealing focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dismissible || !onClose) return;
    return pushEscapeLayer(onClose);
  }, [dismissible, onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        ref={dialogRef}
        className={className ?? "modal-dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}
