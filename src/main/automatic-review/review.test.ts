import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AccessMode } from "../../shared/workspace";
import { PROMPT_ENTRY_TYPE, createPromptRecord } from "../../shared/session";
import { installAutomaticReview } from "./index";
import { createUtilitySettingsStore } from "../utility-model";
import { constrainJsonSchemaOutput } from "../models";
import { reviewSchema } from "./structured-output";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const webExtensionPath = createRequire(import.meta.url).resolve("pi-web-access/index.ts");

async function setup(customTools: ToolDefinition[] = [], withWeb = false) {
  let mode: AccessMode = "auto-review";
  const root = mkdtempSync(join(tmpdir(), "wikilot-review-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels().find((model) => model.api === "openai-responses")!;
  const settings = SettingsManager.inMemory({ shellCommandPrefix: "export REVIEW_TEST=1" });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    additionalExtensionPaths: withWeb ? [webExtensionPath] : [],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
    settingsManager: settings, resourceLoader, sessionManager: manager, customTools });
  cleanup.push(() => session.dispose());
  const store = createUtilitySettingsStore(root);
  const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content,
    api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() });
  const complete = vi.fn(async (_model, _context: Context, options?: ModelsSimpleStreamOptions) => {
    await options?.onPayload?.({}, model);
    return assistant([{ type: "text", text: '{"outcome":"allow","reason":"Authorized local change"}' }]);
  });
  const getModel = vi.fn(runtime.getModel.bind(runtime));
  function prompt(text: string) {
    manager.appendCustomEntry(PROMPT_ENTRY_TYPE, createPromptRecord({ workspaceId: "ws", sessionId: "session", text, clips: [] }));
    manager.appendMessage({ role: "user", content: `expanded:${text}`, timestamp: Date.now() });
  }
  function call(name = "write", args: unknown = { path: "note.md", content: "hi" }, signal?: AbortSignal) {
    const toolCall = { type: "toolCall" as const, id: "call-1", name, arguments: args as Record<string, unknown> };
    const message = assistant([toolCall]);
    manager.appendMessage(message);
    return session.agent.beforeToolCall!({ assistantMessage: message, toolCall, args,
      context: { messages: [], tools: session.agent.state.tools, systemPrompt: "" } }, signal);
  }
  function install() {
    installAutomaticReview({ session, runtime: { getModel, completeSimple: complete }, settings,
      readSettings: store.read, cwd: root, trustedReadTools: [], trustedReadExtensionPaths: [webExtensionPath], getAccessMode: () => mode });
  }
  return { root, session, manager, model, assistant, complete, getModel, prompt, call, store, install, settings,
    setMode(value: AccessMode) { mode = value; } };
}

it("reviews a complete action once with native schema and original ordered Turns", async () => {
  const test = await setup();
  test.install();
  for (const text of ["old excluded", "proposal", "ok", "current request"]) test.prompt(text);
  test.manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "previous", isError: false,
    content: [{ type: "text", text: "head-" + "a".repeat(10_000) + "-tail" }], timestamp: Date.now() });
  test.manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "second", isError: false,
    content: [{ type: "text", text: "second-head-" + "b".repeat(10_000) + "-second-tail" }], timestamp: Date.now() });
  const args = { command: "printf reviewed", timeout: 10 };
  expect(await test.call("bash", args)).toBeUndefined();
  expect(test.complete).toHaveBeenCalledTimes(1);
  const [, context, options] = test.complete.mock.calls[0];
  const input = JSON.parse(context.messages[0].content as string);
  expect(input.conversation.filter((item: {role: string}) => item.role === "user").map((item: {text: string}) => item.text))
    .toEqual(["proposal", "ok", "current request"]);
  const result = input.conversation.find((item: {role: string}) => item.role === "toolResult");
  expect(result.text.length).toBeLessThanOrEqual(4000);
  expect(result.text).toContain("head-");
  expect(result.text).toContain("-tail");
  const second = input.conversation.find((item: {toolCallId?: string}) => item.toolCallId === "second");
  expect(second.text.length).toBeLessThanOrEqual(4000);
  expect(second.text).toContain("second-head-");
  expect(result.text.length + second.text.length).toBeGreaterThan(7000);
  expect(input.action.arguments).toEqual(args);
  expect(input.action.effectiveCommand).toBe("export REVIEW_TEST=1\nprintf reviewed");
  expect(Object.isFrozen(args)).toBe(true);
  expect(context.tools).toBeUndefined();
  expect(await options!.onPayload!({}, test.model)).toEqual({ text: { format: {
    type: "json_schema", name: "automatic_review", strict: true, schema: reviewSchema,
  } } });
});

