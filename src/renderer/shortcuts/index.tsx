import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { closeTopEscapeLayer, pushEscapeLayer } from "../escape-stack";
import { useToast } from "../feedback";

export type ShortcutHandler = {
  handler: () => void;
  label: string;
  /** Returns why the shortcut is unavailable right now, or null when usable. */
  when?: () => string | null;
};

export type ShortcutEntry = ShortcutHandler & { combo: string };

type ShortcutContextValue = {
  /** Register a normalized combo ("meta+shift+k"); returns an unregister fn. */
  registerShortcut: (combo: string, shortcut: ShortcutHandler) => () => void;
  shortcuts: ShortcutEntry[];
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
};

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

export function useShortcuts(): ShortcutContextValue {
  const value = useContext(ShortcutContext);
  if (!value) throw new Error("useShortcuts must be used within ShortcutProvider");
  return value;
}

const MODIFIER_KEYS = new Set(["meta", "control", "shift", "alt"]);

/** Format a normalized combo for display: "meta+shift+k" -> "⌘⇧K". */
export function formatKeyCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      if (part === "meta") return "⌘";
      if (part === "shift") return "⇧";
      if (part === "alt") return "⌥";
      if (part === "control") return "⌃";
      return part.toUpperCase();
    })
    .join("");
}

export function formatWindowsKeyCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      if (part === "meta") return "Ctrl";
      if (part === "shift") return "Shift";
      if (part === "alt") return "Alt";
      if (part === "control") return "Ctrl";
      return part.toUpperCase();
    })
    .join("+");
}

function snapshotRegistry(registry: Map<string, ShortcutHandler>): ShortcutEntry[] {
  return Array.from(registry, ([combo, shortcut]) => ({ combo, ...shortcut }));
}

/**
 * Global keyboard shortcuts: a combo registry, a capture-phase window keydown
 * listener, and the built-in Command Palette toggle (meta+k).
 */
export function ShortcutProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef(new Map<string, ShortcutHandler>());
  const [shortcuts, setShortcuts] = useState<ShortcutEntry[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { showToast } = useToast();

  const registerShortcut = useCallback(
    (combo: string, shortcut: ShortcutHandler) => {
      registryRef.current.set(combo, shortcut);
      setShortcuts(snapshotRegistry(registryRef.current));
      return () => {
        registryRef.current.delete(combo);
        setShortcuts(snapshotRegistry(registryRef.current));
      };
    },
    [],
  );

  const togglePalette = useCallback(() => setPaletteOpen((open) => !open), []);

  useEffect(
    () => registerShortcut("meta+k", {
      label: "Open Command Palette",
      handler: togglePalette,
    }),
    [registerShortcut, togglePalette],
  );

  useEffect(() => {
    if (!paletteOpen) return;
    return pushEscapeLayer(() => setPaletteOpen(false));
  }, [paletteOpen]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // A customizable native select is a top-layer surface. Let the browser
      // handle its keys before any app shortcut or outer Escape layer.
      if (document.querySelector("select:open")) return;
      const active = document.activeElement as HTMLElement | null;
      const isInputFocused = active?.tagName === "INPUT"
        || active?.tagName === "TEXTAREA"
        || Boolean(active?.isContentEditable);
      const hasModifier = event.metaKey || event.ctrlKey;
      if (isInputFocused && !hasModifier && event.key !== "Escape") return;

      const parts: string[] = [];
      if (hasModifier) parts.push("meta");
      if (event.shiftKey) parts.push("shift");
      if (event.altKey) parts.push("alt");
      const rawKey = event.key.toLowerCase();
      if (!MODIFIER_KEYS.has(rawKey)) parts.push(rawKey);

      const shortcut = registryRef.current.get(parts.join("+"));
      if (shortcut) {
        event.preventDefault();
        event.stopPropagation();
        const unavailable = shortcut.when?.();
        if (unavailable) {
          showToast(`${shortcut.label}: ${unavailable}`);
          return;
        }
        shortcut.handler();
        return;
      }

      if (event.key === "Escape" && !event.defaultPrevented && closeTopEscapeLayer()) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [showToast]);

  const value = useMemo(
    () => ({
      registerShortcut,
      shortcuts,
      paletteOpen,
      setPaletteOpen,
      togglePalette,
    }),
    [registerShortcut, shortcuts, paletteOpen, togglePalette],
  );

  return <ShortcutContext.Provider value={value}>{children}</ShortcutContext.Provider>;
}
