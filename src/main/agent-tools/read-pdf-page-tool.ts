import { defineTool } from "@earendil-works/pi-coding-agent";
import { setReadPdfPageToolCompletion } from "../telemetry/index.ts";
import { createPdfReader } from "./pdf-reader.ts";
import { invokePdf } from "./pdf-invocation.ts";
import { pdfPagesParameters as parameters } from "./pdf-parameters.ts";

type ReadPdfPageDetails = {
  path: string;
  pageCount: number;
  pages: Array<{ page: number; width: number; height: number }>;
};

export function createReadPdfPageTool(
  cwd: string,
  reader: Pick<ReturnType<typeof createPdfReader>, "render"> = createPdfReader(),
) {
  return defineTool<typeof parameters, ReadPdfPageDetails>({
    name: "read_pdf_page",
    label: "Read PDF pages",
    description: "Render selected pages of a Workspace PDF as PNG images for visual inspection, in the requested order.",
    promptSnippet: "Render selected PDF pages as images",
    parameters,
    async execute(toolCallId, params, turnSignal, _onUpdate, context) {
      const timeoutSeconds = params.timeout_seconds ?? 60;
      return invokePdf("read_pdf_page", timeoutSeconds, turnSignal, async (signal) => {
        const rendered = await reader.render({ cwd, path: params.path, pages: params.pages, signal });
        const details: ReadPdfPageDetails = {
          path: rendered.path,
          pageCount: rendered.pageCount,
          pages: rendered.pages.map(({ page, width, height }) => ({ page, width, height })),
        };
        const summary = rendered.pages.map((page, index) =>
          `Image ${index + 1}: Rendered ${rendered.path} page ${page.page} of ${rendered.pageCount} at ${page.width}×${page.height}.`,
        ).join("\n");
        const supportsImages = context.model?.input.includes("image") ?? false;
        const text = supportsImages ? summary : `${summary}\n[Current model does not support images. The image will be omitted from this request.]`;
        setReadPdfPageToolCompletion({
          toolCallId, outcome: "success", timeoutSeconds,
          imageCount: rendered.pages.length, imageMimeType: "image/png",
          ...(rendered.pages.length === 1 ? {
            imageWidth: rendered.pages[0]!.width, imageHeight: rendered.pages[0]!.height,
          } : {}),
        });
        return {
          content: [
            { type: "text" as const, text },
            ...rendered.pages.map((page) => ({
              type: "image" as const,
              data: Buffer.from(page.png).toString("base64"), mimeType: "image/png" as const,
            })),
          ],
          details,
        };
      }, (error) => {
        if (error.code === "cancelled") {
          setReadPdfPageToolCompletion({ toolCallId, outcome: "cancelled", timeoutSeconds, errorCode: "cancelled" });
        } else if (error.code === "timeout") {
          setReadPdfPageToolCompletion({ toolCallId, outcome: "timeout", timeoutSeconds, errorCode: "timeout" });
        } else {
          setReadPdfPageToolCompletion({ toolCallId, outcome: "error", timeoutSeconds, errorCode: error.code });
        }
      });
    },
  });
}