it("skips known built-in reads but reviews an SDK tool that overrides read", async () => {
  const ordinary = await setup();
  ordinary.install();
  expect(await ordinary.call("read", { path: "file" })).toBeUndefined();
  expect(ordinary.complete).not.toHaveBeenCalled();
  const replacement: ToolDefinition = { name: "read", label: "Read", description: "Extension read",
    parameters: Type.Object({ path: Type.String() }), execute: async () => ({ content: [], details: {} }) };
  const custom = await setup([replacement]);
  custom.install(); custom.prompt("read file");
  await custom.call("read", { path: "file" });
  expect(custom.complete).toHaveBeenCalledTimes(1);
});

it("retains extension denials and reviews arguments after extension preparation", async () => {
  const test = await setup();
  const hook: NonNullable<AgentSession["agent"]["beforeToolCall"]> = async (call) => {
    (call.args as { content: string }).content = "prepared";
    return undefined;
  };
  test.session.agent.beforeToolCall = hook;
  test.install(); test.prompt("write file");
  await test.call();
  const input = JSON.parse(test.complete.mock.calls[0][1].messages[0].content as string);
  expect(input.action.arguments.content).toBe("prepared");
  const blocked = await setup();
  blocked.session.agent.beforeToolCall = async () => ({ block: true, reason: "extension denied" });
  blocked.install();
  expect(await blocked.call()).toEqual({ block: true, reason: "extension denied" });
  expect(blocked.complete).not.toHaveBeenCalled();
});

it("returns a denial to the agent without terminating safe alternative work", async () => {
  const test = await setup(); test.install(); test.prompt("do something");
  test.complete.mockImplementation(async (_model, _context, options) => {
    await options?.onPayload?.({}, test.model);
    return test.assistant([{ type: "text", text: '{"outcome":"deny","reason":"Publication is not authorized"}' }]);
  });
  const result = await test.call();
  expect(result).toMatchObject({ block: true, reason: expect.stringContaining("Publication is not authorized") });
  expect(result?.terminate).not.toBe(true);
});

it.each(["not json", '{"outcome":"allow"}', '{"outcome":"allow","reason":"ok","extra":1}'])
("fails closed for an invalid response: %s", async (text) => {
  const test = await setup(); test.install(); test.prompt("do something");
  test.complete.mockImplementation(async (_model, _context, options) => {
    await options?.onPayload?.({}, test.model);
    return test.assistant([{ type: "text", text }]);
  });
  expect(await test.call()).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("Review failed") });
});

it("uses an independent selection, and never falls back when it is missing or corrupt", async () => {
  const test = await setup(); test.install(); test.prompt("do something");
  test.store.update({ model: { provider: test.model.provider, model: test.model.id, thinkingLevel: "off" } });
  await test.call();
  expect(test.getModel).toHaveBeenCalledWith(test.model.provider, test.model.id);
  test.complete.mockClear();
  test.store.update({ model: { provider: "missing", model: "missing", thinkingLevel: "off" } });
  expect(await test.call()).toMatchObject({ block: true, terminate: true });
  writeFileSync(join(test.root, "utility-model.json"), "broken");
  expect(await test.call()).toMatchObject({ block: true, terminate: true });
  expect(test.complete).not.toHaveBeenCalled();
  test.store.update({ model: null });
  expect(createUtilitySettingsStore(test.root).read()).toEqual({ model: null });
});

it("does not accept a late allow after cancellation", async () => {
  const test = await setup(); test.install(); test.prompt("do something");
  const controller = new AbortController();
  test.complete.mockImplementation(async (_model, _context, options) => {
    await options?.onPayload?.({}, test.model);
    controller.abort();
    return test.assistant([{ type: "text", text: '{"outcome":"allow","reason":"ok"}' }]);
  });
  expect(await test.call("write", { path: "note", content: "hi" }, controller.signal))
    .toMatchObject({ block: true, terminate: true });
});

