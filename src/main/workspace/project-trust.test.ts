import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectTrustService } from "./project-trust";

describe("project trust service", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("detects project resources and persists the decision without reading resource bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "wikilot-trust-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions"), "extension body must stay private");

    const trust = createProjectTrustService(agentDir);
    expect(trust.evaluate(cwd)).toEqual({
      requiresDecision: true,
      decision: "undecided",
      projectTrusted: false,
    });

    trust.set(cwd, false);

    expect(trust.evaluate(cwd).decision).toBe("untrusted");
    expect(existsSync(join(agentDir, "trust.json"))).toBe(true);
    expect(readFileSync(join(agentDir, "trust.json"), "utf8")).not.toContain("extension body");
  });
});
