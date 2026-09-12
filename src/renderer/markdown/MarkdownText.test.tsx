// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
} from "../../shared/workspace";
import { MarkdownText } from "./MarkdownText";

afterEach(cleanup);

function resolver(results: Record<string, WorkspaceLinkResolution>) {
  return vi.fn(async (request: WorkspaceLinkResolveRequest) =>
    results[request.authoredTarget] ?? {
      status: "ready" as const,
      revision: 1,
      target: { status: "invalid" as const, reason: "invalid-target" as const },
    });
}

describe("MarkdownText internal links", () => {
  it("uses resolver results for Workspace Markdown navigation and safe creation", async () => {
    const resolveLink = resolver({
      "Target.md": {
        status: "ready",
        revision: 7,
        target: { status: "resolved", path: "Target.md", kind: "markdown" },
      },
      Missing: {
        status: "ready",
        revision: 7,
        target: { status: "missing", creationSuggestion: { path: "Missing.md" } },
      },
      Duplicate: {
        status: "ready",
        revision: 7,
        target: { status: "ambiguous", candidates: ["a/Duplicate.md", "b/Duplicate.md"] },
      },
      "../escape": {
        status: "ready",
        revision: 7,
        target: { status: "invalid", reason: "workspace-escape" },
      },
    });
    const onNavigate = vi.fn();
    const onCreateMissing = vi.fn(async () => {});
    render(
      <MarkdownText
        text={"[Target](Target.md) [[Missing]] [[Duplicate]] [[../escape]] `[[code]]` <!-- [[comment]] -->"}
        sourcePath="notes/source.md"
        resolveLink={resolveLink}
        onNavigate={onNavigate}
        onCreateMissing={onCreateMissing}
      />,
    );

    fireEvent.click(await screen.findByRole("link", { name: "Target" }));
    expect(onNavigate).toHaveBeenCalledWith({
      status: "resolved",
      path: "Target.md",
      kind: "markdown",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Missing" }));
    await waitFor(() => expect(onCreateMissing).toHaveBeenCalledWith("Missing.md"));
    expect(onNavigate).toHaveBeenCalledWith({
      status: "resolved",
      path: "Missing.md",
      kind: "markdown",
    });
    expect(screen.getByText("Duplicate").getAttribute("title")).toMatch(/ambiguous/i);
    expect(screen.getByText("../escape").getAttribute("title")).toMatch(/workspace-escape/i);
    expect(resolveLink).not.toHaveBeenCalledWith(expect.objectContaining({ authoredTarget: "code" }));
    expect(resolveLink).not.toHaveBeenCalledWith(expect.objectContaining({ authoredTarget: "comment" }));
  });

  it("renders embeds and images as non-recursive cards and keeps locked links focusable", async () => {
    const resolveLink = resolver({
      Note: {
        status: "ready",
        revision: 5,
        target: { status: "resolved", path: "Note.md", kind: "markdown" },
      },
      "manual.pdf": {
        status: "ready",
        revision: 5,
        target: { status: "resolved", path: "manual.pdf", kind: "pdf" },
      },
      "photo.png": {
        status: "ready",
        revision: 5,
        target: { status: "resolved", path: "photo.png", kind: "file" },
      },
      diagram: {
        status: "ready",
        revision: 5,
        target: { status: "missing", creationSuggestion: { path: "diagram.md" } },
      },
      Duplicate: {
        status: "ready",
        revision: 5,
        target: { status: "ambiguous", candidates: ["a/Duplicate.md", "b/Duplicate.md"] },
      },
    });
    const onNavigate = vi.fn();
    const onCreateMissing = vi.fn(async () => {});
    render(
      <MarkdownText
        text={"![[Note]]\n\n![[manual.pdf]]\n\n![[photo.png]]\n\n![Local](diagram)\n\n![Remote](https://example.com/photo.png)\n\n[[Duplicate]]"}
        sourcePath="source.md"
        resolveLink={resolveLink}
        onNavigate={onNavigate}
        onCreateMissing={onCreateMissing}
      />,
    );

    const note = await screen.findByRole("link", { name: /Note.*Embed/ });
    expect(note.classList.contains("md-embed")).toBe(true);
    fireEvent.click(note);
    expect(onNavigate).toHaveBeenCalledWith({
      status: "resolved", path: "Note.md", kind: "markdown",
    });
    expect(screen.getByRole("link", { name: /manual\.pdf.*Embed/ })).toBeTruthy();
    const localImage = screen.getByLabelText("Image not loaded: Local");
    const wikilinkImage = screen.getByLabelText("Image not loaded: photo.png");
    expect(screen.getByLabelText("Image not loaded: Remote")).toBeTruthy();
    fireEvent.click(localImage);
    fireEvent.click(wikilinkImage);
    expect(onCreateMissing).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("img")).toBeNull();

    const locked = await screen.findByRole("link", { name: "Duplicate" });
    expect(locked.getAttribute("tabindex")).toBe("0");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(locked, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("keeps Timeline missing links unavailable and external links external", async () => {
    const resolveLink = resolver({
      Missing: {
        status: "ready",
        revision: 2,
        target: { status: "missing", creationSuggestion: { path: "Missing.md" } },
      },
    });
    render(
      <MarkdownText
        text={"[[Missing]] [OpenAI](https://openai.com)"}
        resolveLink={resolveLink}
        onNavigate={vi.fn()}
      />,
    );

    expect((await screen.findByText("Missing")).getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: "Missing" })).toBeNull();
    expect(screen.getByRole("link", { name: "OpenAI" }).getAttribute("href")).toBe("https://openai.com");
    expect(resolveLink).not.toHaveBeenCalledWith(
      expect.objectContaining({ authoredTarget: "https://openai.com" }),
    );
  });
});

describe("MarkdownText math", () => {
  it("typesets the reported attention formula with TeX display delimiters", () => {
    const formula = String.raw`\mathrm{MaskedAttn}(Q,K,V) =\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}+M\right)V`;
    const { container } = render(<MarkdownText text={`书中的注意力公式是：\n\n\\[\n${formula}\n\\]`} />);
    expect(container.querySelector(".katex-display math")).not.toBeNull();
    expect(container.querySelector("annotation")?.textContent).toBe(formula);
  });
});

describe("MarkdownText math boundaries", () => {
  it.each([
    [String.raw`行内 \(x_i^2\) 公式`, false],
    ["行内 $x_i^2$ 公式", false],
    ["$$\nx_i^2\n$$", true],
    [String.raw`\[x_i^2\]`, true],
    ["> \\[\n> x_i^2\n> \\]", true],
    ["- 行内 \\(x_i^2\\)", false],
  ])("renders supported delimiters: %s", (text, display) => {
    const { container } = render(<MarkdownText text={text} />);
    expect(container.querySelectorAll("math")).toHaveLength(1);
    expect(container.querySelector("annotation")?.textContent).toBe("x_i^2");
    expect(Boolean(container.querySelector(".katex-display"))).toBe(display);
  });

  it("preserves code, escaped delimiters, ordinary brackets, and escaped currency", () => {
    const text = [
      String.raw`\`\(x_i\)\``,
      "```tex\n\\[x_i\\]\n$x$\n```",
      "    \\[x_i\\]",
      String.raw`\\(literal\\) [ordinary] (brackets) \$5 and \$10`,
    ].join("\n\n").replaceAll("\\`", "`");
    const { container } = render(<MarkdownText text={text} />);
    expect(container.querySelector("math")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(String.raw`\(x_i\)`);
    expect(container.textContent).toContain("$5 and $10");
  });

  it("recovers when streaming completes a delimiter or a malformed expression", () => {
    const { container, rerender } = render(<MarkdownText text={String.raw`Before \[\frac{1}`} />);
    expect(container.querySelector("math")).toBeNull();
    rerender(<MarkdownText text={String.raw`Before \[\frac{1}\] After`} />);
    expect(container.querySelector(".katex-error")).not.toBeNull();
    expect(container.textContent).toContain("After");
    rerender(<MarkdownText text={String.raw`Before \[\frac{1}{2}\] After`} />);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.querySelector("math")).not.toBeNull();
  });

  it("keeps TeX commands opaque to Markdown and does not enable trusted HTML or URLs", () => {
    const resolveLink = vi.fn();
    const { container } = render(<MarkdownText
      text={String.raw`\(\text{[[Note]]} + a_* b_*\) $\href{javascript:alert(1)}{unsafe}$`}
      resolveLink={resolveLink}
    />);
    expect(container.querySelector("annotation")?.textContent).toBe(String.raw`\text{[[Note]]} + a_* b_*`);
    expect(resolveLink).not.toHaveBeenCalled();
    expect(container.querySelector("a, img, script")).toBeNull();
  });
});
