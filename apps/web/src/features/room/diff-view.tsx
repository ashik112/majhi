import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import {
  type AddLine,
  type CtxLine,
  collapseContext,
  type DelLine,
  type DiffContent,
  type DiffLine,
  diffLines,
  diffStats,
  splitRows,
} from "./model";

const MAX_ROWS = 400;

const LINE_STYLE: Record<"ctx" | "add" | "del", string> = {
  ctx: "text-fg-muted",
  add: "bg-green-wash text-green",
  del: "bg-red-wash text-red",
};
const SIGN = { ctx: " ", add: "+", del: "-" } as const;

/** A change to one file from its old and new text, unified or side by side. */
export function DiffView({ diff, compact = false }: { diff: DiffContent; compact?: boolean }) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [all, setAll] = useState(false);
  const lines = useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText]);
  const shown = useMemo(() => collapseContext(lines), [lines]);
  const stats = diffStats(lines);
  const visible = all ? shown : shown.slice(0, MAX_ROWS);
  const isNew = diff.oldText === undefined;

  return (
    <figure className="m-0 overflow-hidden rounded-md border border-line-strong bg-sunken">
      <figcaption className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 font-mono text-xs">
        {!compact && <span className="min-w-0 truncate text-fg-soft">{diff.path}</span>}
        {isNew && <span className="text-fg-faint">new file</span>}
        <span className="ml-auto text-green">+{stats.added}</span>
        <span className="text-red">-{stats.removed}</span>
        <button
          type="button"
          aria-pressed={mode === "split"}
          onClick={() => setMode((m) => (m === "split" ? "unified" : "split"))}
          className="rounded-xs px-1.5 py-0.5 text-fg-muted hover:bg-raised hover:text-fg"
        >
          {mode === "split" ? "Unified" : "Split"}
        </button>
      </figcaption>
      <div className="max-h-[420px] overflow-auto">
        {mode === "unified" ? <Unified lines={visible} /> : <Split lines={visible} />}
      </div>
      {!all && shown.length > MAX_ROWS && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-t border-line px-2.5 py-1.5 text-left text-xs text-fg-muted hover:text-fg"
        >
          Show {shown.length - MAX_ROWS} more lines
        </button>
      )}
    </figure>
  );
}

function Gap({ hidden }: { hidden: number }) {
  return (
    <div className="bg-raised px-2.5 py-0.5 text-center font-mono text-xs text-fg-faint">
      {hidden} unchanged {hidden === 1 ? "line" : "lines"}
    </div>
  );
}

function Unified({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <div className="min-w-max font-mono text-xs leading-5">
      {lines.map((line, i) =>
        line.kind === "gap" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
          <Gap key={i} hidden={line.hidden} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
          <div key={i} className={cn("flex px-2.5", LINE_STYLE[line.kind])}>
            <span aria-hidden="true" className="w-9 shrink-0 pr-2 text-right text-fg-faint select-none">
              {line.kind === "add" ? "" : line.oldNo}
            </span>
            <span aria-hidden="true" className="w-9 shrink-0 pr-2 text-right text-fg-faint select-none">
              {line.kind === "del" ? "" : line.newNo}
            </span>
            <span aria-hidden="true" className="w-4 shrink-0 select-none">
              {SIGN[line.kind]}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

function Split({ lines }: { lines: readonly DiffLine[] }) {
  const rows = useMemo(() => splitRows(lines), [lines]);
  return (
    <div className="min-w-max font-mono text-xs leading-5">
      {rows.map((row, i) =>
        "hidden" in row ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
          <Gap key={i} hidden={row.hidden} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
          <div key={i} className="grid grid-cols-2 divide-x divide-line">
            <SplitCell line={row.left} />
            <SplitCell line={row.right} />
          </div>
        ),
      )}
    </div>
  );
}

function SplitCell({ line }: { line: CtxLine | AddLine | DelLine | undefined }) {
  if (!line) return <div className="bg-canvas" />;
  return (
    <div className={cn("flex px-2", LINE_STYLE[line.kind])}>
      <span aria-hidden="true" className="w-8 shrink-0 pr-2 text-right text-fg-faint select-none">
        {line.kind === "add" ? line.newNo : line.oldNo}
      </span>
      <span className="whitespace-pre">{line.text}</span>
    </div>
  );
}
