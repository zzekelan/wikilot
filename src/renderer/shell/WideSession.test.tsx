/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextClip } from "../../shared/session";
import { ContextClipDetails } from "./ContextClipDetails";
import { ShortcutProvider } from "../shortcuts";
import { ToastProvider } from "../feedback";
import { WideSession } from "./WideSession";

afterEach(cleanup);

function renderWide(open = false, height = 52) {
  const onOpenChange = vi.fn();
  const onDrawerHeightChange = vi.fn();
  render(
    <WideSession
      preview="Latest note"
      timelineOpen={open}
      onTimelineOpenChange={onOpenChange}
      drawerHeight={height}
      onDrawerHeightChange={onDrawerHeightChange}
      timeline={<div>Timeline content</div>}
      composer={<div>Composer content</div>}
    />,
  );
  return { onOpenChange, onDrawerHeightChange };
}

const clip: ContextClip = {
  source: { kind: "markdown", path: "notes/plan.md" },
  text: "selected evidence",
  fingerprint: "fnv1a:12345678",
  locator: {
    kind: "markdown",
    mode: "reading",
    start: 0,
    end: 17,
    exact: "selected evidence",
    prefix: "",
    suffix: "",
  },
};

describe("WideSession", () => {
  it("toggles the prototype timeline bar and closes the drawer on Escape", () => {
    const { onOpenChange } = renderWide();
    fireEvent.click(screen.getByRole("button", { name: "Expand Timeline" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    cleanup();
    const openChange = vi.fn();
    render(
      <ToastProvider>
        <ShortcutProvider>
          <WideSession
            preview="Latest note"
            timelineOpen
            onTimelineOpenChange={openChange}
            drawerHeight={52}
            onDrawerHeightChange={vi.fn()}
            timeline={<div>Timeline content</div>}
            composer={<div>Composer content</div>}
          />
        </ShortcutProvider>
      </ToastProvider>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(openChange).toHaveBeenCalledWith(false);
  });

  it("changes drawer height in 3 percent keyboard steps and clamps it", () => {
    function Harness() {
      const [height, setHeight] = useState(52);
      return <WideSession
        preview="Latest note"
        timelineOpen
        onTimelineOpenChange={vi.fn()}
        drawerHeight={height}
        onDrawerHeightChange={setHeight}
        timeline={<div>Timeline content</div>}
        composer={<div>Composer content</div>}
      />;
    }
    render(<Harness />);
    const grip = screen.getByRole("separator", { name: "Resize Timeline Drawer" });
    expect(grip.getAttribute("aria-valuenow")).toBe("52");
    for (let index = 0; index < 20; index += 1) fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(grip.getAttribute("aria-valuenow")).toBe("85");
    for (let index = 0; index < 30; index += 1) fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(grip.getAttribute("aria-valuenow")).toBe("30");
  });

  it("retains the controlled drawer height when wide mode remounts", () => {
    function Harness() {
      const [wide, setWide] = useState(true);
      const [height, setHeight] = useState(52);
      return <>
        <button type="button" onClick={() => setWide((value) => !value)}>Toggle wide</button>
        {wide ? <WideSession
          preview="Latest note"
          timelineOpen
          onTimelineOpenChange={vi.fn()}
          drawerHeight={height}
          onDrawerHeightChange={setHeight}
          timeline={<div>Timeline content</div>}
          composer={<div>Composer content</div>}
        /> : null}
      </>;
    }
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Timeline Drawer" }), { key: "ArrowUp" });
    expect(screen.getByRole("separator", { name: "Resize Timeline Drawer" }).getAttribute("aria-valuenow")).toBe("55");
    fireEvent.click(screen.getByRole("button", { name: "Toggle wide" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle wide" }));
    expect(screen.getByRole("separator", { name: "Resize Timeline Drawer" }).getAttribute("aria-valuenow")).toBe("55");
  });

  it("closes Clip details before the wide Timeline drawer", () => {
    const onOpenChange = vi.fn();
    render(
      <ToastProvider>
        <ShortcutProvider>
          <WideSession
            preview="Latest note"
            timelineOpen
            onTimelineOpenChange={onOpenChange}
            drawerHeight={52}
            onDrawerHeightChange={vi.fn()}
            timeline={<div>Timeline content</div>}
            composer={<ContextClipDetails clips={[clip]} />}
          />
        </ShortcutProvider>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "1 clip" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Context Clips" })).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
