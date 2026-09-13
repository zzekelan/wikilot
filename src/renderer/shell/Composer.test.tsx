/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextClip } from "../../shared/session";
import { Composer } from "./Composer";
import { pushEscapeLayer } from "../escape-stack";
import { ShortcutProvider } from "../shortcuts";
import { ToastProvider } from "../feedback";

const testClip: ContextClip = {
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
    lineStart: 8,
    lineEnd: 8,
    heading: "Plan",
  },
};

const fake = vi.hoisted(() => ({
  client: {
    prepareSession: vi.fn(),
    releaseSession: vi.fn(),
    getModelCatalog: vi.fn(),
    reloadSessionResources: vi.fn(),
    prompt: vi.fn(),
  },
}));

vi.mock("../client", () => ({ client: fake.client }));

beforeEach(() => {
  for (const mock of Object.values(fake.client)) mock.mockReset();
  fake.client.prepareSession.mockResolvedValue([
    { name: "research", description: "Investigate a question" },
  ]);
  fake.client.getModelCatalog.mockResolvedValue([]);
  fake.client.reloadSessionResources.mockResolvedValue([
    { name: "research", description: "Investigate a question" },
  ]);
  fake.client.prompt.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function composer(sessionBusy = false, beforeSend?: () => Promise<boolean>) {
  return (
    <Composer
      enabled
      sessionBusy={sessionBusy}
      workspaceId="workspace-1"
      sessionId="session-1"
      skills={[{ name: "research", description: "Investigate a question" }]}
      configuration={{ provider: "openai", model: "gpt-4.1" }}
      configurationStatus="applied"
      onConfigurationChange={vi.fn(async (patch) => ({
        status: "applied" as const,
        configuration: {
          provider: "openai",
          model: "gpt-4.1",
          ...patch,
        },
      }))}
      beforeSend={beforeSend}
    />
  );
}

function renderComposer(sessionBusy = false) {
  return render(composer(sessionBusy));
}

describe("Composer layout", () => {
  it("keeps a draft and its Clips while connecting a model and refreshing the catalog", async () => {
    const onModelAvailabilityChange = vi.fn();
    const props = {
      enabled: true, sessionBusy: false, workspaceId: "workspace-1", sessionId: "session-1",
      initialText: "Compare these notes", clips: [testClip], configuration: {},
      configurationStatus: "applied" as const, onConfigurationChange: vi.fn(), onModelAvailabilityChange,
    };
    const { rerender } = render(<Composer {...props} />);
    await waitFor(() => expect(onModelAvailabilityChange).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    await waitFor(() => expect(screen.queryByTestId("composer-model-picker")).toBeNull());
    expect(screen.queryByText("Connect a model")).toBeNull();
    expect(screen.queryByText("No models are ready to use.")).toBeNull();
    expect(fake.client.prompt).not.toHaveBeenCalled();
    fake.client.getModelCatalog.mockResolvedValue([{ id: "local", name: "Local", models: [{ id: "model", name: "Model", thinkingLevels: ["off"] }] }]);
    rerender(<Composer {...props} catalogRevision={1} />);
    await waitFor(() => expect(onModelAvailabilityChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    await screen.findByRole("option", { name: "local/model" });
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("Compare these notes");
    expect(screen.getByRole("button", { name: "1 clip" }).textContent).toContain("plan.md");
    expect(props.onConfigurationChange).not.toHaveBeenCalled();
  });
  it("starts the wide Composer as one line and preserves Prompt submission", async () => {
    render(
      <Composer
        enabled
        sessionBusy={false}
        layout="bar"
        workspaceId="workspace-1"
        sessionId="session-1"
        configuration={{ provider: "openai", model: "gpt-4.1" }}
        configurationStatus="applied"
        onConfigurationChange={vi.fn()}
      />,
    );
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;

    expect(input.rows).toBe(1);
    fireEvent.change(input, { target: { value: "wide prompt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      text: "wide prompt",
      clips: [],
    }));
  });
});

describe("Composer command menu", () => {
  it("does not send /init while an IME composition is in progress", () => {
    renderComposer();
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/init" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(fake.client.prompt).not.toHaveBeenCalled();
    expect(input.value).toBe("/init");
  });

  it.each(["Enter", "Tab", "click", "dismissed"])("sends /init as an ordinary Prompt via %s", async (gesture) => {
    const beforeSend = vi.fn(async () => true);
    render(<Composer {...composer(false, beforeSend).props} clips={[testClip]} />);
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/init" } });
    if (gesture === "click") fireEvent.click(screen.getByTestId("composer-command-init"));
    else {
      if (gesture === "dismissed") fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.keyDown(input, { key: gesture === "Tab" ? "Tab" : "Enter" });
    }
    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledOnce());
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(fake.client.prompt).toHaveBeenCalledWith({
      workspaceId: "workspace-1", sessionId: "session-1", clips: [testClip],
      text: "/init", command: "init",
    });
    await waitFor(() => expect(input.value).toBe(""));
  });

  it.each(["busy", "unprepared", "save failure", "send failure", "missing model"])("preserves /init when blocked by %s", async (reason) => {
    const beforeSend = vi.fn(async () => reason !== "save failure");
    if (reason === "send failure") fake.client.prompt.mockRejectedValueOnce(new Error("send failed"));
    render(<Composer {...composer(reason === "busy", beforeSend).props}
      sendingEnabled={reason !== "unprepared"}
      configuration={reason === "missing model" ? {} : { provider: "openai", model: "gpt-4.1" }} />);
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/init" } });
    fireEvent.keyDown(input, { key: "Enter" });
    if (reason === "save failure") await screen.findByText("Save your Markdown changes before sending.");
    if (reason === "send failure") await screen.findByText("send failed");
    if (reason === "missing model") await waitFor(() => expect(fake.client.getModelCatalog).toHaveBeenCalled());
    expect(fake.client.prompt).toHaveBeenCalledTimes(reason === "send failure" ? 1 : 0);
    expect(input.value).toBe("/init");
  });

  it("closes before an underlying Escape layer", () => {
    const closeUnderlying = vi.fn();
    function UnderlyingLayer() {
      useEffect(() => pushEscapeLayer(closeUnderlying), []);
      return null;
    }
    render(
      <ToastProvider>
        <ShortcutProvider>
          <UnderlyingLayer />
          {composer()}
        </ShortcutProvider>
      </ToastProvider>,
    );
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/model" } });
    expect(screen.getByTestId("composer-command-model")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("composer-command-model")).toBeNull();
    expect(closeUnderlying).not.toHaveBeenCalled();
  });

  it("inserts a selected Skill Invocation instead of sending it", async () => {
    renderComposer();
    const input = screen.getByTestId("composer-input");

    fireEvent.change(input, { target: { value: "/research" } });
    const command = await screen.findByTestId("composer-command-skill:research");
    fireEvent.click(command);

    expect((input as HTMLTextAreaElement).value).toBe("/skill:research ");
    expect(fake.client.prompt).not.toHaveBeenCalled();
  });

  it("does not forward an exact Slash Command after the menu is dismissed", async () => {
    renderComposer();
    const input = screen.getByTestId("composer-input");

    fireEvent.change(input, { target: { value: "/model" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fake.client.getModelCatalog).toHaveBeenCalled());
    expect(fake.client.prompt).not.toHaveBeenCalled();
  });

  it("dispatches /reload through the Session resource action while idle", async () => {
    renderComposer();
    const input = screen.getByTestId("composer-input");

    fireEvent.change(input, { target: { value: "/rel" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(fake.client.reloadSessionResources).toHaveBeenCalledWith(
        "workspace-1",
        "session-1",
      ),
    );
    expect(fake.client.prompt).not.toHaveBeenCalled();
  });

  it("shows /reload as unavailable during a Turn", async () => {
    renderComposer(true);
    const input = screen.getByTestId("composer-input");

    fireEvent.change(input, { target: { value: "/rel" } });
    expect(
      (screen.getByTestId("composer-command-reload") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLTextAreaElement).value).toBe("/rel");
    expect(fake.client.reloadSessionResources).not.toHaveBeenCalled();
  });
});

describe("Composer Prompt save gate", () => {
  it("clears a persisted message before the Turn finishes", async () => {
    fake.client.prompt.mockImplementationOnce(() => new Promise<void>(() => {}));
    const view = renderComposer();
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "sent message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledOnce());
    view.rerender(<Composer {...composer(true).props} userMessageCount={1} />);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("clears the submitted draft only once and preserves the next draft and clips", async () => {
    let finishTurn!: () => void;
    fake.client.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishTurn = resolve;
    }));
    const onClipsChange = vi.fn();
    const onTextChange = vi.fn();
    const props = { ...composer().props, onTextChange, onClipsChange };
    const view = render(<Composer {...props} clips={[testClip]} />);
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "same message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledOnce());
    const addedClip = { ...testClip, source: { kind: "markdown" as const, path: "new.md" } };
    view.rerender(<Composer {...props} clips={[testClip, addedClip]} userMessageCount={1} sessionBusy />);
    await waitFor(() => expect(input.value).toBe(""));
    expect(onTextChange).toHaveBeenLastCalledWith("");
    expect(onClipsChange).toHaveBeenLastCalledWith([addedClip]);
    fireEvent.change(input, { target: { value: "same message" } });
    finishTurn();
    view.rerender(<Composer {...props} clips={[addedClip]} userMessageCount={1} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    expect(input.value).toBe("same message");
    expect(onClipsChange).toHaveBeenCalledOnce();
  });

  it("sends a Clip-only Prompt and preserves the Clip when persistence fails", async () => {
    const clip = {
      source: { kind: "markdown" as const, path: "notes/plan.md" },
      text: "selected evidence",
      fingerprint: "fnv1a:12345678",
      locator: {
        kind: "markdown" as const,
        mode: "reading" as const,
        start: 0,
        end: 17,
        exact: "selected evidence",
        prefix: "",
        suffix: "",
      },
    };
    const onClipsChange = vi.fn();
    fake.client.prompt.mockRejectedValueOnce(new Error("Prompt record write failed"));
    render(
      <Composer
        enabled
        sessionBusy={false}
        workspaceId="workspace-1"
        sessionId="session-1"
        clips={[clip]}
        onClipsChange={onClipsChange}
        configuration={{ provider: "openai", model: "gpt-4.1" }}
        configurationStatus="applied"
        onConfigurationChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      text: "",
      clips: [clip],
    }));
    expect(await screen.findByText(/Prompt record write failed/i)).toBeTruthy();
    expect(screen.getByTestId("composer-clips")).toBeTruthy();
    expect(onClipsChange).not.toHaveBeenCalled();
  });

  it("acquires the send gate before awaiting Markdown saves", async () => {
    let resolveSave!: (saved: boolean) => void;
    const beforeSend = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveSave = resolve;
    }));
    render(composer(false, beforeSend));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "send once" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(beforeSend).toHaveBeenCalledOnce();

    resolveSave(true);
    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledOnce());
  });

  it("preserves edits made while an earlier Prompt is persisting", async () => {
    let resolvePrompt!: () => void;
    fake.client.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    }));
    const view = renderComposer();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "first draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(input, { target: { value: "new unsent work" } });

    view.rerender(<Composer {...composer(true).props} userMessageCount={1} />);
    expect((input as HTMLTextAreaElement).value).toBe("new unsent work");

    resolvePrompt();
    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledOnce());
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("new unsent work"));
  });

  it("removes persisted clips while preserving clips added during submission", async () => {
    let resolvePrompt!: () => void;
    fake.client.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    }));
    const onClipsChange = vi.fn();
    const props = {
      enabled: true,
      sessionBusy: false,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      onClipsChange,
      configuration: { provider: "openai", model: "gpt-4.1" },
      configurationStatus: "applied" as const,
      onConfigurationChange: vi.fn(),
    };
    const view = render(<Composer {...props} clips={[testClip]} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const addedClip: ContextClip = {
      ...testClip,
      source: { kind: "markdown", path: "notes/new.md" },
    };
    view.rerender(<Composer {...props} clips={[testClip, addedClip]} />);

    resolvePrompt();
    await waitFor(() => expect(onClipsChange).toHaveBeenLastCalledWith([addedClip]));
  });

  it("does not send until dirty Markdown documents save successfully", async () => {
    const beforeSend = vi.fn(async () => false);
    render(composer(false, beforeSend));
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "inspect the file" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(beforeSend).toHaveBeenCalledOnce());
    expect(fake.client.prompt).not.toHaveBeenCalled();
    expect(screen.getByText(/save your markdown changes/i)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("inspect the file");
  });
});

