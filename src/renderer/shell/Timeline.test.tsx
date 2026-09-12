/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "./Timeline";

afterEach(cleanup);

describe("Timeline empty states", () => {
  it("shows the loading state instead of the empty content while restoring", () => {
    render(
      <Timeline items={[]} loading emptyContent={<p>Send your first message.</p>} />,
    );
    expect(screen.getByTestId("timeline-loading")).toBeTruthy();
    expect(screen.queryByText("Send your first message.")).toBeNull();
  });

  it("shows the empty content once the restore settled with no items", () => {
    render(<Timeline items={[]} emptyContent={<p>Send your first message.</p>} />);
    expect(screen.queryByTestId("timeline-loading")).toBeNull();
    expect(screen.getByText("Send your first message.")).toBeTruthy();
  });
});
