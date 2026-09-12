import { PdfReadError } from "./pdf-reader.ts";

/** One invocation owns its timeout and observes the Pi Turn's cancellation. */
export async function invokePdf<T>(
  toolName: string,
  timeoutSeconds: number,
  turnSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  onError?: (error: PdfReadError) => void,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new PdfReadError("cancelled", "Turn cancellation stopped the invocation."));
  if (turnSignal?.aborted) cancel();
  else turnSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new PdfReadError(
    "timeout", `Reading exceeded ${timeoutSeconds} seconds; retry with timeout_seconds up to 600.`,
  )), timeoutSeconds * 1_000);
  timer.unref();
  try {
    return await operation(controller.signal);
  } catch (cause) {
    const error = cause instanceof PdfReadError ? cause : new PdfReadError(
      toolName === "read_pdf_page" ? "render_failed" : "read_failed",
      toolName === "read_pdf_page"
        ? "The PDF page could not be rendered; retry or choose another PDF."
        : "The PDF could not be read; retry or choose another PDF.",
    );
    onError?.(error);
    throw new Error(`${toolName} error [${error.code}]: ${error.message}`);
  } finally {
    clearTimeout(timer);
    turnSignal?.removeEventListener("abort", cancel);
  }
}
