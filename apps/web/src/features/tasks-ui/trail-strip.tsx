import type { TrailStep } from "@majhi/shared";
import { ArrowUpToLine, Check, GitMerge, GitPullRequest, ListChecks, ListTree, Mail } from "lucide-react";
import { Fragment, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Lamp, type LampState } from "@/components/ui/lamp";
import { Menu } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { fitFor, type StepView, type StripFit, stepTitle, stepViews, TONE_LAMP } from "./trail-model";

const STEP_ICON = {
  children: ListTree,
  check: ListChecks,
  "merge-request": GitPullRequest,
  "local-merge": GitMerge,
  ship: GitMerge,
  deploy: ArrowUpToLine,
  reply: Mail,
} as const;

/** The gap between the pieces of one step, in pixels: the width a hidden label gives back besides its own. */
const STEP_GAP = 4;

function StepMark({ view }: { view: StepView }): ReactNode {
  return view.tone === "done" ? (
    <Check aria-hidden="true" className="size-3 shrink-0 text-lamp-done" strokeWidth={2.5} />
  ) : (
    <Lamp state={TONE_LAMP[view.tone]} size={6} />
  );
}

const WORD_COLOR: Record<LampState, string> = {
  needs: "text-lamp-needs",
  paused: "text-lamp-paused",
  working: "text-lamp-working",
  done: "text-lamp-done",
  idle: "text-fg-faint",
};

/** What one step looks like in the strip. `label` false keeps only the icon and the mark. */
function StepBody({ view, label }: { view: StepView; label: boolean }) {
  const Icon = STEP_ICON[view.kind];
  return (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span data-label={view.tone === "done" ? "done" : "kept"} className={cn(!label && "hidden")}>
        {view.label}
      </span>
      {view.waiting && <span className={WORD_COLOR[TONE_LAMP[view.tone]]}>{view.word}</span>}
      <StepMark view={view} />
    </>
  );
}

const STEP_BASE =
  "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] px-1.5 text-sm";
const stepClass = (view: StepView) =>
  cn(
    STEP_BASE,
    view.tone === "done" ? "text-fg-muted" : "text-fg-soft",
    view.waiting &&
      "bg-[color-mix(in_srgb,var(--c-lamp-needs)_8%,transparent)] px-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--c-lamp-needs)_35%,transparent)]",
    view.tone === "paused" &&
      "bg-[color-mix(in_srgb,var(--c-lamp-paused)_8%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--c-lamp-paused)_35%,transparent)]",
  );

/** What a step does when pressed. A step with no action is a plain label. */
export interface TrailActions {
  /** Open a subtask. */
  onOpenTask?: (id: string) => void;
  /** Show the room, where the check and the merge are. */
  onShowRoom?: () => void;
}

function StepButton({ view, actions }: { view: StepView; actions: TrailActions }) {
  const title = stepTitle(view);
  const step = view.step;
  const body = <StepBody view={view} label />;
  if (step.kind === "children" && step.items !== undefined && actions.onOpenTask !== undefined) {
    const open = actions.onOpenTask;
    return (
      <Menu
        label="Open a subtask"
        align="right"
        maxHeight={420}
        items={step.items.map((child) => ({
          label: `${child.id}  ${child.title}`,
          checked: child.tone === "done",
          onSelect: () => open(child.id),
        }))}
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            {...props}
            title={title}
            className={cn(stepClass(view), "cursor-pointer hover:bg-raised")}
          >
            <StepBody view={view} label />
          </button>
        )}
      />
    );
  }
  if (step.kind === "merge-request" && step.mrs[0] !== undefined) {
    return (
      <a
        href={step.mrs[0].url}
        target="_blank"
        rel="noreferrer"
        title={title}
        className={cn(stepClass(view), "cursor-pointer hover:bg-raised")}
      >
        {body}
      </a>
    );
  }
  if (
    actions.onShowRoom !== undefined &&
    (step.kind === "check" || step.kind === "local-merge" || step.kind === "ship")
  ) {
    return (
      <button
        type="button"
        onClick={actions.onShowRoom}
        title={title}
        className={cn(stepClass(view), "cursor-pointer hover:bg-raised")}
      >
        {body}
      </button>
    );
  }
  return (
    <span title={title} className={stepClass(view)}>
      {body}
    </span>
  );
}

