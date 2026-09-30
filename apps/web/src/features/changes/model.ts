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
