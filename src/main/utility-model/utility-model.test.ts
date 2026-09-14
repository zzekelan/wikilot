import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createUtilitySettingsStore, resolveUtilityModel } from "./index";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("persists an independent model and Thinking Level, then resumes the supplied Session selection when cleared", async () => {
  const root = mkdtempSync(join(tmpdir(), "utility-model-")); roots.push(root);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const available = runtime.getModels();
  const session = { provider: available[0].provider, model: available[0].id, thinkingLevel: "off" as const };
  const separate = { provider: available[1].provider, model: available[1].id, thinkingLevel: "off" as const };
  const store = createUtilitySettingsStore(root);
  store.update({ model: separate });
  const restored = createUtilitySettingsStore(root).read();
  expect(restored.model).toEqual(separate);
  expect(resolveUtilityModel(runtime, restored, session).model.id).toBe(separate.model);
  store.update({ model: null });
  expect(resolveUtilityModel(runtime, store.read(), session).model.id).toBe(session.model);
});
it("uses App Defaults only without a Session and rejects an unavailable or unsupported explicit selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "utility-model-")); roots.push(root);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels().find((model) => !model.reasoning)!;
  const defaults = { provider: model.provider, model: model.id, thinkingLevel: "off" as const };
  expect(resolveUtilityModel(runtime, { model: null }, undefined, defaults).model.id).toBe(model.id);
  expect(() => resolveUtilityModel(runtime, { model: { ...defaults, model: "missing" } }, defaults)).toThrow("unavailable");
  expect(() => resolveUtilityModel(runtime, { model: { ...defaults, thinkingLevel: "high" } }, defaults)).toThrow("Thinking Level");
  expect(() => resolveUtilityModel(runtime, { model: null })).toThrow("Select a model");
});
