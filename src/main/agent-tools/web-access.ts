import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Prepare the bundled extension without changing an existing user configuration. */
export function prepareWebAccess(agentDir: string): string {
  mkdirSync(agentDir, { recursive: true });
  try {
    writeFileSync(
      join(agentDir, "web-search.json"),
      `${JSON.stringify({ workflow: "none" }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Pi loads the package's TypeScript through its own extension loader.
  return createRequire(import.meta.url).resolve("pi-web-access/index.ts");
}
