import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { type PatchRow, parsePatch } from "./model";

const LINE_STYLE = {
  ctx: "text-fg-muted",
  add: "bg-green-wash text-green",
  del: "bg-red-wash text-red",
} as const;
const SIGN = { ctx: " ", add: "+", del: "-" } as const;

/** One file's git patch, unified, with line numbers. */
export function PatchView({ patch }: { patch: string }) {
  const rows = useMemo<PatchRow[]>(() => parsePatch(patch), [patch]);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-max font-mono text-xs leading-5">
        {rows.map((row, i) =>
          row.kind === "hunk" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
            <div key={i} className="bg-raised px-2.5 py-0.5 text-fg-faint">
              {row.text}
            </div>
          ) : row.kind === "note" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
            <div key={i} className="px-2.5 text-fg-faint italic">
              {row.text}
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
            <div key={i} className={cn("flex px-2.5", LINE_STYLE[row.kind])}>
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
          ),
        )}
      </div>
    </div>
  );
}
