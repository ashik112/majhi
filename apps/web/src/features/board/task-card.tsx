import { memo } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Kbd } from "@/components/ui/kbd";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import { DueChip } from "../tasks/schedule-chips";
import { AreaChips } from "../tasks-ui/area-chips";
import { OriginMark } from "../tasks-ui/origin-mark";
import { ProjectNames } from "../tasks-ui/project-names";
import { TrailStrip } from "../tasks-ui/trail-strip";
import { TypeTag } from "../tasks-ui/type-chip";
import { type EntryContext, rowDomId, taskOfEntry, useEntryActions } from "./entry-context";
import { lineOf, queuedMarks } from "./entry-text";
import type { RowEntry } from "./home-model";
import { KidsList } from "./kids-list";
import { RelationChips } from "./relation-chips";

const LINE_TEXT = { ...LAMP_TEXT, ok: "text-green" } as const;

/** A card that is lit carries its lamp in the frame: a tinted hairline and a faint wash from the top edge. */
const LIT = {
  needs:
    "border-[color-mix(in_srgb,var(--c-lamp-needs)_35%,transparent)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--c-lamp-needs)_8%,transparent),transparent_60%)]",
  working:
    "border-[color-mix(in_srgb,var(--c-lamp-working)_30%,transparent)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--c-lamp-working)_7%,transparent),transparent_60%)]",
  paused:
    "border-[color-mix(in_srgb,var(--c-lamp-paused)_32%,transparent)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--c-lamp-paused)_7%,transparent),transparent_60%)]",
} as const;

interface CardProps {
  entry: RowEntry;
  focused: boolean;
  selected: boolean;
  ctx: EntryContext;
  /** The place in the queue, for Up next. */
  place: number | undefined;
}

/**
 * One task on the board. A click opens it. It shows what the task is (type, id, title), where it lives
 * (workspace and projects), where it came from, one line of what it does or waits for, and what it
 * produced. The buttons show on the card the keys are on: a card does not ask for a click to open.
 */
