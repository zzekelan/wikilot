import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./CommandPalette.css";
import { useFocusReturn, useFocusTrap } from "./overlay";
import { formatKeyCombo, formatWindowsKeyCombo, useShortcuts, type ShortcutEntry } from "../shortcuts";
import { useToast } from "../feedback";

/**
 * Command Palette (neo-coworker): ⌘K overlay listing registered shortcuts,
 * query filter, ArrowUp/Down + Enter, kbd chips per combo.
 */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, shortcuts } = useShortcuts();
  const { showToast } = useToast();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, paletteOpen);
  useFocusReturn(paletteOpen);

  const filtered = shortcuts.filter(
    (shortcut) =>
      // The palette never lists its own toggle command.
      shortcut.combo !== "meta+k" &&
      shortcut.label.toLowerCase().includes(query.toLowerCase()),
  );
  const selected = Math.min(selectedIndex, Math.max(filtered.length - 1, 0));

  useEffect(() => {
    if (!paletteOpen) return;
    setQuery("");
    setSelectedIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, [paletteOpen]);

  if (!paletteOpen) return null;

  function run(command: ShortcutEntry) {
    // Unavailable commands explain themselves and keep the palette open.
    const unavailable = command.when?.();
    if (unavailable) {
      showToast(`${command.label}: ${unavailable}`);
      return;
    }
    setPaletteOpen(false);
    command.handler();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        setSelectedIndex((index) => (index + 1) % filtered.length);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        setSelectedIndex(
          (index) => (index - 1 + filtered.length) % filtered.length,
        );
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[selected];
      if (command) run(command);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setPaletteOpen(false);
    }
  }

  return (
    <div className="palette-overlay">
      <div
        className="palette-backdrop"
        aria-hidden="true"
        onClick={() => setPaletteOpen(false)}
      />
      <div
        ref={panelRef}
        className="palette-panel"
        data-testid="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
      >
        <div className="palette-input-row">
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command…"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">No commands found.</div>
          ) : (
            <ul className="palette-items">
              {filtered.map((command, index) => (
                <li key={command.combo}>
                  <button
                    type="button"
                    className={
                      index === selected
                        ? "palette-item palette-item-selected"
                        : "palette-item"
                    }
                    onClick={() => run(command)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span>{command.label}</span>
                    <span className="palette-kbds">
                      <span className="palette-platform"><small>macOS</small><kbd className="kbd">{formatKeyCombo(command.combo)}</kbd></span>
                      <span className="palette-platform"><small>Windows/Linux</small><kbd className="kbd">{formatWindowsKeyCombo(command.combo)}</kbd></span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="palette-footer" aria-hidden="true">
          <span>
            <kbd className="kbd">↑↓</kbd> Navigate
          </span>
          <span>
            <kbd className="kbd">⏎</kbd> Run
          </span>
          <span>
            <kbd className="kbd">esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  );
}
