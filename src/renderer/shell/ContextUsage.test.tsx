// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextUsage } from "./ContextUsage";
import { closeTopEscapeLayer, pushEscapeLayer } from "../escape-stack";

afterEach(cleanup);
const context = { status: "ready" as const, provider: "p", model: "m", contextWindow: 128000, usedTokens: 38400 };

describe("Context ring", () => {
  it("shows only an arc, with numeric details available on focus", () => {
    render(<ContextUsage context={context} loading={false} />);
    const ring = screen.getByRole("button", { name: "Context: ~70% left" });
    expect(ring.textContent).toBe("");
    expect(ring.querySelector(".context-usage-fill")?.getAttribute("stroke-dasharray")).toBe("30 100");
    fireEvent.focus(ring);
    expect(screen.getByText("~38,400 tokens")).toBeTruthy();
    act(() => { closeTopEscapeLayer(); });
    expect(ring.parentElement?.hasAttribute("data-open")).toBe(false);
  });

  it("dismisses a hovered tooltip before an older Escape layer without stealing focus", () => {
    const older = vi.fn();
    const pop = pushEscapeLayer(older);
    try {
      render(<><textarea aria-label="Draft" /><ContextUsage context={context} loading={false} /></>);
      const draft = screen.getByRole("textbox");
      draft.focus();
      const ring = screen.getByRole("button");
      fireEvent.mouseEnter(ring.parentElement!);
      expect(ring.parentElement?.hasAttribute("data-open")).toBe(true);
      act(() => { closeTopEscapeLayer(); });
      expect(older).not.toHaveBeenCalled();
      expect(ring.parentElement?.hasAttribute("data-open")).toBe(false);
      expect(document.activeElement).toBe(draft);
      act(() => { closeTopEscapeLayer(); });
      expect(older).toHaveBeenCalledOnce();
    } finally { pop(); }
  });

  it("distinguishes unknown from zero and clamps only the over-capacity arc", () => {
    const view = render(<ContextUsage context={{ ...context, usedTokens: null }} loading={false} />);
    expect(screen.getByRole("button", { name: "Context: Pending" }).querySelector(".context-usage-unknown")).toBeTruthy();
    view.rerender(<ContextUsage context={{ ...context, usedTokens: 0 }} loading={false} />);
    expect(screen.getByRole("button", { name: "Context: ~100% left" }).querySelector(".context-usage-unknown")).toBeNull();
    view.rerender(<ContextUsage context={{ ...context, usedTokens: 140000 }} loading={false} />);
    expect(screen.getByRole("button", { name: "Context: ~0% left" }).querySelector(".context-usage-fill")?.getAttribute("stroke-dasharray")).toBe("100 100");
    expect(screen.getByText("~140,000 tokens")).toBeTruthy();
    expect(screen.getByText("~12,000 tokens")).toBeTruthy();
  });

  it("uses state labels during loading, compaction and unavailability", () => {
    const view = render(<ContextUsage context={context} loading />);
    expect(screen.getByRole("button", { name: "Context: Loading…" })).toBeTruthy();
    view.rerender(<ContextUsage context={{ ...context, status: "compacting" }} loading={false} />);
    expect(screen.getByRole("button", { name: "Context: Compacting…" })).toBeTruthy();
    view.rerender(<ContextUsage context={{ status: "unavailable" }} loading={false} />);
    expect(screen.getByRole("button", { name: "Context: Unavailable" })).toBeTruthy();
    expect(screen.queryByText("128,000 tokens")).toBeNull();
  });
});