export const TaskCard = memo(function TaskCard({ entry, focused, selected, ctx, place }: CardProps) {
  const { handlers, now } = ctx;
  const line = lineOf(entry, ctx.line);
  const task = taskOfEntry(entry, ctx.tasks);
  const rel = ctx.relations.get(entry.key);
  const { actions, busy } = useEntryActions(entry);
  const org = ctx.orgLabel(entry);
  const kids = task === undefined ? [] : (ctx.line.kids.get(task.id) ?? []);
  const showKids = kids.length > 0 && task?.children !== undefined && task.children.total > 0;
  const steps =
    task === undefined || entry.type === "done"
      ? []
      : task.trail.filter((s) => !(showKids && s.kind === "children"));
  const queued =
    entry.type === "next" || entry.type === "triage" ? queuedMarks(entry.item.task, now) : undefined;
  const areas = task === undefined ? [] : (ctx.areas.get(task.id) ?? []);
  const slim = entry.type === "done";
  const lit =
    line.lamp === "needs"
      ? LIT.needs
      : line.lamp === "paused"
        ? LIT.paused
        : entry.section === "running"
          ? LIT.working
          : undefined;
  const waits = rel !== undefined && rel.waitsOn.length > 0 && line.text === "";
  const progress = showKids && task?.children !== undefined ? task.children : undefined;
  const sweep = entry.section === "running" && !showKids && steps.length === 0;
  const showActions = actions.length > 0 && (focused || task === undefined);

  return (
    <article
      id={rowDomId(entry.key)}
      data-home-row={entry.key}
      aria-current={focused ? "true" : undefined}
      onMouseDown={() => handlers.onFocus(entry.key)}
      className={cn(
        "relative flex min-w-0 shrink-0 cursor-pointer flex-col rounded-xl border border-glass-line bg-card text-left shadow-glass backdrop-blur-[12px]",
        "transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-px hover:border-line-hover hover:shadow-pop",
        slim ? "gap-1 px-[11px] py-2" : "gap-1.5 px-[11px] py-2.5",
        lit,
        focused && "outline-2 outline-accent -outline-offset-1",
        selected && "bg-accent-wash",
      )}
    >
      <div className="flex h-5 min-w-0 items-center gap-[7px]">
        {place !== undefined && (
          <span className="w-3 shrink-0 text-right font-mono text-xs font-medium text-fg-faint">{place}</span>
        )}
        {task !== undefined && task.chat !== true && <TypeTag typing={task.typing} />}
        <span className="shrink-0 font-mono text-xs text-fg-muted">{line.id ?? ""}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <OriginMark origin={task?.origin} named={task?.origin?.kind === "finding"} />
          <span className="font-mono text-xs text-fg-faint">{line.age}</span>
        </span>
      </div>
      <h3 title={line.title} className="m-0 text-[14px] leading-[1.35] font-medium text-fg">
        <button
          type="button"
          onClick={() => handlers.onOpen(entry.key)}
          className={cn(
            "m-0 block w-full cursor-pointer p-0 text-left font-[inherit] wrap-anywhere text-inherit outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:underline",
            slim ? "line-clamp-1 text-base" : "line-clamp-2",
          )}
        >
          {line.title}
        </button>
      </h3>
      {task !== undefined && (
        <div className="flex h-[18px] min-w-0 items-center">
          <ProjectNames org={org} projects={task.repos.map((r) => r.project)} />
        </div>
      )}
      {queued?.due !== undefined && (
        <div className="flex items-center gap-1.5">
          <DueChip due={queued.due} short />
        </div>
      )}
      {waits ? (
        <RelationChips rel={rel} live={ctx.live} only="waits" />
      ) : (
        line.text !== "" && (
          <div className="flex min-h-[18px] min-w-0 items-start gap-1.5 text-sm">
            <span className="mt-[5px] shrink-0">
              <Lamp state={line.lamp} size={7} />
            </span>
            <span
              title={line.hover}
              className={cn(
                "min-w-0 wrap-anywhere",
                line.tone === undefined ? "text-fg-soft" : LINE_TEXT[line.tone],
              )}
            >
              {line.cardText ?? line.text}
              {queued?.priority === "high" && <span className="text-fg-muted">, high priority</span>}
            </span>
          </div>
        )
      )}
      {line.why !== undefined && <p className="m-0 text-sm leading-[17px] text-fg-muted">{line.why}</p>}
      {progress !== undefined && (
        <div className="flex items-center gap-2">
          <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-line-strong">
            <i
              className="block h-full rounded-full bg-lamp-done"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
          <span className="tnum font-mono text-xs text-fg-faint">
            {progress.done} of {progress.total} done
          </span>
        </div>
      )}
      {showKids && <KidsList kids={kids} onOpen={handlers.onOpenTask} />}
      {steps.length > 0 && <TrailStrip steps={steps} variant="chips" />}
      {!slim && task !== undefined && (areas.length > 0 || line.agent !== undefined) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <AreaChips names={areas} />
          {line.agent !== undefined && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-xs text-fg-faint">
              <AgentAvatar id={line.agent} size={18} decorative />@{line.agent}
            </span>
          )}
        </div>
      )}
      {sweep && (
        <div aria-hidden="true" className="relative h-[3px] overflow-hidden rounded-full bg-line-strong">
          <i className="absolute inset-y-0 left-0 w-[34%] animate-sweep rounded-full bg-gradient-to-r from-transparent via-lamp-working to-transparent" />
        </div>
      )}
      {showActions && (
        <div className="relative flex flex-wrap items-center gap-1.5 pt-0.5">
          {actions.map((spec, i) =>
            spec.kind === "wait" ? null : (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: the number is the identity of an action
                key={i}
                type="button"
                disabled={busy && i === 0}
                onClick={() => handlers.onAct(entry.key, i)}
                className={cn(
                  "inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm disabled:opacity-50",
                  i === 0 && (entry.type === "needs" || entry.type === "held")
                    ? "bg-accent text-accent-ink hover:bg-accent-hover"
                    : "border border-line-control bg-card text-fg hover:border-line-hover",
                )}
              >
                {focused && <Kbd className="h-4 min-w-4 text-[10px]">{i + 1}</Kbd>}
                <span className="truncate">{busy && i === 0 ? "Sending..." : spec.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </article>
  );
});
