import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { ArrowLeft, ArrowUp, BookOpen, Brain, Check, ChevronRight, Cpu, RefreshCw, Square, Zap, type LucideIcon } from "lucide-react";
import { normalizeStructuredPrompt, sameContextClip, type ContextClip, type PromptCommandId } from "../../shared/session";
import {
  type ModelCatalogProvider,
  type ThinkingLevel,
} from "../../shared/settings";
import type {
  ProjectTrustRequest,
  SessionConfiguration,
  SessionConfigurationUpdate,
  SessionConfigurationUpdateResult,
  SessionSkill,
} from "../../shared/workspace";
import { client } from "../client";
import { ContextClipDetails } from "./ContextClipDetails";
import { ContextUsage } from "./ContextUsage";
import { AccessModePicker } from "./AccessModePicker";
import type { SessionContextState } from "../../shared/timeline";
import { pushEscapeLayer } from "../escape-stack";
import {
  composerCommandQuery,
  filterComposerCommands,
  type ComposerCommand,
  type ComposerCommandId,
} from "./composer-commands";
import { thinkingLevelLabel } from "./thinking-labels";
import type { PendingPrompt } from "./PromptCommandBadge";
import "./Composer.css";

type ComposerProps = {
  enabled: boolean;
  sendingEnabled?: boolean;
  sessionBusy: boolean;
  context?: SessionContextState;
  contextLoading?: boolean;
  /** Persisted user messages in the selected Session's Timeline. */
  userMessageCount?: number;
  /** Wide Workspace uses the compact prototype bar without changing behavior. */
  layout?: "card" | "bar";
  workspaceId?: string;
  sessionId?: string;
  /** Restored draft text (the shell keeps one draft per Session). */
  initialText?: string;
  /** Reports draft edits so a Session switch never loses an unsent message. */
  onTextChange?: (text: string) => void;
  clips?: readonly ContextClip[];
  onClipsChange?: (clips: ContextClip[]) => void;
  onClipNavigate?: (clip: ContextClip) => void;
  /** Effective or pending configuration for the Selected Session. */
  configuration: SessionConfiguration;
  configurationStatus: "applied" | "pending";
  /** One Session action shared by the chip, controls, and Slash Commands. */
  onConfigurationChange: (
    patch: SessionConfigurationUpdate,
  ) => Promise<SessionConfigurationUpdateResult>;
  /** Placeholder while disabled; names the actual missing setup step. */
  disabledPlaceholder?: string;
  /** Called after an abort request succeeds; the shell shows "Run cancelled". */
  onCancelled?: () => void;
  /** Echoes the in-flight Prompt so the Timeline can show a pending placeholder. */
  onPendingChange?: (prompt: PendingPrompt | null) => void;
  onTrustRequired?: (request: ProjectTrustRequest) => Promise<void>;
  /** Skill metadata returned by the selected Session preparation. */
  skills?: readonly SessionSkill[];
  onSkillsChange?: (skills: SessionSkill[]) => void;
  /** Required disk sync before a Prompt may observe Workspace files. */
  beforeSend?: () => Promise<boolean>;
  onModelAvailabilityChange?: (available: boolean) => void;
  catalogRevision?: number;
};

type ModelOption = {
  provider: string;
  providerName: string;
  model: string;
  modelName: string;
  thinkingLevels: ThinkingLevel[];
};

function flattenModelCatalog(catalog: ModelCatalogProvider[]): ModelOption[] {
  return catalog.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      providerName: provider.name,
      model: model.id,
      modelName: model.name,
      thinkingLevels: model.thinkingLevels,
    })),
  );
}

function modelLabel(configuration: SessionConfiguration): string {
  if (!configuration.provider || !configuration.model) return "Choose a Model";
  return `${configuration.provider}/${configuration.model}`;
}

function modelDisplayLabel(
  configuration: SessionConfiguration,
  options: readonly ModelOption[],
): string {
  if (!configuration.provider || !configuration.model) return "Choose a Model";
  return options.find(
    (option) =>
      option.provider === configuration.provider &&
      option.model === configuration.model,
  )?.modelName ?? configuration.model;
}

