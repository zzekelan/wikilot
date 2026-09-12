import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { encodeAbsoluteCwd } from "../workspace";

/** App-managed Session root (never `~/.pi`). */
export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".wikilot", "sessions");

/** Resolve `~/.wikilot/sessions/<encoded-absolute-cwd>/` (or under `sessionsRoot`). */
export function resolveAppSessionDir(
  absoluteCwd: string,
  sessionsRoot: string = DEFAULT_SESSIONS_ROOT,
): string {
  return join(resolve(sessionsRoot), encodeAbsoluteCwd(absoluteCwd));
}
