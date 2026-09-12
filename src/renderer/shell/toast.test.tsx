/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../feedback";

function Trigger({ message }: { message: string }) {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast(message)}>
      Show
    </button>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("shows a toast and dismisses it automatically", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger message="Session deleted" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Show").click();
    });
    expect(screen.getByTestId("toast").textContent).toBe("Session deleted");
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});
