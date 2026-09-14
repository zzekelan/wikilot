/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageView } from "./MessageView";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Timeline Context Clip summary", () => {
  it("renders a Prompt command and additional text together inside a bubble", () => {
    render(<MessageView item={{ kind: "user", text: "/init Use Chinese", command: "init", at: 1 }} sessionBusy={false} isLast />);
    expect(screen.getByTestId("prompt-command-badge").textContent).toBe("Initialize Workspace");
    expect(screen.getByTestId("prompt-command-badge").closest(".msg-user-bubble")?.textContent).toBe("Initialize WorkspaceUse Chinese");
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it("copies only the completed answer and reports clipboard failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const props = {
      item: { kind: "assistant" as const, at: 1, parts: [
        { kind: "reasoning" as const, text: "private reasoning", at: 1 },
        { kind: "text" as const, text: "Final answer\n\n```ts\nconst a = 1;\n```", at: 2 },
      ] },
      sessionBusy: true, isLast: true,
    };
    const { rerender } = render(<MessageView {...props} />);
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    rerender(<MessageView {...props} sessionBusy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith(props.item.parts[1]!.text);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Could not copy. Try again." })).toBeTruthy());
  });
  it("folds each completed turn, then absorbs the final reasoning after its collapse", () => {
    vi.useFakeTimers();
    const firstTurn = [
      { kind: "reasoning" as const, text: "first thought", at: 1000, endedAt: 2000 },
      {
        kind: "tool" as const,
        toolCallId: "call-1",
        toolName: "bash",
        status: "done" as const,
        at: 2000,
        endedAt: 3000,
      },
    ];
    const finalReasoning = {
      kind: "reasoning" as const,
      text: "second thought",
      at: 3000,
      endedAt: 4000,
    };
    const { rerender } = render(
      <MessageView
        item={{
          kind: "assistant",
          at: 1000,
          parts: [...firstTurn, finalReasoning],
        }}
        sessionBusy
        isLast
      />,
    );

    act(() => vi.advanceTimersByTime(2000));
    let assistant = screen.getByTestId("timeline-assistant");
    expect(assistant.querySelectorAll(":scope > :not(.msg-assistant-copy)").length).toBe(2);
    expect(
      assistant.children[0]?.querySelector(":scope > .activity-row")?.textContent,
    ).toContain("Ran 2.0s · used Bash");
    expect(screen.getByText("second thought")).toBeTruthy();

    rerender(
      <MessageView
        item={{
          kind: "assistant",
          at: 1000,
          parts: [
            ...firstTurn,
            finalReasoning,
            { kind: "text", text: "final answer", at: 4000 },
          ],
        }}
        sessionBusy={false}
        isLast
      />,
    );

    assistant = screen.getByTestId("timeline-assistant");
    expect(assistant.querySelectorAll(":scope > :not(.msg-assistant-copy)").length).toBe(3);
    const priorSummary = assistant.children[0];
    expect(screen.getByText("second thought")).toBeTruthy();
    expect(screen.getByText("final answer")).toBeTruthy();

    act(() => vi.advanceTimersByTime(1000));
    assistant = screen.getByTestId("timeline-assistant");
    expect(assistant.querySelectorAll(":scope > :not(.msg-assistant-copy)").length).toBe(3);
    expect(
      assistant.querySelector(":scope > .reasoning > .collapsible-open"),
    ).toBeNull();

    act(() => vi.advanceTimersByTime(200));
    assistant = screen.getByTestId("timeline-assistant");
    expect(assistant.querySelectorAll(":scope > :not(.msg-assistant-copy)").length).toBe(2);
    expect(assistant.children[0]).not.toBe(priorSummary);
    expect(
      assistant.children[0]?.querySelector(":scope > .activity-row")?.textContent,
    ).toContain("Ran 3.0s · used Bash");
    expect(assistant.querySelector(":scope > .reasoning")).toBeNull();

    const finalSummary = assistant.children[0] as HTMLElement;
    fireEvent.click(finalSummary.querySelector(":scope > .activity-row")!);
    const finalSummaryChildren = finalSummary.querySelector(
      ":scope > .collapsible > .collapsible-inner > .activity-children",
    )!;
    expect(finalSummaryChildren.children.length).toBe(2);
    expect(
      finalSummaryChildren.children[0]?.querySelector(":scope > .activity-row")?.textContent,
    ).toContain("Ran 2.0s · used Bash");
    expect(finalSummaryChildren.children[1]?.classList.contains("reasoning")).toBe(true);
  });

  it("keeps three completed turns as siblings before and inside the final summary", () => {
    vi.useFakeTimers();
    const turns = [0, 1, 2].flatMap((index) => [
      { kind: "reasoning" as const, text: `thought ${index}`, at: index * 2000, endedAt: index * 2000 + 1000 },
      { kind: "tool" as const, toolCallId: `call-${index}`, toolName: "bash", status: "done" as const, at: index * 2000 + 1000, endedAt: index * 2000 + 2000 },
    ]);
    const parts = [...turns, { kind: "reasoning" as const, text: "final thought", at: 6000, endedAt: 7000 }];
    const { rerender } = render(<MessageView item={{ kind: "assistant", at: 0, parts }} sessionBusy isLast />);
    act(() => vi.advanceTimersByTime(2000));
    const assistant = screen.getByTestId("timeline-assistant");
    expect(assistant.children).toHaveLength(4);
    expect(assistant.querySelectorAll(":scope > div > .activity-row-completed")).toHaveLength(3);
    rerender(<MessageView item={{ kind: "assistant", at: 0, parts: [...parts, { kind: "text", text: "answer", at: 7000 }] }} sessionBusy isLast />);
    act(() => vi.advanceTimersByTime(1200));
    expect(assistant.children).toHaveLength(2);
    fireEvent.click(assistant.querySelector(":scope > div > .activity-row-completed")!);
    const children = assistant.querySelector(".activity-children")!;
    expect(children.children).toHaveLength(4);
    expect(children.querySelectorAll(":scope > div > .activity-row-completed")).toHaveLength(3);
    for (const turn of Array.from(children.children).slice(0, 3)) {
      expect(turn.querySelectorAll(".activity-row-completed")).toHaveLength(1);
      expect(turn.textContent).toContain("Ran 2.0s · used Bash");
    }
  });

  it("folds the previous round even when the next reasoning reaches a tool within two seconds", () => {
    vi.useFakeTimers();
    const firstRound = [
      { kind: "reasoning" as const, text: "first thought", at: 1000, endedAt: 2000 },
      { kind: "tool" as const, toolCallId: "first", toolName: "web_search", status: "done" as const, at: 2000, endedAt: 3000 },
    ];
    const nextReasoning = { kind: "reasoning" as const, text: "next thought", at: 3000 };
    const { rerender } = render(<MessageView item={{ kind: "assistant", at: 1000, parts: [...firstRound, nextReasoning] }} sessionBusy isLast />);
    act(() => vi.advanceTimersByTime(100));
    rerender(<MessageView item={{ kind: "assistant", at: 1000, parts: [
      ...firstRound,
      { ...nextReasoning, endedAt: 3100 },
      { kind: "tool", toolCallId: "second", toolName: "web_search", status: "running", at: 3100 },
    ] }} sessionBusy isLast />);
    act(() => vi.advanceTimersByTime(2000));
    const assistant = screen.getByTestId("timeline-assistant");
    const summaries = assistant.querySelectorAll(":scope > div > .activity-row-completed");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].textContent).toContain("Ran 2.0s · used WebSearch");
    expect(summaries[0].getAttribute("aria-expanded")).toBe("false");
    expect(assistant.querySelector(":scope > [data-testid=timeline-tool]")?.textContent).toContain("WebSearch");
  });

  it("renders restored final activity already folded", () => {
    render(
      <MessageView
        item={{
          kind: "assistant",
          at: 1000,
          parts: [
            { kind: "reasoning", text: "restored thought", at: 1000, endedAt: 2000 },
            { kind: "text", text: "restored answer", at: 2000 },
          ],
        }}
        sessionBusy={false}
        isLast
      />,
    );

    const assistant = screen.getByTestId("timeline-assistant");
    expect(assistant.querySelectorAll(":scope > :not(.msg-assistant-copy)").length).toBe(2);
    expect(
      assistant.children[0]?.querySelector(":scope > .activity-row")?.textContent,
    ).toContain("Thought for 1.0s");
    expect(screen.getByText("restored answer")).toBeTruthy();
  });

  it("lazy-loads completed tool images only after expansion and offers Retry", () => {
    const imageUrl = (imageRef: string) => `/api/session/image?imageRef=${imageRef}`;
    render(
      <MessageView
        item={{
          kind: "assistant",
          at: 1000,
          parts: [{
            kind: "tool",
            toolCallId: "call-1",
            toolName: "read_pdf_page",
            status: "done",
            at: 1000,
            endedAt: 1100,
            result: {
              text: "Rendered page",
              images: [{ imageRef: "timeline-image:v1:rabBA-7V04eeYNcAg_q9df8KEVtsxfdVK0RVh74qFUg", mimeType: "image/png" }],
              metadata: { kind: "pdf_pages", path: "docs/file.pdf", pageCount: 8, pages: [{ page: 2, width: 1224, height: 1584 }], },
            },
          }],
        }}
        sessionBusy={false}
        isLast
        toolImageUrl={imageUrl}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByTestId("timeline-tool").querySelector("button")!);
    const image = screen.getByTestId("timeline-tool").querySelector("img")!;
    expect(image.getAttribute("src")).toContain("timeline-image:v1");
    expect(screen.getByText("docs/file.pdf")).toBeTruthy();
    fireEvent.error(image);
    expect(screen.getByText("Preview unavailable")).toBeTruthy();
    const retry = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retry);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.getByTestId("timeline-tool").querySelector("img")).toBeTruthy();
  });

  it("renders clean restored user text and a read-only Clip summary", () => {
    render(
      <MessageView
        item={{
          kind: "user",
          text: "clean instruction",
          at: 1000,
          clips: [{
            source: { kind: "markdown", path: "notes/history.md" },
            text: "historical evidence",
            fingerprint: "fnv1a:history",
            locator: {
              kind: "markdown",
              mode: "reading",
              start: 0,
              end: 19,
              exact: "historical evidence",
              prefix: "",
              suffix: "",
            },
          }],
        }}
        sessionBusy={false}
        isLast
      />,
    );

    const message = screen.getByText("clean instruction").closest(".msg-user-bubble")!;
    const clips = screen.getByTestId("timeline-clips");
    expect(clips.compareDocumentPosition(message)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    fireEvent.click(screen.getByText("1 clip"));
    expect(screen.getByText("notes/history.md")).toBeTruthy();
    expect(screen.getByText("historical evidence")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /remove clip/i })).toBeNull();
    expect(screen.getByRole("button", { name: /open clip 1 source/i })).toBeTruthy();
  });

  it("does not render an empty bubble for a Clip-only user message", () => {
    render(
      <MessageView
        item={{
          kind: "user",
          text: "",
          at: 1000,
          clips: [{
            source: { kind: "markdown", path: "notes/history.md" },
            text: "historical evidence",
            fingerprint: "fnv1a:history",
            locator: {
              kind: "markdown",
              mode: "reading",
              start: 0,
              end: 19,
              exact: "historical evidence",
              prefix: "",
              suffix: "",
            },
          }],
        }}
        sessionBusy={false}
        isLast
      />,
    );

    expect(screen.getByRole("button", { name: "1 clip" })).toBeTruthy();
    expect(screen.getByTestId("timeline-user").querySelector(".msg-user-bubble")).toBeNull();
  });
});
