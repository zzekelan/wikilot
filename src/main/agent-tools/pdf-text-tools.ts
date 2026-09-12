import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createPdfReader, type PdfInfo, type PdfText } from "./pdf-reader.ts";
import { invokePdf } from "./pdf-invocation.ts";
import { pdfParameters, pdfPagesParameters } from "./pdf-parameters.ts";

const inspectParameters = Type.Object(pdfParameters, { additionalProperties: false });

export function createInspectPdfTool(cwd: string, reader = createPdfReader()) {
  return defineTool<typeof inspectParameters, PdfInfo>({
    name: "inspect_pdf",
    label: "Inspect PDF",
    description: "Read a Workspace PDF's metadata, total page count, and embedded outline with resolved 1-based page numbers. Missing fields are null; the outline is not inferred from page text.",
    promptSnippet: "Inspect PDF metadata and outline before selecting pages to read",
    parameters: inspectParameters,
    async execute(_toolCallId, params, signal) {
      return invokePdf("inspect_pdf", params.timeout_seconds ?? 60, signal, async (signal) => {
        const result = await reader.inspect({ cwd, path: params.path, signal });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      });
    },
  });
}

export function createReadPdfTextTool(cwd: string, reader = createPdfReader()) {
  return defineTool<typeof pdfPagesParameters, PdfText>({
    name: "read_pdf_text",
    label: "Read PDF text",
    description: "Extract text from selected pages of a Workspace PDF, in the requested order, preserving page numbers and PDF.js line breaks. Does not perform OCR or reconstruct table or column layouts; use read_pdf_page for visual inspection.",
    promptSnippet: "Read PDF text from selected pages; no OCR",
    parameters: pdfPagesParameters,
    async execute(_toolCallId, params, signal) {
      return invokePdf("read_pdf_text", params.timeout_seconds ?? 60, signal, async (signal) => {
        const result = await reader.readText({ cwd, path: params.path, pages: params.pages, signal });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      });
    },
  });
}
