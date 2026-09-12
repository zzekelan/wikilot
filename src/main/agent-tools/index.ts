import { createPdfReader } from "./pdf-reader.ts";
import { createReadPdfPageTool } from "./read-pdf-page-tool.ts";
import { createInspectPdfTool, createReadPdfTextTool } from "./pdf-text-tools.ts";
import { prepareWebAccess } from "./web-access.ts";

/** Provide Wikilot's built-in capabilities; the caller owns Pi's lifecycle. */
export function createAgentTools(cwd: string, agentDir: string) {
  const reader = createPdfReader();
  return {
    customTools: [
      createInspectPdfTool(cwd, reader),
      createReadPdfTextTool(cwd, reader),
      createReadPdfPageTool(cwd, reader),
    ],
    additionalExtensionPaths: [prepareWebAccess(agentDir)],
  };
}
