import { FileImage, FileText } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { remarkTexMath } from "./remark-tex-math";
import "katex/dist/katex.min.css";
import type {
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
  WorkspaceLinkTarget,
} from "../../shared/workspace";
import {
  findWikilinks,
  splitWorkspaceLinkTarget,
  workspaceHeadingSlug,
} from "../../shared/workspace";
import "./MarkdownText.css";

const WIKILINK_URL_PREFIX = "wikilot:";

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
};

type WikilinkPayload = WorkspaceLinkResolveRequest & { embed: boolean };

function remarkWikilinks() {
  return (root: MarkdownAstNode) => {
    function transform(node: MarkdownAstNode): void {
      if (["code", "inlineCode", "html", "link", "image"].includes(node.type)) return;
      if (!node.children) return;
      const children: MarkdownAstNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value?.includes("[[")) {
          transform(child);
          children.push(child);
          continue;
        }
        let cursor = 0;
        for (const token of findWikilinks(child.value)) {
          if (token.start > cursor) {
            children.push({ type: "text", value: child.value.slice(cursor, token.start) });
          }
          const parsed = token.parsed;
          const payload: WikilinkPayload = {
            syntax: "wikilink",
            authoredTarget: parsed.authoredTarget,
            ...(parsed.subpath ? { subpath: parsed.subpath } : {}),
            embed: token.embed,
          };
          children.push({
            type: "link",
            url: `${WIKILINK_URL_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`,
            children: [{
              type: "text",
              value: (parsed.displayText ?? parsed.authoredTarget) || parsed.subpath?.value || "Link",
            }],
          });
          cursor = token.end;
        }
        if (cursor < child.value.length) {
          children.push({ type: "text", value: child.value.slice(cursor) });
        }
      }
      node.children = children;
    }
    transform(root);
  };
}

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/.test(href);
}

function textContent(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textContent).join("");
  return "";
}

type ResolvedTarget = Extract<WorkspaceLinkTarget, { status: "resolved" }>;

type ResolvedLinkProps = {
  children: ReactNode;
  request: WorkspaceLinkResolveRequest;
  resolveLink: (request: WorkspaceLinkResolveRequest) => Promise<WorkspaceLinkResolution>;
  onNavigate?: (target: ResolvedTarget) => void;
  onCreateMissing?: (path: string) => Promise<void>;
  embed?: boolean;
  image?: boolean;
  revision?: number;
};

function EmbedContent({ children, image = false }: { children: ReactNode; image?: boolean }) {
  const Icon = image ? FileImage : FileText;
  return <><Icon className="md-embed-icon" size={17} aria-hidden="true" /><span className="md-embed-name">{children}</span><span className="md-embed-badge">{image ? "Image not loaded" : "Embed"}</span></>;
}

function ResolvedLink({ children, request, resolveLink, onNavigate, onCreateMissing, embed = false, image = false, revision }: ResolvedLinkProps) {
  const [resolution, setResolution] = useState<WorkspaceLinkResolution | null>(null);
  useEffect(() => {
    let current = true;
    setResolution(null);
    void resolveLink(request).then((next) => {
      if (current) setResolution(next);
    }).catch(() => {
      if (current) setResolution({
        status: "ready",
        revision: 0,
        target: { status: "invalid", reason: "resolver-error" },
      });
    });
    return () => { current = false; };
  }, [request.authoredTarget, request.sourcePath, request.syntax, request.subpath?.kind, request.subpath?.value, resolveLink, revision]);

  const imageCard = image || (embed && /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(request.authoredTarget));
  const className = embed || imageCard ? "md-internal md-embed" : "md-internal";
  const content = embed || imageCard
    ? <EmbedContent image={imageCard}>{children}</EmbedContent>
    : children;
  if (!resolution || resolution.status === "building") {
    return <span className={`${className} md-link-building`}>{content}</span>;
  }
  const target = resolution.target;
  if (imageCard) {
    const label = textContent(children) || request.authoredTarget || "Image";
    return <span className={`${className} md-image-card`} aria-label={`Image not loaded: ${label}`}>{content}</span>;
  }
  if (target.status === "resolved") {
    return (
      <a href={target.path} className={`${className} md-link-resolved`} onClick={(event) => {
        event.preventDefault();
        onNavigate?.(target);
      }}>
        {content}
      </a>
    );
  }
  if (target.status === "missing") {
    const suggestion = target.creationSuggestion?.path;
    if (suggestion && onCreateMissing) {
      return (
        <button type="button" className={`${className} md-link-missing`} onClick={() => {
          void onCreateMissing(suggestion)
            .then(() => onNavigate?.({
              status: "resolved",
              path: suggestion,
              kind: "markdown",
            }))
            .catch(() => setResolution({
              status: "ready",
              revision: resolution.revision,
              target: { status: "invalid", reason: "creation-failed" },
            }));
        }}>
          {content}
        </button>
      );
    }
    return <span className={`${className} md-link-missing`} aria-disabled="true">{content}</span>;
  }
  const title = target.status === "ambiguous"
    ? `Ambiguous link: ${target.candidates.join(", ")}`
    : `Invalid link: ${target.reason}`;
  return <span className={`${className} md-link-invalid`} role="link" aria-disabled="true" tabIndex={0} title={title}>{content}</span>;
}

