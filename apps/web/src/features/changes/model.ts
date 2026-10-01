import type { RepoDiff, RepoDiffFile } from "@majhi/shared";

export type PatchRow =
  | { kind: "hunk"; text: string }
  | { kind: "ctx" | "add" | "del"; oldNo?: number; newNo?: number; text: string }
  | { kind: "note"; text: string };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/** Rows of a unified patch (hunks only, as `tasks.diff` sends it), with old and new line numbers. */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "add", newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", oldNo: oldNo++, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "note", text: line.slice(2) });
    else rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  return rows;
}

export function repoTotals(diff: RepoDiff): { files: number; additions: number; deletions: number } {
  return diff.files.reduce(
    (sum, f) => ({
      files: sum.files + 1,
      additions: sum.additions + f.additions,
      deletions: sum.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

/** "renamed from a.ts", "new file", ... for the line under a file's name. */
export function fileNote(file: RepoDiffFile): string | undefined {
  if (file.truncated) return "Too large to show here";
  if (file.binary) return "Binary file";
  if (file.status === "renamed") return `Renamed from ${file.oldPath ?? "?"}`;
  if (file.status === "added") return "New file";
  if (file.status === "deleted") return "Deleted";
  if (file.patch === "") return "No content change";
  return undefined;
}

/** One review comment, pinned to a line of a repo's diff. */
export interface ReviewComment {
  id: string;
  repo: string;
  path: string;
  /** `new` for added and unchanged lines (numbered by `newNo`), `old` for removed ones (`oldNo`). */
  side: "new" | "old";
  line: number;
  /** What the line looked like in the diff, so the comment still reads right once the line moves. */
  kind: "add" | "ctx" | "del";
  text: string;
  body: string;
}

/** Where a comment sits in a diff: its repo, file, side and line. */
export function anchorKey(at: Pick<ReviewComment, "repo" | "path" | "side" | "line">): string {
  return `${at.repo}\0${at.path}\0${at.side}:${at.line}`;
}

/** The anchors of every commentable line in the diffs, each with the line's text. */
export function diffAnchors(diffs: readonly RepoDiff[]): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const repo of diffs) {
    for (const file of repo.files) {
      for (const row of parsePatch(file.patch)) {
        if (row.kind === "hunk" || row.kind === "note") continue;
        const at = { repo: repo.project, path: file.path };
        if (row.kind === "del" && row.oldNo !== undefined) {
          anchors.set(anchorKey({ ...at, side: "old", line: row.oldNo }), row.text);
        } else if (row.kind !== "del" && row.newNo !== undefined) {
          anchors.set(anchorKey({ ...at, side: "new", line: row.newNo }), row.text);
        }
      }
    }
  }
  return anchors;
}

/** Whether the comment's line is still in the diff, with the same text. */
export function isAnchored(comment: ReviewComment, anchors: ReadonlyMap<string, string>): boolean {
  return anchors.get(anchorKey(comment)) === comment.text;
}

const QUOTE_MAX = 120;

/** The line as inline code: trimmed, capped, fenced with more backticks than the code holds. */
function quoteCode(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "(blank line)";
  const code = trimmed.length > QUOTE_MAX ? `${trimmed.slice(0, QUOTE_MAX - 1).trimEnd()}…` : trimmed;
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function commentLabel(c: ReviewComment): string {
  if (c.kind === "del") return `Old line ${c.line} (removed)`;
  return c.kind === "add" ? `Line ${c.line} (added)` : `Line ${c.line}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The message that carries a review to the agent: comments grouped by repo and file, in line order. */
export function formatReview(note: string, comments: readonly ReviewComment[]): string {
  const count = comments.length;
  const parts = [`Review of the changes: ${count} comment${count === 1 ? "" : "s"}.`];
  if (note.trim() !== "") parts.push(note.trim());
  const sorted = [...comments].sort(
    (a, b) =>
      compareText(a.repo, b.repo) ||
      compareText(a.path, b.path) ||
      a.line - b.line ||
      compareText(a.side, b.side),
  );
  let group: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) parts.push(lines.join("\n"));
  };
  for (const c of sorted) {
    const heading = `${c.repo} · ${c.path}`;
    if (heading !== group) {
      flush();
      group = heading;
      lines = [heading];
    }
    const body = c.body.trim().replace(/\r\n?/g, "\n").split("\n");
    lines.push(`- ${commentLabel(c)}: ${quoteCode(c.text)}`);
    for (const line of body) lines.push(line === "" ? "" : `  ${line}`);
  }
  flush();
  return parts.join("\n\n");
}
