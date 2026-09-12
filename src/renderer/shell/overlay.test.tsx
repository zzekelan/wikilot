/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./overlay";
import { ShortcutProvider } from "../shortcuts";
import { ToastProvider } from "../feedback";

afterEach(cleanup);

describe("Modal", () => {
  it("moves focus into the dialog on open and returns it on close", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Trigger
          </button>
          {open ? (
            <Modal label="Confirm" onClose={() => setOpen(false)}>
              <button type="button">First</button>
              <button type="button" onClick={() => setOpen(false)}>
                Last
              </button>
            </Modal>
          ) : null}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByText("Trigger");
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Confirm" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByText("First"));
    fireEvent.click(screen.getByText("Last"));
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles Tab within the dialog", () => {
    render(
      <Modal label="Confirm">
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>,
    );
    const first = screen.getByText("First");
    const last = screen.getByText("Last");
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes a dismissible Modal from the Escape stack only", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ToastProvider><ShortcutProvider>
        <Modal label="Confirm" onClose={onClose}>
          <button type="button">OK</button>
        </Modal>
      </ShortcutProvider></ToastProvider>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(
      <ToastProvider><ShortcutProvider>
        <Modal label="Confirm" dismissible={false} onClose={onClose}>
          <button type="button">OK</button>
        </Modal>
      </ShortcutProvider></ToastProvider>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves Tab into the dialog when focus sits on the dialog shell itself", () => {
    render(
      <Modal label="Confirm">
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Confirm" });
    dialog.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("First"));
    dialog.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("Last"));
  });

  it("includes disclosure controls at the end of the keyboard cycle", () => {
    render(<Modal label="Details"><button type="button">First</button><details><summary>Models</summary><p>Model list</p></details></Modal>);
    const first = screen.getByText("First");
    const summary = screen.getByText("Models");
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(summary);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

});