it("blocks a timed-out review even if the provider returns an allow when aborted", async () => {
  const test = await setup(); test.install(); test.prompt("do something");
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  test.complete.mockImplementation(async (_model, _context, options) => {
    await options?.onPayload?.({}, test.model);
    started();
    return await new Promise<AssistantMessage>((resolve) => options!.signal!.addEventListener("abort", () => {
      resolve(test.assistant([{ type: "text", text: '{"outcome":"allow","reason":"ok"}' }]));
    }, { once: true }));
  });
  // AbortSignal.timeout uses Node's native timer; inject its clock only at this
  // platform seam so the model and the production gate still observe one signal.
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  try {
    const result = test.call();
    await modelStarted;
    controller.abort(new DOMException("Review timed out", "TimeoutError"));
    expect(await result).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("timed out") });
    expect(timeout).toHaveBeenCalledWith(60_000);
  } finally { timeout.mockRestore(); }
});

it("fails on provider errors, truncated output and missing native schema application", async () => {
  const test = await setup(); test.install(); test.prompt("do something");
  test.complete.mockRejectedValueOnce(new Error("Provider unavailable"));
  expect(await test.call()).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("Provider unavailable") });
  test.complete.mockImplementationOnce(async (_model, _context, options) => {
    await options?.onPayload?.({}, test.model);
    return { ...test.assistant([{ type: "text", text: '{"outcome":"allow","reason":"ok"}' }]), stopReason: "length" };
  });
  expect(await test.call()).toMatchObject({ block: true, terminate: true });
  test.complete.mockResolvedValueOnce(test.assistant([{ type: "text", text: '{"outcome":"allow","reason":"ok"}' }]));
  expect(await test.call()).toMatchObject({ block: true, terminate: true });
});

it("keeps large pending arguments complete and blocks a context overflow", async () => {
  const test = await setup(); test.install(); test.prompt("write the provided document");
  const args = { path: "note.md", content: "document ".repeat(1000) };
  expect(await test.call("write", args)).toBeUndefined();
  expect(JSON.parse(test.complete.mock.calls[0][1].messages[0].content as string).action.arguments).toEqual(args);
  test.store.update({ model: { provider: test.model.provider, model: test.model.id, thinkingLevel: "off" } });
  test.getModel.mockReturnValueOnce({ ...test.model, contextWindow: 100 });
  test.complete.mockClear();
  expect(await test.call()).toMatchObject({ block: true, reason: expect.stringContaining("context window") });
  expect(test.complete).not.toHaveBeenCalled();
});

it("sets native constraints for each supported protocol and rejects unknown ones", () => {
  expect(constrainJsonSchemaOutput("openai-completions", {}, { name: "automatic_review", schema: reviewSchema })).toHaveProperty("response_format.json_schema.strict", true);
  expect(constrainJsonSchemaOutput("openai-codex-responses", {}, { name: "automatic_review", schema: reviewSchema })).toHaveProperty("text.format.strict", true);
  expect(constrainJsonSchemaOutput("anthropic-messages", { output_config: { effort: "high" } }, { name: "automatic_review", schema: reviewSchema }))
    .toHaveProperty("output_config.format.schema", reviewSchema);
  expect(constrainJsonSchemaOutput("google-generative-ai", {}, { name: "automatic_review", schema: reviewSchema })).toHaveProperty("config.responseJsonSchema", reviewSchema);
  expect(() => constrainJsonSchemaOutput("unknown-api", {}, { name: "automatic_review", schema: reviewSchema })).toThrow("unsupported protocol");
});

it("Full Access bypasses review configuration and inference, and switching back restores review", async () => {
  const test = await setup(); test.install(); test.prompt("write a document");
  test.setMode("full-access");
  writeFileSync(join(test.root, "utility-model.json"), "invalid settings");
  expect(await test.call()).toBeUndefined();
  expect(test.complete).not.toHaveBeenCalled();
  test.setMode("auto-review");
  test.store.update({ model: null });
  expect(await test.call()).toBeUndefined();
  expect(test.complete).toHaveBeenCalledTimes(1);
});

it("skips bundled web tools by source but reviews an SDK tool with the same name", async () => {
  const web = await setup([], true);
  web.install();
  for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
    expect(web.session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.path).toBe(webExtensionPath);
    expect(await web.call(name, {})).toBeUndefined();
  }
  expect(web.complete).not.toHaveBeenCalled();
  const custom = await setup([{ name: "web_search", label: "Search", description: "Custom tool",
    parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }]);
  custom.install(); custom.prompt("search the web");
  await custom.call("web_search", {});
  expect(custom.complete).toHaveBeenCalledTimes(1);
});