describe("Composer Clip details", () => {
  it("summarizes a PDF Clip with its Workspace path and page range", () => {
    const pdfClip: ContextClip = {
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "first\nsecond",
      fingerprint: "pdf:fingerprint",
      locator: {
        kind: "pdf",
        spans: [
          { page: 4, start: 0, end: 5, exact: "first", prefix: "", suffix: "", boxes: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }] },
          { page: 5, start: 0, end: 6, exact: "second", prefix: "", suffix: "", boxes: [{ left: 0.1, top: 0.1, width: 0.3, height: 0.04 }] },
        ],
      },
    };
    render(
      <Composer
        enabled
        sessionBusy={false}
        workspaceId="workspace-1"
        sessionId="session-1"
        clips={[pdfClip]}
        configuration={{ provider: "openai", model: "gpt-4.1" }}
        configurationStatus="applied"
        onConfigurationChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "1 clip" }));
    expect(screen.getByText("references/paper.pdf")).toBeTruthy();
    expect(screen.getByText("pages 4-5")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open clip 1 source/i }).querySelector(".lucide-file"))
      .toBeTruthy();
  });

  it("navigates from a draft Clip and allows removal", () => {
    const clip = testClip;
    const onClipsChange = vi.fn();
    const onClipNavigate = vi.fn();
    render(
      <Composer
        enabled
        sessionBusy={false}
        workspaceId="workspace-1"
        sessionId="session-1"
        clips={[clip]}
        onClipsChange={onClipsChange}
        onClipNavigate={onClipNavigate}
        configuration={{ provider: "openai", model: "gpt-4.1" }}
        configurationStatus="applied"
        onConfigurationChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "1 clip" });
    expect(trigger.compareDocumentPosition(screen.getByTestId("composer-input")))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const clipDetails = trigger.parentElement!;
    vi.spyOn(clipDetails, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 60,
      top: 60,
      right: 80,
      bottom: 80,
      left: 20,
      width: 60,
      height: 20,
      toJSON: () => ({}),
    });
    vi.spyOn(trigger.closest(".composer-card")!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 40,
      top: 40,
      right: 320,
      bottom: 120,
      left: 0,
      width: 320,
      height: 80,
      toJSON: () => ({}),
    });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    fireEvent.click(trigger);
    const popover = screen.getByRole("dialog", { name: "Context Clips" });
    expect(popover.parentElement).toBe(trigger.parentElement);
    expect(popover.classList.contains("context-clip-popover-above")).toBe(true);
    expect(parseFloat(popover.style.maxHeight)).toBeLessThanOrEqual(52);
    expect(popover.style.bottom).not.toBe("");
    expect(screen.getByText(/Plan.*lines 8.*reading/i)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /open clip 1 source/i }));
    expect(onClipNavigate).toHaveBeenCalledWith(clip);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /remove clip 1/i }));
    expect(onClipsChange).toHaveBeenCalledWith([]);
  });

  it("does not add a pulse class to the Composer or Clip capsule", () => {
    const props = {
      enabled: true,
      sessionBusy: false,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      clips: [testClip],
      configuration: { provider: "openai", model: "gpt-4.1" },
      configurationStatus: "applied" as const,
      onConfigurationChange: vi.fn(),
    };
    render(<Composer {...props} />);

    expect(screen.getByRole("button", { name: "1 clip" }).className)
      .not.toContain("pulse");
    expect(screen.getByLabelText("Composer").firstElementChild?.className)
      .not.toContain("pulse");
  });
});