/** One step as a chip with a border, for a card: icon, label and the state in a word. */
function StepChip({ view }: { view: StepView }) {
  const Icon = STEP_ICON[view.kind];
  return (
    <span
      title={stepTitle(view)}
      className={cn(
        "inline-flex h-5 max-w-full min-w-0 items-center gap-1 whitespace-nowrap rounded-md border bg-raised px-1.5 text-xs text-fg-soft",
        view.tone === "needs" && "border-[color-mix(in_srgb,var(--c-lamp-needs)_40%,transparent)]",
        view.tone === "working" && "border-[color-mix(in_srgb,var(--c-lamp-working)_35%,transparent)]",
        view.tone === "paused" && "border-[color-mix(in_srgb,var(--c-lamp-paused)_40%,transparent)]",
        view.tone !== "needs" && view.tone !== "working" && view.tone !== "paused" && "border-line-strong",
        view.tone === "idle" && "border-dashed",
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
      <span className="min-w-0 truncate">{view.label}</span>
      {view.tone === "done" ? (
        <StepMark view={view} />
      ) : (
        <>
          <Lamp state={TONE_LAMP[view.tone]} size={6} />
          <span className={cn("shrink-0", WORD_COLOR[TONE_LAMP[view.tone]])}>{view.word}</span>
        </>
      )}
    </span>
  );
}

/** One step as an icon with its label, for a row: finished steps keep only the icon and the check. */
function StepMini({ view }: { view: StepView }) {
  return (
    <span
      title={stepTitle(view)}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 text-sm",
        view.tone === "done" ? "text-fg-muted" : "text-fg-soft",
      )}
    >
      <StepBody view={view} label={view.tone !== "done"} />
    </span>
  );
}

/**
 * What a task produced, in the order it produced it: one step each for its subtasks, its checks, its
 * merge request or merge, and (later) its deploys and its reply to the client. One component for every
 * screen, in three shapes:
 *
 * - `bar` is the task page's strip on the tabs row. It measures itself against the room it has:
 *   finished steps lose their label first, the step that waits keeps its label and its word, and a
 *   strip that is still too wide takes its own line under the tabs.
 * - `chips` is for a card, which wraps.
 * - `mini` is for a row of the tree: finished steps are an icon and a check, the others keep their label.
 */
export function TrailStrip({
  steps,
  variant,
  actions = {},
  className,
}: {
  steps: readonly TrailStep[];
  variant: "bar" | "chips" | "mini";
  actions?: TrailActions;
  className?: string;
}) {
  const views = useMemo(() => stepViews(steps), [steps]);
  if (views.length === 0) return null;
  if (variant === "chips")
    return (
      <span className={cn("flex min-w-0 flex-wrap gap-1", className)}>
        {views.map((v) => (
          <StepChip key={v.key} view={v} />
        ))}
      </span>
    );
  if (variant === "mini")
    return (
      <span className={cn("flex min-w-0 shrink-0 items-center", className)}>
        {views.map((v) => (
          <StepMini key={v.key} view={v} />
        ))}
      </span>
    );
  return <TrailBar views={views} actions={actions} className={className} />;
}

/**
 * The bar. Its slot is a flex item of the tabs row that takes what the tabs and the links leave. A
 * copy of the strip with every label, hidden and outside the layout, gives the natural widths; the
 * slot's own width is the room. The choice is made again whenever either changes.
 */
function TrailBar({
  views,
  actions,
  className,
}: {
  views: readonly StepView[];
  actions: TrailActions;
  className?: string | undefined;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  const twin = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<StripFit>("full");

  // biome-ignore lint/correctness/useExhaustiveDependencies: the steps are the trigger: a new label changes the widths
  useLayoutEffect(() => {
    const room = slot.current;
    const copy = twin.current;
    if (room === null || copy === null) return;
    const measure = () => {
      const doneLabels = [...copy.querySelectorAll<HTMLElement>('[data-label="done"]')].reduce(
        (sum, el) => sum + el.getBoundingClientRect().width + STEP_GAP,
        0,
      );
      const next = fitFor({
        available: room.getBoundingClientRect().width,
        full: copy.getBoundingClientRect().width,
        doneLabels,
      });
      setFit((now) => (now === next ? now : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(room);
    observer.observe(copy);
    return () => observer.disconnect();
  }, [views]);

  const strip = (
    <span
      className={cn(
        "flex min-w-0 items-center justify-end gap-0.5",
        fit === "line" && "w-full flex-wrap justify-start",
      )}
    >
      {views.map((v) => (
        <Fragment key={v.key}>
          <StepButton view={v} actions={actions} />
        </Fragment>
      ))}
    </span>
  );
  // Short: the label of a finished step is hidden by CSS from this attribute, so the button keeps its place.
  const shown = (
    <span data-fit={fit} className="contents [&[data-fit=short]_[data-label=done]]:hidden">
      {strip}
    </span>
  );

  return (
    <>
      <span
        ref={slot}
        className={cn("relative flex min-w-0 flex-1 items-center justify-end self-center", className)}
      >
        {fit !== "line" && shown}
        <span
          ref={twin}
          aria-hidden="true"
          className="pointer-events-none invisible fixed top-0 left-0 flex w-max items-center gap-0.5"
        >
          {views.map((v) => (
            <span key={v.key} className={stepClass(v)}>
              <StepBody view={v} label />
            </span>
          ))}
        </span>
      </span>
      {fit === "line" && <span className="order-last flex basis-full justify-start pb-1">{shown}</span>}
    </>
  );
}
