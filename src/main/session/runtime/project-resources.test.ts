import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentTools } from "../../agent-tools";
import { wikilotPromptOptions } from "./system-prompt";

describe("Pi project resources under resolved Project Trust", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function seedProject() {
    const root = mkdtempSync(join(tmpdir(), "wikilot-resources-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "skills", "pi-probe"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
    mkdirSync(join(cwd, ".agents", "skills", "agents-probe"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "workspace agents context\n");
    writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "project system prompt\n");
    writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "project append prompt\n");
    writeFileSync(
      join(cwd, ".pi", "skills", "pi-probe", "SKILL.md"),
      "---\nname: pi-probe\ndescription: probe\n---\nprobe skill\n",
    );
    writeFileSync(
      join(cwd, ".agents", "skills", "agents-probe", "SKILL.md"),
      "---\nname: agents-probe\ndescription: probe\n---\nagent skill\n",
    );
    writeFileSync(join(cwd, ".pi", "prompts", "probe.md"), "project prompt template\n");
    writeFileSync(
      join(cwd, ".pi", "extensions", "probe.js"),
      `export default function (pi) {
        pi.registerTool({
          name: "trust_probe",
          label: "Trust probe",
          description: "Project extension tool",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "probe ok" }], details: {} }; }
        });
      };
`,
    );
    return { cwd, agentDir };
  }

  async function load(projectTrusted: boolean) {
    const { cwd, agentDir } = seedProject();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      ...wikilotPromptOptions(() => "# LLM Wiki\n"),
    });
    await loader.reload();
    return { cwd, agentDir, settingsManager, loader };
  }

  it("excludes executable project resources when rejected but keeps Workspace context", async () => {
    const { loader } = await load(false);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain("pi-probe");
    expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain("agents-probe");
    expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).not.toContain("probe");
    expect(loader.getSystemPrompt()).toBe("# LLM Wiki\n");
    expect(loader.getAppendSystemPrompt().join("\n")).toContain("Context Clips are quoted source snapshots");
    expect(loader.getAgentsFiles().agentsFiles.map((file) => file.content)).toContain(
      "workspace agents context\n",
    );
  });

  it("preserves project Extensions, tools, resources, Skills, Prompts, and context when approved", async () => {
    const { cwd, agentDir, settingsManager, loader } = await load(true);
    expect(loader.getExtensions().extensions).toHaveLength(2);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["pi-probe", "agents-probe"]),
    );
    expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("probe");
    expect(loader.getSystemPrompt()).toBe("# LLM Wiki\n");
    expect(loader.getAppendSystemPrompt()).toContain("project append prompt\n");
    expect(loader.getAppendSystemPrompt().join("\n")).not.toContain("# LLM Wiki");
    expect(loader.getAgentsFiles().agentsFiles.map((file) => file.content)).toContain(
      "workspace agents context\n",
    );

    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const model = runtime.getModels()[0];
    expect(model).toBeDefined();
    const created = await createAgentSession({
      cwd,
      agentDir,
      model: model!,
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: createAgentTools(cwd, agentDir).customTools,
    });
    expect(created.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["trust_probe", "read_pdf_page", "inspect_pdf", "read_pdf_text"]),
    );
    created.session.dispose();
  });
});