describe("Composer pickers", () => {
  it.each(["model", "thinking"])("keeps /%s selection in the command drawer above the input", async (command) => {
    fake.client.getModelCatalog.mockResolvedValue([{
      id: "openai", name: "OpenAI", models: [{
        id: "gpt-4.1", name: "GPT-4.1", thinkingLevels: ["off", "medium", "high"],
      }],
    }]);
    renderComposer();
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: `/${command}` } });
    fireEvent.keyDown(input, { key: "Enter" });
    const option = await screen.findByTestId(command === "model" ? "composer-model-option" : "composer-thinking-option-high");
    const drawer = option.closest(".composer-command-menu")!;
    expect(drawer).not.toBeNull();
    expect(drawer.parentElement).toBe(input.parentElement);
    expect(drawer.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("composer-model-chip").getAttribute("aria-expanded")).toBe("false");
    if (command === "model") {
      fireEvent.mouseDown(option);
      fireEvent.click(option);
      expect(screen.queryByTestId("composer-model-picker")).toBeNull();
      expect(screen.getByTestId("composer-thinking-picker").closest(".composer-command-menu")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Back to Models" }));
      expect(screen.getByTestId("composer-model-picker")).toBeTruthy();
    } else {
      expect(screen.queryByTestId("composer-model-picker")).toBeNull();
    }
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("composer-model-picker")).toBeNull();
    expect(screen.queryByTestId("composer-thinking-picker")).toBeNull();
    expect(fake.client.prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    expect((await screen.findByTestId("composer-model-picker")).closest(".composer-model-control")).not.toBeNull();
  });

  it("keeps the Wiki toggle out of the Composer status strip", () => {
    renderComposer();

    expect(screen.queryByTestId("composer-wiki-toggle")).toBeNull();
  });

  it("selects only an available Effort level from the keyboard", async () => {
    fake.client.getModelCatalog.mockResolvedValue([
      {
        id: "openai",
        name: "OpenAI",
        models: [{
          id: "gpt-4.1",
          name: "GPT-4.1",
          thinkingLevels: ["off", "medium", "high"],
        }],
      },
    ]);
    const onConfigurationChange = vi.fn(async (patch: object) => ({
      status: "applied" as const,
      configuration: { provider: "openai", model: "gpt-4.1", ...patch },
    }));
    render(
      <Composer
        enabled
        sessionBusy={false}
        workspaceId="workspace-1"
        sessionId="session-1"
        configuration={{
          provider: "openai",
          model: "gpt-4.1",
          thinkingLevel: "medium",
        }}
        configurationStatus="applied"
        onConfigurationChange={onConfigurationChange}
      />,
    );

    fireEvent.click(screen.getByTestId("composer-model-chip"));
    const input = screen.getByTestId("composer-input");
    await screen.findByTestId("composer-model-option");
    // Enter chooses the highlighted Model and drills into its Effort levels.
    fireEvent.keyDown(input, { key: "Enter" });
    // Only this exact Provider/Model's advertised Effort levels are rendered.
    expect(screen.queryByTestId("composer-thinking-option-low")).toBeNull();
    expect(screen.queryByTestId("composer-thinking-option-max")).toBeNull();
    // The cursor opens on the applied level (medium); one step down is high.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onConfigurationChange).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "high",
      }),
    );
    expect(screen.queryByTestId("composer-thinking-picker")).toBeNull();
  });

  it("opens the Model list directly without a chevron on the chip", async () => {
    renderComposer();
    const chip = screen.getByTestId("composer-model-chip");

    expect(chip.querySelector(".composer-chip-chevron")).toBeNull();
    fireEvent.click(chip);

    expect(await screen.findByTestId("composer-model-picker")).toBeTruthy();
    expect(screen.queryByTestId("composer-tuning-menu")).toBeNull();
  });

  it("shows canonical Model ids in the picker and the friendly name in the chip", async () => {
    fake.client.getModelCatalog.mockResolvedValue([
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [{
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          thinkingLevels: ["off"],
        }],
      },
    ]);
    render(
      <Composer
        enabled
        sessionBusy={false}
        workspaceId="workspace-1"
        sessionId="session-1"
        configuration={{ provider: "deepseek", model: "deepseek-v4-flash" }}
        configurationStatus="applied"
        onConfigurationChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("composer-model-chip"));
    const option = await screen.findByTestId("composer-model-option");

    expect(option.textContent).toBe("deepseek/deepseek-v4-flash");
    expect(option.textContent).not.toContain("DeepSeek V4 Flash");
    expect(screen.getByTestId("composer-model-chip").textContent).toBe(
      "DeepSeek V4 Flash· Off",
    );
  });

  it("closes Effort when the same Model is clicked again", async () => {
    fake.client.getModelCatalog.mockResolvedValue([
      {
        id: "openai",
        name: "OpenAI",
        models: [
          {
            id: "gpt-4.1",
            name: "GPT-4.1",
            thinkingLevels: ["off", "medium", "high"],
          },
          {
            id: "gpt-4.2",
            name: "GPT-4.2",
            thinkingLevels: ["off", "high"],
          },
        ],
      },
    ]);
    renderComposer();
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    const models = await screen.findAllByTestId("composer-model-option");
    const model = models[1];
    expect(model).toBeTruthy();

    fireEvent.click(model!);
    expect(screen.getByTestId("composer-thinking-picker")).toBeTruthy();
    fireEvent.click(model!);

    expect(screen.queryByTestId("composer-thinking-picker")).toBeNull();
    expect(screen.getByTestId("composer-model-picker")).toBeTruthy();
    expect(models[0]?.classList.contains("composer-picker-option-active")).toBe(false);
    expect(model?.classList.contains("composer-picker-option-active")).toBe(true);
  });

  it("closes Model and Effort when clicking outside the picker", async () => {
    fake.client.getModelCatalog.mockResolvedValue([
      {
        id: "openai",
        name: "OpenAI",
        models: [{
          id: "gpt-4.1",
          name: "GPT-4.1",
          thinkingLevels: ["off", "medium", "high"],
        }],
      },
    ]);
    renderComposer();
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    fireEvent.click(await screen.findByTestId("composer-model-option"));
    expect(screen.getByTestId("composer-thinking-picker")).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId("composer-model-picker")).toBeNull();
    expect(screen.queryByTestId("composer-thinking-picker")).toBeNull();
  });

  it("never sends the draft on Enter while a picker is open", async () => {
    fake.client.getModelCatalog.mockResolvedValue([
      {
        id: "openai",
        name: "OpenAI",
        models: [{
          id: "gpt-4.1",
          name: "GPT-4.1",
          thinkingLevels: ["off", "medium", "high"],
        }],
      },
    ]);
    renderComposer();
    const input = screen.getByTestId("composer-input");

    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("composer-model-chip"));
    await screen.findByTestId("composer-model-option");
    // Enter on the Model list drills into Effort instead of sending.
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("composer-thinking-picker")).toBeTruthy(),
    );
    expect(screen.getByTestId("composer-model-picker")).toBeTruthy();
    expect(fake.client.prompt).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("hello");
  });
});
