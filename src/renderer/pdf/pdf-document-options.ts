/**
 * pdf.js options required for CJK and other non-Latin Workspace PDFs.
 * CMaps and standard fonts are served by `vite-plugin-pdfjs-assets`.
 */
export function pdfDocumentOptions() {
  return {
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true as const,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  };
}