export type MarkdownTextProps = {
  text: string;
  sourcePath?: string;
  resolveLink?: (request: WorkspaceLinkResolveRequest) => Promise<WorkspaceLinkResolution>;
  onNavigate?: (target: ResolvedTarget) => void;
  onCreateMissing?: (path: string) => Promise<void>;
  linkRevision?: number;
};

function MarkdownTextComponent({ text, sourcePath, resolveLink, onNavigate, onCreateMissing, linkRevision }: MarkdownTextProps) {
  const components = useMemo<Components>(() => {
    const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => ({ children }: { children?: ReactNode }) => {
      const slug = workspaceHeadingSlug(textContent(children));
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag id={slug} data-md-heading-slug={slug} className={`md-h${level}`}>{children}</Tag>;
    };
    return {
      h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6),
      p: ({ children }) => <p className="md-p">{children}</p>,
      blockquote: ({ children }) => <blockquote className="md-blockquote">{children}</blockquote>,
      strong: ({ children }) => <strong className="md-strong">{children}</strong>,
      em: ({ children }) => <em>{children}</em>,
      del: ({ children }) => <del className="md-del">{children}</del>,
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        if (isExternalHref(href)) return <a href={href} target="_blank" rel="noreferrer" className="md-a">{children}</a>;
        if (!resolveLink) return <span>{children}</span>;
        let request: WorkspaceLinkResolveRequest;
        let embed = false;
        if (href.startsWith(WIKILINK_URL_PREFIX)) {
          try {
            const payload = JSON.parse(decodeURIComponent(href.slice(WIKILINK_URL_PREFIX.length))) as WikilinkPayload;
            request = {
              ...(sourcePath ? { sourcePath } : {}),
              syntax: "wikilink",
              authoredTarget: payload.authoredTarget,
              ...(payload.subpath ? { subpath: payload.subpath } : {}),
            };
            embed = payload.embed;
            if (embed && !sourcePath) return <span>{children}</span>;
          } catch {
            return <span className="md-link-invalid">{children}</span>;
          }
        } else {
          const parsed = splitWorkspaceLinkTarget(href);
          request = {
            ...(sourcePath ? { sourcePath } : {}),
            syntax: "markdown",
            authoredTarget: parsed.authoredTarget,
            ...(parsed.subpath ? { subpath: parsed.subpath } : {}),
          };
        }
        return <ResolvedLink {...{ children, request, resolveLink, onNavigate, onCreateMissing, embed }} revision={linkRevision} />;
      },
      img: ({ src, alt }) => {
        if (!sourcePath || !src || !resolveLink || isExternalHref(src)) {
          return <span className="md-embed md-image-card" aria-label={alt ? `Image not loaded: ${alt}` : "Image not loaded"}><EmbedContent image>{alt || src || "Image"}</EmbedContent></span>;
        }
        const parsed = splitWorkspaceLinkTarget(src);
        return (
          <ResolvedLink
            request={{ ...(sourcePath ? { sourcePath } : {}), syntax: "markdown", authoredTarget: parsed.authoredTarget, ...(parsed.subpath ? { subpath: parsed.subpath } : {}) }}
            resolveLink={resolveLink}
            onNavigate={onNavigate}
            onCreateMissing={onCreateMissing}
            embed
            image
            revision={linkRevision}
          >
            {alt || parsed.authoredTarget}
          </ResolvedLink>
        );
      },
      ul: ({ children, className }) => <ul className={className?.includes("contains-task-list") ? "md-ul md-task-list" : "md-ul"}>{children}</ul>,
      ol: ({ children }) => <ol className="md-ol">{children}</ol>,
      li: ({ children, className }) => <li className={className?.includes("task-list-item") ? "md-task-item" : undefined}>{children}</li>,
      hr: () => <hr className="md-hr" />,
      table: ({ children }) => <div className="md-table-wrap"><table className="md-table">{children}</table></div>,
      thead: ({ children }) => <thead>{children}</thead>,
      tbody: ({ children }) => <tbody className="md-tbody">{children}</tbody>,
      tr: ({ children }) => <tr className="md-tr">{children}</tr>,
      th: ({ children }) => <th className="md-th">{children}</th>,
      td: ({ children }) => <td className="md-td">{children}</td>,
      pre: ({ children }) => <pre className="md-pre">{children}</pre>,
      code: ({ children, className }) => <code className={className?.startsWith("language-") ? className : "md-code"}>{children}</code>,
      input: ({ type, checked, disabled }) => type === "checkbox"
        ? <input type="checkbox" checked={Boolean(checked)} disabled={disabled} readOnly aria-label={checked ? "Completed task" : "Incomplete task"} className="checkbox md-checkbox" />
        : <input type={type} disabled={disabled} readOnly />,
    };
  }, [linkRevision, onCreateMissing, onNavigate, resolveLink, sourcePath]);

  const content = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkTexMath, remarkWikilinks]}
      rehypePlugins={[[rehypeKatex, { trust: false }]]}
      components={components}
      skipHtml
      urlTransform={(url) => url.startsWith(WIKILINK_URL_PREFIX) ? url : defaultUrlTransform(url)}
    >
      {text}
    </ReactMarkdown>
  ), [components, text]);
  return <div className="md-root">{content}</div>;
}

export const MarkdownText = memo(MarkdownTextComponent);
