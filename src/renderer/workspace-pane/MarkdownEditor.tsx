import { useEffect, useRef } from "react";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import type {
  WorkspaceEditorSelection,
  WorkspaceLinkIndexSnapshot,
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
  WorkspaceLinkTarget,
} from "../../shared/workspace";
import { findWikilinks, splitWorkspaceLinkTarget } from "../../shared/workspace";
import { workspaceLinkCompletion } from "./markdown-completion";

type ResolvedTarget = Extract<WorkspaceLinkTarget, { status: "resolved" }>;

function positionIsExcluded(view: EditorView, position: number): boolean {
  let node = syntaxTree(view.state).resolveInner(position, -1);
  while (node) {
    const name = node.name.toLocaleLowerCase();
    if (name.includes("code") || name.includes("html") || name.includes("comment")) {
      return true;
    }
    node = node.parent!;
  }
  return false;
}

function linkRequestAt(
  view: EditorView,
  position: number,
  sourcePath: string,
): WorkspaceLinkResolveRequest | null {
  if (positionIsExcluded(view, position)) return null;
  const wikilink = findWikilinks(view.state.doc.toString()).find(
    (candidate) => position >= candidate.start && position < candidate.end,
  );
  if (wikilink) {
    return {
      sourcePath,
      syntax: "wikilink",
      authoredTarget: wikilink.parsed.authoredTarget,
      ...(wikilink.parsed.subpath ? { subpath: wikilink.parsed.subpath } : {}),
    };
  }

  let node = syntaxTree(view.state).resolveInner(position, -1);
  while (node && node.name !== "Link" && node.name !== "Image") node = node.parent!;
  if (!node || node.name !== "Link") return null;
  const raw = view.state.sliceDoc(node.from, node.to);
  const match = /^\[[\s\S]*?\]\(\s*<?([^>\s)]+)>?(?:\s+["'(][\s\S]*)?\)$/.exec(raw);
  if (!match || /^[A-Za-z][A-Za-z\d+.-]*:/.test(match[1]!)) return null;
  const parsed = splitWorkspaceLinkTarget(match[1]!);
  return {
    sourcePath,
    syntax: "markdown",
    authoredTarget: parsed.authoredTarget,
    ...(parsed.subpath ? { subpath: parsed.subpath } : {}),
  };
}

type MarkdownEditorProps = {
  content: string;
  sourcePath: string;
  selection?: WorkspaceEditorSelection;
  linkIndex: WorkspaceLinkIndexSnapshot;
  mruPaths: string[];
  resolveLink?: (request: WorkspaceLinkResolveRequest) => Promise<WorkspaceLinkResolution>;
  onNavigate?: (target: ResolvedTarget) => void;
  onCreateMissing?: (path: string) => Promise<void>;
  onChange(content: string): void;
  onSelectionChange(selection: WorkspaceEditorSelection): void;
  onContextClipSelection?(anchor: number, head: number, position: { left: number; top: number }): void;
  onContextClipInteraction?(): void;
  contextClipHighlight?: { id: number; start?: number; end?: number; clear?: boolean } | null;
  onSave(): void;
};

export function MarkdownEditor({
  content,
  sourcePath,
  selection,
  linkIndex,
  mruPaths,
  resolveLink,
  onNavigate,
  onCreateMissing,
  onChange,
  onSelectionChange,
  onContextClipSelection,
  onContextClipInteraction,
  contextClipHighlight,
  onSave,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const suppressClipCaptureRef = useRef(false);
  const callbacksRef = useRef({
    sourcePath,
    linkIndex,
    mruPaths,
    resolveLink,
    onNavigate,
    onCreateMissing,
    onChange,
    onSelectionChange,
    onContextClipSelection,
    onContextClipInteraction,
    onSave,
  });
  callbacksRef.current = {
    sourcePath,
    linkIndex,
    mruPaths,
    resolveLink,
    onNavigate,
    onCreateMissing,
    onChange,
    onSelectionChange,
    onContextClipSelection,
    onContextClipInteraction,
    onSave,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const length = content.length;
    const anchor = Math.min(selection?.anchor ?? 0, length);
    const head = Math.min(selection?.head ?? anchor, length);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        selection: EditorSelection.single(anchor, head),
        extensions: [
          lineNumbers(),
          history(),
          markdown(),
          autocompletion({
            override: [(context) => workspaceLinkCompletion(
              context,
              callbacksRef.current.linkIndex,
              callbacksRef.current.mruPaths,
            )],
          }),
          keymap.of([
            { key: "Enter", run: acceptCompletion },
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                callbacksRef.current.onSave();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            click(event, currentView) {
              if ((!event.metaKey && !event.ctrlKey) || !callbacksRef.current.resolveLink) {
                return false;
              }
              const position = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
              if (position === null) return false;
              const request = linkRequestAt(
                currentView,
                position,
                callbacksRef.current.sourcePath,
              );
              if (!request) return false;
              event.preventDefault();
              void callbacksRef.current.resolveLink(request).then(async (resolution) => {
                if (resolution.status !== "ready") return;
                if (resolution.target.status === "resolved") {
                  callbacksRef.current.onNavigate?.(resolution.target);
                  return;
                }
                const suggestion = resolution.target.status === "missing"
                  ? resolution.target.creationSuggestion?.path
                  : undefined;
                if (!suggestion || !callbacksRef.current.onCreateMissing) return;
                await callbacksRef.current.onCreateMissing(suggestion);
                callbacksRef.current.onNavigate?.({
                  status: "resolved",
                  path: suggestion,
                  kind: "markdown",
                });
              }).catch(() => {});
              return true;
            },
            scroll() {
              callbacksRef.current.onContextClipInteraction?.();
              return false;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              callbacksRef.current.onContextClipInteraction?.();
              callbacksRef.current.onChange(update.state.doc.toString());
              const cursor = update.state.selection.main.head;
              if (/\[\[[^\]\n|]+#[^\]\n]*$/.test(update.state.sliceDoc(0, cursor))) {
                queueMicrotask(() => {
                  closeCompletion(update.view);
                  startCompletion(update.view);
                });
              }
            }
            if (update.selectionSet) {
              const main = update.state.selection.main;
              callbacksRef.current.onSelectionChange({
                anchor: main.anchor,
                head: main.head,
              });
              if (suppressClipCaptureRef.current) {
                suppressClipCaptureRef.current = false;
              } else {
                callbacksRef.current.onContextClipInteraction?.();
                const start = Math.min(main.anchor, main.head);
                const end = Math.max(main.anchor, main.head);
                const hostRect = update.view.dom.getBoundingClientRect();
                const canMeasureText = typeof Range.prototype.getClientRects === "function";
                const startRect = canMeasureText ? update.view.coordsAtPos(start) : null;
                const endRect = canMeasureText ? update.view.coordsAtPos(end) : null;
                callbacksRef.current.onContextClipSelection?.(main.anchor, main.head, {
                  left: startRect && endRect
                    ? (Math.min(startRect.left, endRect.left) + Math.max(startRect.right, endRect.right)) / 2
                    : hostRect.left + hostRect.width / 2,
                  top: Math.min(startRect?.top ?? hostRect.top, endRect?.top ?? hostRect.top),
                });
              }
            }
          }),
          EditorView.theme({
            "&": { height: "100%", background: "transparent" },
            ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
            ".cm-content": { padding: "20px 24px 64px" },
            ".cm-gutters": { background: "transparent", border: "none" },
            ".cm-tooltip-autocomplete": {
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              background: "var(--color-paper)",
              color: "var(--color-ink)",
            },
            ".cm-tooltip-autocomplete > ul > li": { padding: "4px 8px" },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
              background: "color-mix(in srgb, var(--color-highlight) 14%, var(--color-paper))",
              color: "var(--color-ink)",
            },
            ".cm-completionDetail": { color: "var(--color-muted)", fontStyle: "normal" },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []); // A keyed remount intentionally discards CodeMirror undo history.

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !contextClipHighlight) return;
    const currentHead = view.state.selection.main.head;
    const start = contextClipHighlight.clear
      ? currentHead
      : Math.min(contextClipHighlight.start ?? currentHead, view.state.doc.length);
    const end = contextClipHighlight.clear
      ? currentHead
      : Math.min(contextClipHighlight.end ?? start, view.state.doc.length);
    suppressClipCaptureRef.current = true;
    view.dispatch({
      selection: { anchor: start, head: end },
      ...(typeof Range.prototype.getClientRects === "function"
        ? { effects: EditorView.scrollIntoView(start, { y: "center" }) }
        : {}),
    });
    view.focus();
  }, [contextClipHighlight?.id]);

  return <div ref={hostRef} className="workspace-markdown-editor" data-testid="markdown-editor" />;
}
