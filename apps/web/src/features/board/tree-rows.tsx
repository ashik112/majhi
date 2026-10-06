import { ChevronRight, LoaderCircle } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import { DueChip, PriorityChip } from "../tasks/schedule-chips";
import { OriginMark } from "../tasks-ui/origin-mark";
import { ProjectNames } from "../tasks-ui/project-names";
import { TrailStrip } from "../tasks-ui/trail-strip";
import { TypeTile } from "../tasks-ui/type-chip";
import { type EntryContext, rowDomId, taskOfEntry, useEntryActions } from "./entry-context";
import { type EntryLine, lineOf, queuedMarks } from "./entry-text";
import type { RowEntry, TreeInfo } from "./home-model";
import { RelationChips } from "./relation-chips";

export { rowDomId };

/** Horizontal step of one tree level, in pixels. */
const TREE_STEP = 18;

/** The vertical guide lines of a tree row, one under each parent level. */
function Guides({ depth }: { depth: number }) {
  return Array.from({ length: depth }, (_, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: the level is the identity
      key={i}
      aria-hidden="true"
      className="absolute inset-y-0 w-px bg-line-strong"
      style={{ left: 12 + i * TREE_STEP + 8 }}
    />
  ));
}

const LINE_TEXT = { ...LAMP_TEXT, ok: "text-green" } as const;

interface RowProps {
  entry: RowEntry;
  focused: boolean;
  selected: boolean;
  ctx: EntryContext;
}

/**
 * One row of the tree: lamp, section word, id, type and title, the workspace and projects, what it
 * says and how it connects, the origin, the age and the primary button. Below 1280px the projects
 * and what it says drop to a second line, so the title keeps its room.
 */
