import { pdfjs } from "react-pdf";
import { isWorkspacePdfErrorCode } from "../../shared/workspace";
import { PdfSourceError } from "./pdf-errors";

type RangeFailure = (error: Error) => void;

async function responseError(response: Response, fallback: string): Promise<PdfSourceError> {
  let message = `${fallback} (${response.status})`;
  let code: unknown = response.headers.get("x-wikilot-pdf-error");
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") message = body.error;
    code = body.code ?? code;
  } catch {}
  return new PdfSourceError(message, isWorkspacePdfErrorCode(code) ? code : undefined);
}

export class HttpPdfRangeTransport extends pdfjs.PDFDataRangeTransport {
  private readonly controllers = new Set<AbortController>();
  readonly sourceUrl: string;
  private readonly onFailure: RangeFailure;

  constructor(
    sourceUrl: string,
    length: number,
    onFailure: RangeFailure,
  ) {
    super(length, null);
    this.sourceUrl = sourceUrl;
    this.onFailure = onFailure;
    this.transportReady();
  }

  requestDataRange(begin: number, end: number): void {
    const controller = new AbortController();
    this.controllers.add(controller);
    void fetch(this.sourceUrl, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
      signal: controller.signal,
      cache: "no-store",
    }).then(async (response) => {
      if (response.status !== 206) throw await responseError(response, "PDF range failed");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== end - begin) throw new Error("PDF range length is invalid");
      this.onDataRange(begin, bytes);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        this.onFailure(error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => this.controllers.delete(controller));
  }

  abort(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

export async function openHttpPdfRangeTransport(
  sourceUrl: string,
  expectedSize: number,
  signal: AbortSignal,
  onFailure: RangeFailure,
): Promise<HttpPdfRangeTransport> {
  const response = await fetch(sourceUrl, { method: "HEAD", signal, cache: "no-store" });
  if (!response.ok) throw await responseError(response, "PDF metadata failed");
  if (response.headers.get("accept-ranges") !== "bytes") {
    throw new Error("PDF source does not support byte ranges");
  }
  const size = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size !== expectedSize) {
    throw new Error("PDF source changed");
  }
  return new HttpPdfRangeTransport(sourceUrl, size, onFailure);
}
