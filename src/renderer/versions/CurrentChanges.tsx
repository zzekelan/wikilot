import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { VersionChange, VersionFileDiff, VersionsSnapshot } from "../../shared/versions";
import { client } from "../client";
import { recordUiGesture } from "../telemetry";
import "./CurrentChanges.css";

export function CurrentChanges({ workspaceId, snapshot }: { workspaceId: string; snapshot: VersionsSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<VersionChange[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<VersionFileDiff | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!expanded || !snapshot.changedFiles) return;
    let cancelled = false;
    setError(""); setDiff(null);
    void (async () => {
      try {
        const next = await client.getVersionChanges(workspaceId);
        if (cancelled) return;
        setFiles(next);
        if (selected && next.some(file => file.path === selected)) {
          const result = await client.getVersionFileDiff(workspaceId, selected);
          if (!cancelled) setDiff(result);
        } else setSelected(null);
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); }
    })();
    return () => { cancelled = true; };
  }, [expanded, workspaceId, snapshot, selected]);

  if (!snapshot.changedFiles) return <div className="versions-status">{snapshot.changedFiles === null ? "No versions yet" : "No changes"}</div>;
  return <div className="versions-changes">
    <button type="button" className="versions-text-button versions-status versions-changes-toggle" aria-expanded={expanded}
      aria-controls="versions-current-files" onClick={() => { setExpanded(!expanded); if (!expanded) recordUiGesture("versions.changes.open", { "wikilot.gesture": "versions.changes.open" }); }}>
      <span>{snapshot.changedFiles} changed {snapshot.changedFiles === 1 ? "file" : "files"}</span><ChevronRight size={13} aria-hidden="true" className={expanded ? "versions-expanded" : ""} />
    </button>
    {expanded ? <div id="versions-current-files" className="versions-current-files">
      {error ? <div className="versions-diff-error" role="alert">{error}</div> : null}
      {!files && !error ? <div className="versions-diff-note">Loading…</div> : null}
      {files?.map(file => <div key={file.path} className="versions-file">
        <button type="button" className="versions-file-toggle" aria-expanded={selected === file.path} onClick={() => { setDiff(null); setSelected(selected === file.path ? null : file.path); }}>
          <ChevronRight size={12} aria-hidden="true" className={selected === file.path ? "versions-expanded" : ""} /><span className="versions-file-path">{file.path}</span><span className="versions-file-kind">{file.kind}</span>
        </button>
        {selected === file.path ? <DiffPreview path={file.path} diff={diff} failed={Boolean(error)} /> : null}
      </div>)}
    </div> : null}
  </div>;
}

function DiffPreview({ path, diff, failed }: { path: string; diff: VersionFileDiff | null; failed: boolean }) {
  if (!diff) return failed ? null : <div className="versions-diff-note">Loading…</div>;
  if (diff.unavailable || !diff.patch) return <div className="versions-diff-note">{diff.unavailable || "No net content changes"}</div>;
  const patchLines = diff.patch.replace(/\n$/, "").split("\n");
  const firstHunk = patchLines.findIndex(line => line.startsWith("@@"));
  const lines = firstHunk >= 0 ? patchLines.slice(firstHunk)
    : patchLines.filter(line => !/^(diff --git |index |--- |\+\+\+ )/.test(line));
  return <pre className="versions-diff" aria-label={`Current changes in ${path}`}>{lines.map((line, index) => <span key={index}
    className={line.startsWith("+") ? "versions-diff-added" : line.startsWith("-") ? "versions-diff-removed" : line.startsWith("@@") ? "versions-diff-hunk" : undefined}>{line}{"\n"}</span>)}</pre>;
}