const TreeRow = memo(function TreeRow({ entry, focused, selected, ctx }: RowProps) {
  const { handlers, now } = ctx;
  const line: EntryLine = lineOf(entry, ctx.line);
  const task = taskOfEntry(entry, ctx.tasks);
  const rel = ctx.relations.get(entry.key);
  const tree: TreeInfo | undefined = ctx.treeInfo?.get(entry.key);
  const { actions, busy } = useEntryActions(entry);
  const [first, ...others] = actions;
  const org = ctx.orgLabel(entry);
  const queued =
    entry.type === "next" || entry.type === "triage" ? queuedMarks(entry.item.task, now) : undefined;
  const projects = task?.repos.map((r) => r.project) ?? [];
  const showTrail = task !== undefined && task.trail.length > 0 && entry.type !== "done";
  const hasDetail =
    line.text !== "" ||
    line.why !== undefined ||
    queued?.priority !== undefined ||
    queued?.due !== undefined ||
    (rel !== undefined &&
      (rel.waitsOn.length > 0 || rel.blocks.length > 0 || rel.followUpOf !== undefined)) ||
    showTrail;
  const kids =
    rel === undefined || rel.total === 0
      ? undefined
      : tree !== undefined
        ? `${rel.done} of ${rel.total} done`
        : undefined;
  const wordTone = line.lamp === "idle" ? "text-fg-muted" : LAMP_TEXT[line.lamp];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row only takes the keys' place on a press; its buttons do the work
    <div
      id={rowDomId(entry.key)}
      data-home-row={entry.key}
      aria-current={focused ? "true" : undefined}
      onMouseDown={() => handlers.onFocus(entry.key)}
      className={cn(
        "group relative flex flex-wrap items-center gap-x-3 border-b border-line px-3 text-base",
        "min-h-9 py-1 transition-colors duration-100 max-[1279px]:gap-y-0",
        focused ? "bg-selected" : "hover:bg-raised",
        selected && "bg-accent-wash",
        tree?.dim && "opacity-55",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:content-['']",
        focused && "before:bg-accent",
      )}
    >
      {tree !== undefined && <Guides depth={tree.depth} />}
      <span
        className="flex h-7 items-center gap-1"
        style={tree === undefined ? undefined : { marginLeft: tree.depth * TREE_STEP }}
      >
        {tree !== undefined &&
          (tree.hasChildren && rel !== undefined ? (
            <button
              type="button"
              aria-label={tree.open ? "Fold subtasks" : "Unfold subtasks"}
              aria-expanded={tree.open}
              onClick={() => handlers.onFold(rel.task)}
              className="grid size-4 cursor-pointer place-items-center rounded-xs text-fg-faint hover:text-fg"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn("size-3.5 transition-transform", tree.open && "rotate-90")}
              />
            </button>
          ) : (
            <span className="size-4" />
          ))}
        <Lamp state={line.lamp} size={7} />
      </span>
      <span className={cn("w-[68px] shrink-0 truncate text-xs font-medium", wordTone)}>{line.word}</span>
      <span className="w-[62px] shrink-0 truncate font-mono text-xs text-fg-faint">{line.id ?? ""}</span>
      <span className="flex min-w-0 flex-[2] items-center gap-2 max-[1279px]:min-w-[60px]">
        {task !== undefined && task.chat !== true && <TypeTile typing={task.typing} size="sm" />}
        <button
          type="button"
          onClick={() => handlers.onOpen(entry.key)}
          title={line.title}
          className="m-0 min-w-0 cursor-pointer truncate p-0 text-left text-base font-medium text-fg outline-none hover:underline focus-visible:underline"
        >
          {line.title}
        </button>
        {kids !== undefined && <span className="tnum shrink-0 truncate text-xs text-fg-faint">{kids}</span>}
      </span>
      <span aria-hidden="true" className="hidden h-0 basis-full max-[1279px]:order-7 max-[1279px]:block" />
      {task !== undefined ? (
        <ProjectNames
          org={org}
          projects={projects}
          className="w-[150px] shrink-0 max-[1279px]:order-8 max-[1279px]:ml-[100px] max-[1279px]:w-auto"
        />
      ) : (
        <span className="w-[150px] shrink-0 max-[1279px]:hidden" />
      )}
      <span
        className={cn(
          "flex min-w-0 flex-[3] items-center gap-2 text-sm text-fg-soft",
          "max-[1279px]:order-9 max-[1279px]:flex-1 max-[1279px]:pb-1",
          !hasDetail && "max-[1279px]:hidden",
        )}
      >
        {queued?.priority !== undefined && <PriorityChip priority={queued.priority} compact />}
        {queued?.due !== undefined && <DueChip due={queued.due} short />}
        {(line.text !== "" || line.why !== undefined) && (
          <span
            title={line.hover ?? line.why}
            className={cn(
              "min-w-0 truncate",
              line.tone === undefined ? "text-fg-soft" : LINE_TEXT[line.tone],
            )}
          >
            {line.text}
            {line.why !== undefined && (
              <span className="text-fg-muted">{line.text === "" ? line.why : `. ${line.why}`}</span>
            )}
          </span>
        )}
        <RelationChips rel={rel} live={ctx.live} />
        {showTrail && task !== undefined && (
          <TrailStrip steps={task.trail} variant="mini" className="ml-auto" />
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {others.length > 0 && (
          <span className={cn("items-center gap-1", focused ? "flex" : "hidden group-hover:flex")}>
            {others.map((spec, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: the number is the identity of an action
                key={i}
                type="button"
                onClick={() => handlers.onAct(entry.key, i + 1)}
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
              >
                <Kbd className="h-4 min-w-4 text-[10px]">{i + 2}</Kbd>
                {spec.label}
              </button>
            ))}
          </span>
        )}
        <OriginMark origin={task?.origin} named={task?.origin?.kind === "finding"} />
        <span className="tnum w-9 text-right font-mono text-xs text-fg-faint">{line.age}</span>
        <span className="flex min-w-[84px] justify-end">
          {first?.kind === "wait" && (
            <span
              title="Checks are running"
              data-testid="row-waiting"
              className="tnum inline-flex h-7 min-w-[84px] items-center justify-center gap-1.5 text-sm text-fg-muted"
            >
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              {line.elapsed}
            </span>
          )}
          {first !== undefined && first.kind !== "wait" && (
            <Button
              size="sm"
              variant={entry.type === "needs" || entry.type === "held" ? "primary" : "secondary"}
              disabled={busy}
              onClick={() => handlers.onAct(entry.key, 0)}
              className="max-w-[168px] min-w-[84px] justify-center"
            >
              {focused && <Kbd className="h-4 min-w-4 text-[10px]">1</Kbd>}
              <span className="truncate">{busy ? "Sending..." : first.label}</span>
            </Button>
          )}
        </span>
      </span>
    </div>
  );
});

/** Draws one row of the tree. Everything it passes down is stable, so a row renders again only for its own change. */
export function EntryRow({
  entry,
  focusKey,
  selectedKeys,
  ctx,
}: {
  entry: RowEntry;
  focusKey: string | undefined;
  selectedKeys: ReadonlySet<string>;
  ctx: EntryContext;
}) {
  return (
    <TreeRow
      entry={entry}
      focused={entry.key === focusKey}
      selected={selectedKeys.has(entry.key)}
      ctx={ctx}
    />
  );
}
