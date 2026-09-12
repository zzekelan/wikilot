import { describe, expect, it } from "vitest";
import { pdfDocumentOptions } from "./pdf-document-options";

describe("pdfDocumentOptions", () => {
  it("points at locally served CMap and standard font assets", () => {
    expect(pdfDocumentOptions()).toEqual({
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    });
  });
});