it("bypasses review for literal read-only Bash commands, including safe chains", async () => {
  const test = await setup(); test.settings.setShellCommandPrefix(undefined); test.install();
  writeFileSync(join(test.root, "utility-model.json"), "invalid review settings must not be consulted");
  for (const command of [
    "pwd", "ls -lah src", "/bin/ls -l", "/usr/bin/wc -l file", "cat 'a b.md'", 'cat "a b.md"',
    "head -n 20 file", "tail -n10 file", "wc --lines file", "grep -n -e pattern file",
    "rg --files --hidden", "rg -n -g '*.ts' 'foo|bar' src", "rg --max-count=2 --regexp=foo src",
    "cat note.md | head -n 10", "pwd && ls -la; wc -l note.md", "grep foo file || cat file",
    "cat -- '-file'", "rg -e --pre=literal-pattern src",
  ]) {
    const args = { command };
    expect(await test.call("bash", args), command).toBeUndefined();
    expect(Object.isFrozen(args), command).toBe(true);
  }
  expect(test.complete).not.toHaveBeenCalled();
});

it("retains model review for mutations, ambiguous shell syntax and executable options", async () => {
  const test = await setup(); test.settings.setShellCommandPrefix(undefined); test.install(); test.prompt("Inspect the workspace");
  for (const command of [
    "rm -rf data", "touch file", "git status", "git diff", "find . -delete", "sed -i s/a/b/ file",
    "rg --pre=sh foo .", "rg --pre sh foo .", "rg --search-zip foo .", "sort --compress-program=sh file",
    "cat file > output", "cat file 2>&1", "cat < file", "cat file | tee output", "pwd && rm file",
    "pwd; rm file", "cat file | bash", "cat $(touch output)", "cat `touch output`", "cat <(touch output)",
    "cat $FILE", "cat *.md", "cat [ab].md", "cat {a,b}.md", "cat ~/file", "cat file # comment",
    "cat file\nrm output", "cat\u00a0file", "cat 'unterminated", 'cat "unterminated', "cat foo\\ bar",
    "ls &", "ls &&", "ls ;; pwd", "(ls)", "PATH=/tmp ls", "env ls", "bash -c ls",
    "/tmp/ls", "./cat file", "ls --unknown-option", "rg --max-count=no foo file", "head -n",
    "cat;", "", "toString", "pwd && { ls; }",
  ]) {
    test.complete.mockClear();
    expect(await test.call("bash", { command }), command).toBeUndefined();
    expect(test.complete, command).toHaveBeenCalledTimes(1);
  }
});

it("keeps reviewing custom Bash tools, prefixes and shells, and extension-rewritten actions", async () => {
  const test = await setup(); test.install(); test.prompt("Inspect the workspace");
  await test.call("bash", { command: "ls" });
  expect(test.complete).toHaveBeenCalledTimes(1);
  test.settings.setShellCommandPrefix(undefined);
  test.settings.setShellPath("/custom/bash");
  await test.call("bash", { command: "ls" });
  expect(test.complete).toHaveBeenCalledTimes(2);
  const custom = await setup([{ name: "bash", label: "Bash", description: "Custom tool",
    parameters: Type.Object({ command: Type.String() }), execute: async () => ({ content: [], details: {} }) }]);
  custom.settings.setShellCommandPrefix(undefined); custom.install(); custom.prompt("Inspect the workspace");
  await custom.call("bash", { command: "ls" });
  expect(custom.complete).toHaveBeenCalledTimes(1);
  const rewritten = await setup(); rewritten.settings.setShellCommandPrefix(undefined);
  rewritten.session.agent.beforeToolCall = async (call) => {
    (call.args as { command: string }).command = "touch file";
    return undefined;
  };
  rewritten.install(); rewritten.prompt("Inspect the workspace");
  await rewritten.call("bash", { command: "ls" });
  expect(rewritten.complete).toHaveBeenCalledTimes(1);
  expect(JSON.parse(rewritten.complete.mock.calls[0][1].messages[0].content as string).action.arguments.command).toBe("touch file");
});

it("does not bypass review when startup scripts or ripgrep config could add execution", async () => {
  const test = await setup(); test.settings.setShellCommandPrefix(undefined); test.install(); test.prompt("Inspect the workspace");
  try {
    vi.stubEnv("BASH_ENV", "/tmp/startup.sh");
    await test.call("bash", { command: "ls" });
    expect(test.complete).toHaveBeenCalledTimes(1);
    vi.stubEnv("BASH_ENV", "");
    vi.stubEnv("RIPGREP_CONFIG_PATH", "/tmp/rg-config");
    await test.call("bash", { command: "rg pattern file" });
    expect(test.complete).toHaveBeenCalledTimes(2);
  } finally { vi.unstubAllEnvs(); }
});
