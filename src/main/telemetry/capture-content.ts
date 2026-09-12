export type CaptureContentMode = "metadata" | "full";

/**
 * Acceptance may set WIKILOT_CAPTURE_CONTENT=full to include Wiki prompt
 * bodies on spans. Default stays metadata-only.
 */
export function resolveCaptureContent(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CaptureContentMode {
  const raw = env.WIKILOT_CAPTURE_CONTENT?.trim().toLowerCase();
  if (raw === "full") return "full";
  return "metadata";
}
