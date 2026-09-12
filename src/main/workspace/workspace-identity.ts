import { resolve } from "node:path";

/** Stable opaque identity derived from a canonical absolute Workspace path. */
export function encodeAbsoluteCwd(absoluteCwd: string): string {
  const resolved = resolve(absoluteCwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