type ComposerPickerView = "model" | "thinking";
type ComposerPickerOrigin = "status" | "model-command" | "thinking-command";

const EMPTY_SKILLS: readonly SessionSkill[] = [];

/** Actions get their own mark; agent instructions share one mark. */
const COMMAND_ICONS: Record<ComposerCommandId, LucideIcon> = {
  model: Cpu,
  thinking: Brain,
  wiki: BookOpen,
  reload: RefreshCw,
};

function commandIcon(command: ComposerCommand): LucideIcon {
  return command.kind === "action" ? COMMAND_ICONS[command.id] : Zap;
}

/** Keyboard cursor inside a listbox follows this hook's scroll-into-view. */
function scrollOptionIntoView(
  container: HTMLElement | null,
  index: number,
): void {
  // jsdom lacks scrollIntoView; the optional call keeps unit tests lean.
  container
    ?.querySelectorAll<HTMLElement>(".composer-command-option, .composer-picker-option")
    [index]?.scrollIntoView?.({ block: "nearest" });
}

export function Composer({
  enabled,
  sendingEnabled = true,
  sessionBusy,
  context = { status: "unavailable" },
  contextLoading = false,
  userMessageCount = 0,
  layout = "card",
  workspaceId,
  sessionId,
  initialText,
  onTextChange,
  clips: contextClips = [],
  onClipsChange,
  onClipNavigate,
  configuration,
  configurationStatus,
  onConfigurationChange,
  disabledPlaceholder,
  onCancelled,
  onPendingChange,
  onTrustRequired,
  skills: preparedSkills = EMPTY_SKILLS,
  onSkillsChange,
  beforeSend,
  onModelAvailabilityChange,
  catalogRevision = 0,
}: ComposerProps) {
  const [text, setTextState] = useState(initialText ?? "");
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerOrigin, setPickerOrigin] = useState<ComposerPickerOrigin>("status");
  const commandPicker = pickerOrigin !== "status";
  const [pickerView, setPickerView] = useState<ComposerPickerView>("model");
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [effortPickerStyle, setEffortPickerStyle] = useState<CSSProperties>();
  const [activeModelIndex, setActiveModelIndex] = useState(0);
  const [activeThinkingIndex, setActiveThinkingIndex] = useState(0);
  const [catalog, setCatalog] = useState<ModelCatalogProvider[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [skills, setSkills] = useState<SessionSkill[]>(() => [
    ...preparedSkills,
  ]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const commandMenuRef = useRef<HTMLDivElement | null>(null);
  const modelControlRef = useRef<HTMLDivElement | null>(null);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const sendingRef = useRef(false);
  const submittedDraftRef = useRef<{ messageCount: number; clear: () => void } | null>(null);
  const textRef = useRef(text);
  const clipsRef = useRef(contextClips);
  textRef.current = text;
  clipsRef.current = contextClips;

  useEffect(() => {
    const submitted = submittedDraftRef.current;
    if (submitted && userMessageCount > submitted.messageCount) submitted.clear();
  }, [userMessageCount]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (layout !== "bar") {
      input.style.height = "";
      return;
    }
    input.style.height = "0";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [layout, text]);

  function setText(next: string) {
    setTextState(next);
    onTextChange?.(next);
  }

  const commandQuery = composerCommandQuery(text);
  const commandMatches = useMemo(
    () =>
      commandQuery === null ? [] : filterComposerCommands(commandQuery, skills),
    [commandQuery, skills],
  );
  const commandMenuOpen =
    !menuDismissed &&
    commandQuery !== null &&
    commandMatches.length > 0 &&
    !pickerOpen;
  const modelOptions = useMemo(() => flattenModelCatalog(catalog), [catalog]);
  const selectedModelLabel = modelLabel(configuration);
  const selectedModelDisplayLabel = modelDisplayLabel(configuration, modelOptions);
  const thinkingLevel = configuration.thinkingLevel ?? "off";
  const modelSignature = JSON.stringify([configuration.provider, configuration.model, thinkingLevel]);
  const appliedModel = useRef<{ sessionId: string | undefined; signature: string } | null>(null);
  const modelPending = configurationStatus === "pending" &&
    (appliedModel.current?.sessionId !== sessionId || appliedModel.current?.signature !== modelSignature);
  useEffect(() => {
    if (configurationStatus !== "pending") appliedModel.current = { sessionId, signature: modelSignature };
  }, [configurationStatus, modelSignature, sessionId]);
  const effortOptions = useMemo(
    () =>
      (pendingModel ??
        modelOptions.find(
          (option) =>
            option.provider === configuration.provider &&
            option.model === configuration.model,
        ))?.thinkingLevels ?? [],
    [configuration.model, configuration.provider, modelOptions, pendingModel],
  );
  const wikiEnabled = configuration.wikiPromptEnabled ?? true;

  useEffect(() => {
    if (enabled && workspaceId && sessionId) void refreshCatalog();
    // Settings closure refreshes the catalog without replacing the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogRevision, enabled, workspaceId, sessionId]);

  useEffect(() => {
    if (!commandMenuOpen) return;
    setActiveCommandIndex((index) =>
      Math.min(index, Math.max(0, commandMatches.length - 1)),
    );
  }, [commandMatches.length, commandMenuOpen]);

  // The keyboard cursor stays visible while navigating long menus.
  useEffect(() => {
    if (!commandMenuOpen) return;
    scrollOptionIntoView(commandMenuRef.current, activeCommandIndex);
  }, [activeCommandIndex, commandMenuOpen]);

  // Opening the Model section lands the cursor on the applied Model.
  useEffect(() => {
    if (!pickerOpen || pickerView !== "model" || catalogLoading) return;
    const index = modelOptions.findIndex(
      (option) =>
        option.provider === configuration.provider &&
        option.model === configuration.model,
    );
    setActiveModelIndex(index >= 0 ? index : 0);
  }, [catalogLoading, configuration.model, configuration.provider, modelOptions, pickerOpen]);

  useEffect(() => {
    if (!pickerOpen || pickerView !== "model") return;
    scrollOptionIntoView(modelPickerRef.current, activeModelIndex);
  }, [activeModelIndex, pickerOpen, pickerView]);

  useEffect(() => {
    if (!pickerOpen || pickerView !== "thinking") return;
    scrollOptionIntoView(pickerRef.current, activeThinkingIndex);
  }, [activeThinkingIndex, pickerOpen, pickerView]);

  useLayoutEffect(() => {
    if (!pickerOpen || commandPicker || pickerView !== "thinking" || !pendingModel) return;
    const modelPicker = modelPickerRef.current;
    const effortPicker = pickerRef.current;
    const modelIndex = modelOptions.findIndex(
      (option) => option.provider === pendingModel.provider && option.model === pendingModel.model,
    );
    const modelRow = modelPicker?.querySelectorAll<HTMLElement>("[data-testid='composer-model-option']")[modelIndex];
    if (!modelPicker || !modelRow || !effortPicker) return;

    const place = () => {
      const modelPickerRect = modelPicker.getBoundingClientRect();
      const modelRowRect = modelRow.getBoundingClientRect();
      const effortRect = effortPicker.getBoundingClientRect();
      const opensDown = modelRowRect.top + effortRect.height <= window.innerHeight - 8;
      const top = Math.max(
        8,
        opensDown ? modelRowRect.top : modelRowRect.bottom - effortRect.height,
      );
      const desiredLeft = modelPickerRect.right + 8;
      const left = desiredLeft + effortRect.width <= window.innerWidth - 8
        ? desiredLeft
        : Math.max(8, modelPickerRect.left - effortRect.width - 8);
      setEffortPickerStyle({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [activeThinkingIndex, commandPicker, modelOptions, pendingModel, pickerOpen, pickerView]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelControlRef.current?.contains(target) || modelPickerRef.current?.contains(target) || pickerRef.current?.contains(target) || (commandPicker && inputRef.current?.contains(target))) return;
      setPickerOpen(false);
      setPickerView("model");
      setPendingModel(null);
      setEffortPickerStyle(undefined);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [commandPicker, pickerOpen]);

  useEffect(() => {
    if (commandQuery === null) setMenuDismissed(false);
  }, [commandQuery]);

  useEffect(() => {
    if (!commandMenuOpen) return;
    return pushEscapeLayer(() => setMenuDismissed(true));
  }, [commandMenuOpen]);

  useEffect(() => {
    setSkills([...preparedSkills]);
  }, [preparedSkills]);

  const reloadResources = useCallback(async () => {
    if (!enabled || !workspaceId || !sessionId) return;
    setError(null);
    try {
      const nextSkills = await client.reloadSessionResources(
        workspaceId,
        sessionId,
      );
      setSkills(nextSkills);
      onSkillsChange?.(nextSkills);
      setText("");
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [enabled, onSkillsChange, sessionId, workspaceId]);

  async function refreshCatalog(): Promise<ModelCatalogProvider[]> {
    if (!enabled || !workspaceId || !sessionId) return [];
    setCatalogLoading(true);
    setError(null);
    try {
      const nextCatalog = await client.getModelCatalog();
      setCatalog(nextCatalog);
      onModelAvailabilityChange?.(nextCatalog.some(provider => provider.models.length > 0));
      return nextCatalog;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setCatalogLoading(false);
    }
  }

  async function presentPicker(view: ComposerPickerView, origin: ComposerPickerOrigin = "status") {
    if (!enabled || !workspaceId || !sessionId) return;
    setPickerOrigin(origin);
    setPendingModel(null);
    setEffortPickerStyle(undefined);
    setPickerView(view);
    if (view === "thinking") {
      setActiveThinkingIndex(Math.max(0, effortOptions.indexOf(thinkingLevel)));
    }
    setPickerOpen(true);
    const nextCatalog = await refreshCatalog();
    if (!nextCatalog.some(provider => provider.models.length > 0)) {
      setPickerOpen(false);
      return;
    }
    if (view === "thinking") {
      const currentModel = flattenModelCatalog(nextCatalog).find(
        (option) => option.provider === configuration.provider && option.model === configuration.model,
      );
      setPendingModel(currentModel ?? null);
      if (!currentModel) {
        setPickerView("model");
        if (origin === "thinking-command") setPickerOrigin("model-command");
      }
    }
  }

  async function togglePicker() {
    if (pickerOpen && !commandPicker) {
      setPickerOpen(false);
      setPendingModel(null);
      inputRef.current?.focus();
      return;
    }
    setPendingModel(null);
    await presentPicker("model");
  }

  async function changeConfiguration(patch: SessionConfigurationUpdate) {
    if (!enabled || !workspaceId || !sessionId) return;
    setError(null);
    try {
      await onConfigurationChange(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function selectModel(option: ModelOption) {
    if (
      pickerView === "thinking" &&
      pendingModel?.provider === option.provider &&
      pendingModel.model === option.model
    ) {
      setPickerView("model");
      setPendingModel(null);
      setEffortPickerStyle(undefined);
      return;
    }
    setPendingModel(option);
    setEffortPickerStyle(undefined);
    setActiveThinkingIndex(
      Math.max(0, option.thinkingLevels.indexOf(thinkingLevel)),
    );
    setPickerView("thinking");
  }

  async function selectThinking(level: SessionConfiguration["thinkingLevel"]) {
    if (!level) return;
    try {
      await onConfigurationChange({
        ...(pendingModel
          ? { provider: pendingModel.provider, model: pendingModel.model }
          : {}),
        thinkingLevel: level,
      });
      setPickerOpen(false);
      setPendingModel(null);
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleWiki() {
    await changeConfiguration({ wikiPromptEnabled: !wikiEnabled });
  }

  async function selectCommand(command: ComposerCommand) {
    setMenuDismissed(true);
    setError(null);
    if (command.kind === "skill") {
      setText(`/skill:${command.skillName} `);
      inputRef.current?.focus();
      return;
    }
    if (command.kind === "prompt") {
      await sendPrompt(command.label, command.id);
      return;
    }

    if (command.id === "reload" && sessionBusy) {
      setError("Reload Resources is unavailable while the Session is busy");
      inputRef.current?.focus();
      return;
    }

    setText("");
    if (command.id === "model") {
      await presentPicker("model", "model-command");
    } else if (command.id === "thinking") {
      await presentPicker("thinking", "thinking-command");
    } else if (command.id === "reload") {
      await reloadResources();
    } else {
      await toggleWiki();
      inputRef.current?.focus();
    }
  }

  async function onSend() {
    const trimmed = text.trim();
    const exactCommand =
      commandQuery === null
        ? undefined
        : commandMatches.find(
            (command) =>
              command.kind !== "skill" && command.label === trimmed,
          );
    const selectedCommand = commandMenuOpen
      ? commandMatches[activeCommandIndex]
      : exactCommand;
    if (selectedCommand) {
      await selectCommand(selectedCommand);
      return;
    }
    await sendPrompt(trimmed);
  }

  async function sendPrompt(trimmed: string, command?: PromptCommandId) {
    const submittedDraftText = text;
    const submittedClips = [...contextClips];
    if (
      !enabled ||
      !sendingEnabled ||
      sessionBusy ||
      sendingRef.current ||
      !workspaceId ||
      !sessionId ||
      (!trimmed && contextClips.length === 0)
    ) {
      return;
    }
    const prompt = { workspaceId, sessionId, text: trimmed, clips: submittedClips, ...(command ? { command } : {}) };
    if (!configuration.provider || !configuration.model) {
      await presentPicker("model");
      return;
    }
    try {
      normalizeStructuredPrompt(prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const pendingLabel: PendingPrompt = command ? { command } : trimmed || `${contextClips.length} Context Clips`;
    let draftCleared = false;
    const clearSubmittedDraft = () => {
      if (draftCleared) return;
      draftCleared = true;
      submittedDraftRef.current = null;
      if (textRef.current === submittedDraftText) setText("");
      const remainingClips = clipsRef.current.filter(
        (current) => !submittedClips.some((submitted) => sameContextClip(current, submitted)),
      );
      if (remainingClips.length !== clipsRef.current.length) onClipsChange?.(remainingClips);
    };
    try {
      if (beforeSend && !(await beforeSend())) {
        setError("Save your Markdown changes before sending.");
        return;
      }
      // The HTTP request stays open for the entire Turn. Clear on persisted
      // Timeline acceptance so the user can compose the next message meanwhile.
      submittedDraftRef.current = { messageCount: userMessageCount, clear: clearSubmittedDraft };
      onPendingChange?.(pendingLabel);
      await client.prompt(prompt);
      clearSubmittedDraft();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const request = await client.getProjectTrustRequest(workspaceId, sessionId);
        if (request) {
          await onTrustRequired?.(request);
          onPendingChange?.(pendingLabel);
          await client.prompt(prompt);
          clearSubmittedDraft();
          setError(null);
          return;
        }
      } catch {
        // Keep the original Prompt error visible when the trust query fails.
      }
      onPendingChange?.(null);
      setError(message);
    } finally {
      submittedDraftRef.current = null;
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function onCancel() {
    if (!sessionBusy || !workspaceId || !sessionId) return;
    setError(null);
    try {
      await client.abort(workspaceId, sessionId);
      onCancelled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (commandMenuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommandIndex(
          (index) => (index + 1) % commandMatches.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommandIndex(
          (index) => (index - 1 + commandMatches.length) % commandMatches.length,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const command = commandMatches[activeCommandIndex];
        if (command?.kind === "prompt" && (composing || event.nativeEvent.isComposing)) return;
        if (command) void selectCommand(command);
        return;
      }
    }

    if (pickerOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pickerView === "thinking" && pickerOrigin !== "thinking-command") setPickerView("model");
        else setPickerOpen(false);
        return;
      }
      if (pickerView === "model") {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (modelOptions.length === 0) return;
          event.preventDefault();
          setActiveModelIndex((index) =>
            event.key === "ArrowDown"
              ? (index + 1) % modelOptions.length
              : (index - 1 + modelOptions.length) % modelOptions.length,
          );
          return;
        }
        // Enter picks the highlighted Model; it must never fall through to Send.
        if (event.key === "Enter") {
          event.preventDefault();
          if (composing || event.nativeEvent.isComposing) return;
          const option = modelOptions[activeModelIndex];
          if (option) selectModel(option);
          return;
        }
      } else {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (effortOptions.length === 0) return;
          event.preventDefault();
          setActiveThinkingIndex((index) =>
            event.key === "ArrowDown"
              ? (index + 1) % effortOptions.length
              : (index - 1 + effortOptions.length) % effortOptions.length,
          );
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (composing || event.nativeEvent.isComposing) return;
          void selectThinking(effortOptions[activeThinkingIndex]);
          return;
        }
      }
    }

    // IME guard: never send on Enter while composing. While busy this keeps
    // ordinary draft text editable but prevents it from becoming a Prompt.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !composing &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void onSend();
    }
  }

  const picker = <>
    {pickerOpen && (catalogLoading || modelOptions.length > 0) && (!commandPicker || pickerView === "model") ? (
      <div ref={modelPickerRef} className={commandPicker ? "composer-command-menu" : "composer-picker composer-model-picker"} data-testid="composer-model-picker" role="listbox" aria-label="Select Model">
        {catalogLoading ? <p className="composer-picker-empty">Loading Models…</p> : (
          <div className="composer-picker-options">
            {modelOptions.map((option, index) => {
              const applied = option.provider === configuration.provider && option.model === configuration.model;
              return (
                <button key={`${option.provider}/${option.model}`} type="button" role="option" aria-selected={applied} className={index === activeModelIndex ? "composer-picker-option composer-picker-option-active" : "composer-picker-option"} data-testid="composer-model-option" onMouseDown={(event) => { if (commandPicker) event.preventDefault(); }} onMouseMove={() => setActiveModelIndex(index)} onClick={() => { setActiveModelIndex(index); selectModel(option); }}>
                  <span className="composer-picker-label">{option.provider}/{option.model}</span>
                  <ChevronRight size={14} aria-hidden="true" className="composer-chip-chevron" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    ) : null}
    {pickerOpen && pickerView === "thinking" ? (
      <div ref={pickerRef} className={commandPicker ? "composer-command-menu" : "composer-picker composer-effort-picker"} style={commandPicker ? undefined : effortPickerStyle} data-testid="composer-thinking-picker" role="listbox" aria-label={`Select Effort for ${pendingModel?.modelName ?? selectedModelLabel}`}>
        {commandPicker ? <div className="composer-command-picker-heading">
          {pickerOrigin === "model-command" ? <button type="button" className="icon-btn" aria-label="Back to Models" onMouseDown={(event) => event.preventDefault()} onClick={() => setPickerView("model")}><ArrowLeft size={14} aria-hidden="true" /></button> : <Brain size={14} aria-hidden="true" />}
          <span>{pendingModel?.modelName ?? selectedModelDisplayLabel} · Effort</span>
        </div> : null}
        <div className="composer-picker-options">
          {effortOptions.map((level, index) => (
            <button key={level} type="button" role="option" aria-selected={level === thinkingLevel} className={index === activeThinkingIndex ? "composer-picker-option composer-picker-option-active" : "composer-picker-option"} data-testid={`composer-thinking-option-${level}`} onMouseDown={(event) => { if (commandPicker) event.preventDefault(); }} onMouseMove={() => setActiveThinkingIndex(index)} onClick={() => void selectThinking(level as SessionConfiguration["thinkingLevel"])}>
              <span className="composer-picker-label">{thinkingLevelLabel(level)}</span>
              {level === thinkingLevel ? <Check size={14} aria-hidden="true" className="composer-picker-check" /> : null}
            </button>
          ))}
        </div>
      </div>
    ) : null}
  </>;

  return (
    <footer
      className={layout === "bar" ? "composer composer-bar" : "composer"}
      aria-label="Composer"
    >
      <div
        className={
          sessionBusy
            ? "composer-card composer-card-busy"
            : enabled
              ? "composer-card"
              : "composer-card composer-card-disabled"
        }
      >
        <ContextClipDetails
          clips={contextClips}
          showSources
          className="composer-clips"
          onNavigate={onClipNavigate}
          onRemove={(index) => onClipsChange?.(contextClips.filter((_, clipIndex) => clipIndex !== index))}
        />
        {commandPicker ? picker : null}
        {commandMenuOpen ? (
          <div
            ref={commandMenuRef}
            className="composer-command-menu"
            data-testid="composer-command-menu"
            role="listbox"
            aria-label="Composer commands"
          >
            {commandMatches.map((command, index) => {
              const unavailable =
                (command.kind === "prompt" && (!sendingEnabled || sessionBusy || sending)) ||
                (command.kind === "action" &&
                  command.id === "reload" &&
                  sessionBusy);
              const Icon = commandIcon(command);
              return (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeCommandIndex}
                  aria-disabled={unavailable}
                  disabled={unavailable}
                  className={
                    unavailable
                      ? "composer-command-option composer-command-option-disabled"
                      : index === activeCommandIndex
                        ? "composer-command-option composer-command-option-active"
                        : "composer-command-option"
                  }
                  data-testid={`composer-command-${command.id}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActiveCommandIndex(index)}
                  onClick={() => void selectCommand(command)}
                >
                  <Icon size={14} aria-hidden="true" className="composer-command-icon" />
                  <strong className="composer-command-label">{command.label}</strong>
                  <span className="composer-command-description">{command.description}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          className="composer-input"
          data-testid="composer-input"
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            if (!/^\/skill:[^\s]+\s/u.test(next)) {
              setMenuDismissed(false);
            }
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          placeholder={
            sessionBusy
              ? "Agent is busy…"
              : enabled
                ? "Message the agent…"
                : (disabledPlaceholder ??
                  "Open a Workspace and select a Session first")
          }
          rows={layout === "bar" ? 1 : 2}
          disabled={!enabled}
          onKeyDown={onInputKeyDown}
        />
        <div className="composer-status">
          {sessionId ? <div className="composer-status-left">
            <ContextUsage context={context} loading={contextLoading} />
            <AccessModePicker key={sessionId} mode={configuration.accessMode ?? "auto-review"}
              disabled={!enabled || !workspaceId}
              onChange={(accessMode) => onConfigurationChange({ accessMode })} />
          </div> : null}
          <div className="composer-status-right">
            <div ref={modelControlRef} className="composer-model-control">
              {!commandPicker ? picker : null}
              <button
                type="button"
                className={
                  modelPending
                    ? "composer-model-chip composer-model-chip-btn composer-model-chip-pending"
                    : "composer-model-chip composer-model-chip-btn"
                }
                data-testid="composer-model-chip"
                title="Choose Session Model and Effort"
                aria-label={modelPending ? `Pending Session Model: ${selectedModelLabel}` : `Session Model: ${selectedModelLabel}`}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen && !commandPicker}
                disabled={!enabled || !workspaceId || !sessionId}
                onClick={() => void togglePicker()}
              >
                {modelPending ? "Next · " : ""}
                <span className="composer-chip-label">{selectedModelDisplayLabel}</span>
                <span className="composer-chip-effort">· {thinkingLevelLabel(thinkingLevel)}</span>
              </button>
            </div>
            {sessionBusy ? (
              <button
                type="button"
                className="composer-send"
                data-testid="composer-cancel"
                title="Cancel Run"
                aria-label="Cancel Run"
                onClick={() => void onCancel()}
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                data-testid="composer-send"
                title="Send"
                aria-label="Send"
                disabled={!enabled || !sendingEnabled || sending || (!text.trim() && contextClips.length === 0)}
                onClick={() => void onSend()}
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      {error ? (
        <p className="composer-error" data-testid="composer-error" role="alert">
          {error}
        </p>
      ) : null}
    </footer>
  );
}
