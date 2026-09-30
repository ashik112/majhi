import { MessageSquarePlus } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { CommentEditor, CommentItem } from "./comment-box";
import { anchorKey, type PatchRow, parsePatch, type ReviewComment } from "./model";
import { reviewStore, useReviewDraft } from "./review-store";

const LINE_STYLE = {
  ctx: "text-fg-muted",
  add: "bg-green-wash text-green",
  del: "bg-red-wash text-red",
} as const;
const SIGN = { ctx: " ", add: "+", del: "-" } as const;

type LineRow = Extract<PatchRow, { kind: "ctx" | "add" | "del" }>;

/** Where a row takes a comment: removed lines by their old number, every other by the new one. */
function rowAnchor(row: LineRow): { side: "new" | "old"; line: number } | undefined {
  const line = row.kind === "del" ? row.oldNo : row.newNo;
  return line === undefined ? undefined : { side: row.kind === "del" ? "old" : "new", line };
}

function describe(row: LineRow, line: number): string {
  return row.kind === "del" ? `removed line ${line}` : `line ${line}`;
}

/** One file's git patch, unified, with line numbers. With `review`, each line takes comments. */
export function PatchView({
  patch,
  review,
}: {
  patch: string;
  review?: { task: string; repo: string; path: string };
}) {
  const rows = useMemo<PatchRow[]>(() => parsePatch(patch), [patch]);
  const draft = useReviewDraft(review?.task ?? "");
  // `new:<anchor>` opens a box under that line, `edit:<id>` edits a saved comment.
  const [open, setOpen] = useState<string | undefined>();

  const byLine = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    if (!review) return map;
    for (const c of draft.comments) {
      if (c.repo !== review.repo || c.path !== review.path) continue;
      const key = anchorKey(c);
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return map;
  }, [draft.comments, review]);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-max font-mono text-xs leading-5">
        {rows.map((row, i) => {
          if (row.kind === "hunk") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
              <div key={i} className="bg-raised px-2.5 py-0.5 text-fg-faint">
                {row.text}
              </div>
            );
          }
          if (row.kind === "note") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
              <div key={i} className="px-2.5 text-fg-faint italic">
                {row.text}
              </div>
            );
          }
          const at = review ? rowAnchor(row) : undefined;
          const key = review && at ? anchorKey({ repo: review.repo, path: review.path, ...at }) : undefined;
          // A comment stays under its line only while the line still reads the same.
          const saved = key ? (byLine.get(key) ?? []).filter((c) => c.text === row.text) : [];
          const composing = key !== undefined && open === `new:${key}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
            <Fragment key={i}>
              <div className={cn("group/row relative flex px-2.5", LINE_STYLE[row.kind])}>
                {review && at ? (
                  <button
                    type="button"
                    aria-label={`Comment on ${describe(row, at.line)}`}
                    onClick={() => setOpen(`new:${key}`)}
                    className="mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center self-center rounded text-fg-muted opacity-0 transition-opacity hover:bg-selected hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100"
                  >
                    <MessageSquarePlus aria-hidden="true" className="size-3.5" />
                  </button>
                ) : review ? (
                  <span aria-hidden="true" className="mr-1 size-5 shrink-0" />
                ) : null}
                <span aria-hidden="true" className="w-9 shrink-0 pr-2 text-right text-fg-faint select-none">
                  {row.oldNo}
                </span>
                <span aria-hidden="true" className="w-9 shrink-0 pr-2 text-right text-fg-faint select-none">
                  {row.newNo}
                </span>
                <span aria-hidden="true" className="w-4 shrink-0 select-none">
                  {SIGN[row.kind]}
                </span>
                <span className="whitespace-pre">{row.text}</span>
              </div>
              {review && at && key && (saved.length > 0 || composing) && (
                <div className="sticky left-0 flex w-[min(40rem,80vw)] flex-col gap-1.5 px-2.5 py-1.5 font-sans">
                  {saved.map((c) =>
                    open === `edit:${c.id}` ? (
                      <CommentEditor
                        key={c.id}
                        label={`Edit comment on ${describe(row, at.line)}`}
                        initial={c.body}
                        onSave={(body) => {
                          reviewStore.edit(review.task, c.id, body);
                          setOpen(undefined);
                        }}
                        onCancel={() => setOpen(undefined)}
                      />
                    ) : (
                      <CommentItem
                        key={c.id}
                        comment={c}
                        onEdit={() => setOpen(`edit:${c.id}`)}
                        onDelete={() => reviewStore.remove(review.task, c.id)}
                      />
                    ),
                  )}
                  {composing && (
                    <CommentEditor
                      label={`Comment on ${describe(row, at.line)}`}
                      onSave={(body) => {
                        reviewStore.add(review.task, {
                          repo: review.repo,
                          path: review.path,
                          side: at.side,
                          line: at.line,
                          kind: row.kind,
                          text: row.text,
                          body,
                        });
                        setOpen(undefined);
                      }}
                      onCancel={() => setOpen(undefined)}
                    />
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
