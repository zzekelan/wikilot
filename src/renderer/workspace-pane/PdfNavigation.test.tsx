/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfNavigation } from "./PdfNavigation";

vi.mock("../telemetry", () => ({ recordUiGesture: vi.fn() }));
afterEach(cleanup);

describe("PDF navigation", () => {
  it("finds matches on unrendered pages and follows a named outline destination", async () => {
    const getPage = vi.fn(async (number: number) => ({
      getTextContent: async () => ({ items: [{ str: number === 3 ? "Final evidence for review" : "Background material", transform: [1, 0, 0, 1, 72, 500] }] }),
      getViewport: () => ({ height: 792, convertToViewportPoint: () => [72, 292] }),
    }));
    const pdf = {
      numPages: 3, getPage,
      getOutline: async () => [{ title: "Findings", dest: "findings", items: [] }],
      getDestination: async () => [{ num: 8, gen: 0 }],
      getPageIndex: async () => 2,
    } as unknown as PDFDocumentProxy;
    const onNavigate = vi.fn();
    render(<PdfNavigation document={pdf} onNavigate={onNavigate} />);
    expect(getPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search PDF" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "evidence" } });
    const hit = await screen.findByRole("button", { name: /Page 3.*evidence/ });
    fireEvent.click(hit);
    expect(onNavigate).toHaveBeenLastCalledWith(3, (292 - 30) / 792, "evidence");
    await waitFor(() => expect(screen.getByText("1 match")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Findings" }));
    await waitFor(() => expect(onNavigate).toHaveBeenLastCalledWith(3, 0));
  });
});
