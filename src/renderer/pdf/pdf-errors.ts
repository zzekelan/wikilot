import {
  isWorkspacePdfErrorCode,
  type WorkspacePdfErrorCode,
} from "../../shared/workspace";

export class PdfSourceError extends Error {
  readonly code?: WorkspacePdfErrorCode;

  constructor(message: string, code?: WorkspacePdfErrorCode) {
    super(message);
    this.name = "PdfSourceError";
    this.code = code;
  }
}

export function pdfErrorCode(error: unknown): WorkspacePdfErrorCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return isWorkspacePdfErrorCode(code) ? code : undefined;
}

export function pdfFailurePresentation(error: Error & { code?: unknown }): {
  title: string;
  detail: string;
} {
  switch (pdfErrorCode(error)) {
    case "too-large":
      return { title: "PDF is too large", detail: error.message };
    case "source-changed":
      return { title: "PDF source changed", detail: "Reload the file to continue reading." };
    case "deleted":
      return { title: "PDF was deleted", detail: "The tab remains open and can be retried." };
    case "unavailable":
      return { title: "PDF is unavailable", detail: error.message };
  }
  if (/invalid pdf|damaged|missing pdf/i.test(error.message)) {
    return { title: "PDF is damaged", detail: error.message };
  }
  return { title: "PDF could not be loaded", detail: error.message };
}
