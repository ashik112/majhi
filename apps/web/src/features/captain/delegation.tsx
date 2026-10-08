import {
  type Authority,
  type AuthorityChoice,
  type AuthorityRow,
  type AutonomyStatus,
  type CaptainOrg,
  type CaptainStatus,
  CHORE_LABEL,
  FULL_ACCESS_KEEPS,
  FULL_ACCESS_NEVER,
  PRIVATE,
  TASKS_AT_ONCE,
  type TaskSizeLimit,
} from "@majhi/shared";
import { Check, ChevronRight, MoreHorizontal, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lamp } from "@/components/ui/lamp";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { useExclude } from "@/features/autonomy/desk";
import { clockTime } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { parseDollars } from "@/features/usage/budget-model";
import { useAutonomyCommand, useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainCommand, useCaptainRules } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useAccounts } from "@/lib/studio-queries";
import { AUTHORITY_PRESETS, AUTHORITY_ROW_TEXT, AUTHORITY_ROWS_ORDER } from "./model";
import { MoreRules } from "./more-rules";
import { useStartReview } from "./review-now";
import { ShipRules } from "./ship-rules";

const FIRST_COLUMN = "w-[184px] shrink-0";
const COLUMN = "w-[116px] shrink-0";

const SIZES: readonly { value: TaskSizeLimit; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Up to medium" },
  { value: "any", label: "Any size" },
];

const SIZE_HELP: Record<TaskSizeLimit, string> = {
  small: "Only small changes in one or two files.",
  medium: "Features and fixes across several files, not big designs or hunts.",
  any: "Large tasks too. The captain splits them when that helps.",
};

/** One choice in the grid: filled when the captain decides, hollow when you do. */
export function Cell({
  checked,
  label,
  disabled,
  onToggle,
}: {
  checked: boolean;
  label: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex h-8 w-[88px] cursor-pointer items-center justify-center gap-1.5 rounded-md border text-sm transition-colors disabled:cursor-wait disabled:opacity-60",
        checked
          ? "border-accent-line bg-accent-wash font-medium text-fg"
          : "border-dashed border-line-control text-fg-muted hover:border-line-hover hover:text-fg",
      )}
    >
      {checked && <Check aria-hidden="true" className="size-3.5 text-accent-text" strokeWidth={2.5} />}
      {checked ? "Captain" : "You"}
    </button>
  );
}

/** The daily budget of one workspace: an amount, or empty to share the Auto-pilot budget. */
function BudgetCell({ org }: { org: CaptainOrg }) {
  const toast = useToast();
  const save = useCaptainRules();
  const current = org.budget?.cost;
  const [text, setText] = useState(current === undefined ? "" : String(current));
  const [shown, setShown] = useState(current);
  // A change from outside (Limits, an undo) replaces what is typed.
  if (shown !== current) {
    setShown(current);
    setText(current === undefined ? "" : String(current));
  }
  const typed = text.trim();
  const amount = typed === "" ? undefined : parseDollars(typed);
  const invalid = typed !== "" && amount === undefined;
  const commit = () => {
    if (invalid || amount === current) return;
    save.mutate(
      {
        input: { orgs: { [org.org]: { cap: amount === undefined ? null : { cost: amount } } } },
        reason: `Owner set the daily budget of ${org.name}`,
      },
      {
        onSuccess: () =>
          toast(
            amount === undefined
              ? `${org.name}: shares the Auto-pilot budget`
              : `${org.name}: $${amount} a day`,
          ),
        onError: (error) => {
          setText(current === undefined ? "" : String(current));
          toast("Could not save it", { detail: describeError(error), tone: "error" });
        },
      },
    );
  };
  return (
    <Input
      aria-label={`Daily budget of ${org.name} in dollars`}
      inputMode="decimal"
      placeholder="shared"
      title="Dollars a day. Empty shares the Auto-pilot budget."
      value={text}
      aria-invalid={invalid}
      disabled={save.isPending}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(current === undefined ? "" : String(current));
      }}
      className="tnum h-8 w-[88px] px-2 text-center font-mono text-sm"
    />
  );
}

/** How many tasks the captain works on at once in a workspace. */
function AtOnceCell({ org }: { org: CaptainOrg }) {
  const toast = useToast();
  const save = useCaptainRules();
  const current = org.rules.tasksAtOnce ?? TASKS_AT_ONCE;
  return (
    <Select
      aria-label={`Tasks at once in ${org.name}`}
      title="How many tasks the captain works on at the same time here"
      value={String(current)}
      disabled={save.isPending}
      onChange={(e) => {
        const n = Number(e.target.value);
        save.mutate(
          {
            input: { orgs: { [org.org]: { tasksAtOnce: n === TASKS_AT_ONCE ? null : n } } },
            reason: `Owner set tasks at once in ${org.name} to ${n}`,
          },
          {
            onSuccess: () => toast(`${org.name}: ${n} ${n === 1 ? "task" : "tasks"} at once`),
            onError: (error) => toast("Could not save it", { detail: describeError(error), tone: "error" }),
          },
        );
      }}
      className="h-8 w-[88px] px-2 text-center font-mono text-sm"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </Select>
  );
}

/** The workspaces as columns, the six decisions and the daily budget as rows. */
function Grid({
  orgs,
  mode,
  onMore,
}: {
  orgs: readonly CaptainOrg[];
  mode: string;
  onMore: (org: string) => void;
}) {
  const toast = useToast();
  const save = useCaptainRules();
  const change = (org: CaptainOrg, patch: Partial<Authority>, done: string) =>
    save.mutate(
      {
        input: { orgs: { [org.org]: { authority: patch } } },
        reason: `Owner changed who decides what in ${org.name}`,
      },
      {
        onSuccess: () => toast(done),
        onError: (error) => toast("Could not change it", { detail: describeError(error), tone: "error" }),
      },
    );
  const setRow = (org: CaptainOrg, row: AuthorityRow, value: AuthorityChoice) =>
    change(
      org,
      { [row]: value },
      `${org.name}: ${AUTHORITY_ROW_TEXT[row].label} is ${value === "decide" ? "the captain's" : "yours"}`,
    );
  // Full access gives every row but Merge and Push, which keep their own switch, and the rows that leave for a
  // server or a client, which are only ever the owner's choice.
  const covered = (org: CaptainOrg, row: AuthorityRow) =>
    org.rules.fullAccess === true && !FULL_ACCESS_KEEPS.includes(row) && !FULL_ACCESS_NEVER.includes(row);
  const review = useStartReview();
  const sticky = "sticky left-0 z-10 bg-glass-strong";
  return (
    <fieldset
      aria-label="Who decides what"
      className="m-0 -mx-1 min-w-0 overflow-x-auto border-0 px-1 pt-0 pb-1"
    >
      <div className="flex w-max min-w-full flex-col">
        <div className="flex items-end gap-2 border-b border-line pb-2">
          <div className={cn(FIRST_COLUMN, sticky, "pr-2 text-xs text-fg-faint")}>Who decides</div>
          {orgs.map((org) => (
            <div key={org.org} className={cn(COLUMN, "flex items-center justify-between gap-1")}>
              <span className="min-w-0 truncate text-sm font-medium text-fg" title={org.name}>
                {org.name}
              </span>
              <Menu
                label={`Options for ${org.name}`}
                icon={<MoreHorizontal aria-hidden="true" />}
                items={[
                  ...AUTHORITY_PRESETS.map((preset) => ({
                    label: preset.label,
                    onSelect: () => change(org, preset.rows, `${org.name}: ${preset.label}`),
                  })),
                  { label: "Hours, freezes and more", onSelect: () => onMore(org.org) },
                  {
                    label: "Review memories now",
                    group: "Upkeep",
                    disabled: org.authority.upkeep !== "decide" || review.pending,
                    onSelect: () => review.start(org.org, "memory", 0),
                  },
                  {
                    label: "Clean up now",
                    group: "Upkeep",
                    disabled: org.authority.upkeep !== "decide" || review.pending,
                    onSelect: () => review.start(org.org, "cleanup", 0),
                  },
                ]}
              />
            </div>
          ))}
        </div>
        {AUTHORITY_ROWS_ORDER.map((row) => (
          <div key={row} className="flex items-center gap-2 border-b border-line py-1.5">
            <div
              className={cn(FIRST_COLUMN, sticky, "flex flex-col pr-2 leading-snug")}
              title={AUTHORITY_ROW_TEXT[row].detail}
            >
              <span className="flex items-center gap-1.5 text-base text-fg">
                {AUTHORITY_ROW_TEXT[row].label}
                {AUTHORITY_ROW_TEXT[row].isNew === true && (
                  <span className="rounded-[4px] border border-accent-line px-1 py-px font-mono text-[10px] font-medium tracking-[0.06em] text-accent-text uppercase">
                    new
                  </span>
                )}
              </span>
              <span className="text-xs text-fg-faint">{AUTHORITY_ROW_TEXT[row].hint}</span>
            </div>
            {orgs.map((org) => (
              <div key={org.org} className={COLUMN}>
                <Cell
                  checked={org.authority[row] === "decide"}
                  label={`${AUTHORITY_ROW_TEXT[row].label} in ${org.name}: ${org.authority[row] === "decide" ? "the captain decides" : "you decide"}${covered(org, row) ? ", by full access" : ""}`}
                  disabled={save.isPending || covered(org, row)}
                  onToggle={() => setRow(org, row, org.authority[row] === "decide" ? "ask" : "decide")}
                />
              </div>
            ))}
          </div>
        ))}
        <div className="flex items-center gap-2 border-b border-line py-1.5">
          <div
            className={cn(FIRST_COLUMN, sticky, "flex flex-col pr-2 leading-snug")}
            title="The captain decides everything here and acts without a card. It still asks before changing anyone's permissions, before anything destructive, and before merging or pushing when those rows are yours."
          >
            <span className="text-base text-fg">Full access</span>
            <span className="text-xs text-fg-faint">
              No cards, except permissions, deletes, and Merge or Push when they are yours
            </span>
          </div>
          {orgs.map((org) => (
            <div key={org.org} className={COLUMN}>
              <Cell
                checked={org.rules.fullAccess === true}
                label={`Full access in ${org.name}: ${org.rules.fullAccess === true ? "on" : "off"}`}
                disabled={save.isPending}
                onToggle={() =>
                  save.mutate(
                    {
                      input: { orgs: { [org.org]: { fullAccess: org.rules.fullAccess !== true } } },
                      reason: `Owner turned full access ${org.rules.fullAccess === true ? "off" : "on"} in ${org.name}`,
                    },
                    {
                      onSuccess: () =>
                        toast(`${org.name}: full access ${org.rules.fullAccess === true ? "off" : "on"}`),
                      onError: (error) =>
                        toast("Could not change it", { detail: describeError(error), tone: "error" }),
                    },
                  )
                }
              />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-b border-line py-1.5">
          <div className={cn(FIRST_COLUMN, sticky, "flex flex-col pr-2 leading-snug")}>
            <span className="text-base text-fg">Tasks at once</span>
            <span className="text-xs text-fg-faint">Started by the captain here</span>
          </div>
          {orgs.map((org) => (
            <div key={org.org} className={COLUMN}>
              <AtOnceCell org={org} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 py-1.5">
          <div className={cn(FIRST_COLUMN, sticky, "flex flex-col pr-2 leading-snug")}>
            <span className="text-base text-fg">Daily budget</span>
            <span className="text-xs text-fg-faint">Dollars. Empty shares the total.</span>
          </div>
          {orgs.map((org) => (
            <div key={org.org} className={COLUMN}>
              <BudgetCell org={org} />
            </div>
          ))}
        </div>
      </div>
      {orgs.flatMap((org) =>
        org.chores
          .filter((c) => c.running === true && (c.chore === "memory" || c.chore === "cleanup"))
          .map((c) => (
            <p key={`${org.org}:${c.chore}`} role="status" className="mt-2 text-xs text-fg-muted">
              {c.chore === "memory"
                ? `Reviewing memories in ${org.name}...`
                : `Cleaning up finished tasks in ${org.name}...`}
            </p>
          )),
      )}
      {orgs.some((o) => o.org === PRIVATE) && (
        <p className="mt-2 text-xs text-fg-faint text-pretty">
          Private is your own workspace, so Answer questions and Approvals start as Captain there. Other
          workspaces start as You.
        </p>
      )}
      <p className="mt-2 text-xs text-fg-faint text-pretty">
        The lines apply always. Auto-pilot only controls backlog work.
      </p>
    </fieldset>
  );
}

function Legend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-faint">
      <span className="flex items-center gap-1.5">
        <span className="flex h-5 w-8 items-center justify-center rounded-sm border border-accent-line bg-accent-wash">
          <Check aria-hidden="true" className="size-3 text-accent-text" strokeWidth={2.5} />
        </span>
        The captain decides
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-5 w-8 rounded-sm border border-dashed border-line-control" />
        You decide
      </span>
    </p>
  );
}

/** A section that folds: a button with a count, and its body under it when open. */
function Fold({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-1 border-t border-line pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 self-start rounded-md py-1 text-base font-medium text-fg"
      >
        <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-90")} />
        {label}
        <span className="tnum font-mono text-sm text-fg-faint">{count}</span>
      </button>
      {open && children}
    </section>
  );
}

function Instructions({ status, now }: { status: AutonomyStatus; now: number }) {
  const toast = useToast();
  const forget = useAutonomyCommand("autonomy.forget");
  const list = status.settings.instructions;
  if (list.length === 0)
    return (
      <p className="text-sm text-fg-faint text-pretty">
        None yet. Turn on "Keep as standing instruction" when you write to the captain in a workspace thread.
      </p>
    );
  return (
    <ul className="flex flex-col">
      {list.map((i) => (
        <li key={i.id} className="flex min-w-0 items-start gap-2 border-t border-line py-2 first:border-t-0">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base text-fg-soft text-pretty">{i.text}</span>
            <span className="text-xs text-fg-faint">
              {i.org === undefined
                ? "Every workspace"
                : (status.lanes.find((l) => l.org === i.org)?.name ?? i.org)}
              {" · "}
              <time dateTime={i.at} className="tnum">
                {clockTime(i.at, now)}
              </time>
            </span>
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Remove this instruction"
            title="Remove"
            disabled={forget.isPending}
            onClick={() =>
              forget.mutate(
                { input: { id: i.id }, reason: "Owner removed a standing instruction" },
                {
                  onError: (error) =>
                    toast("Could not remove it", { detail: describeError(error), tone: "error" }),
                },
              )
            }
          >
            <X aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function LeaveAlone({ status }: { status: AutonomyStatus }) {
  const exclude = useExclude();
  const marked = status.backlog.filter((b) => b.noAutonomy);
  if (marked.length === 0)
    return (
      <p className="text-sm text-fg-faint text-pretty">
        No task is marked. Use the leave-alone button on a task under Next to add one.
      </p>
    );
  return (
    <ul className="flex flex-col">
      {marked.map((b) => (
        <li
          key={b.task}
          className="flex min-w-0 items-center gap-2 border-t border-line py-1.5 first:border-t-0"
        >
          <span className="min-w-0 flex-1 truncate text-base text-fg" title={b.title}>
            {b.title}
          </span>
          <TaskRef task={b.task} />
          <Button
            size="sm"
            variant="ghost"
            disabled={exclude.busy}
            onClick={() => exclude.set(b.task, false)}
          >
            Let it take
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** A chore that turned itself off after failing twice, with the way to turn it on again. */
function OffChores({ orgs }: { orgs: readonly CaptainOrg[] }) {
  const toast = useToast();
  const choreOn = useCaptainCommand("captain.choreOn");
  const rows = orgs.flatMap((org) =>
    org.chores.filter((c) => c.off !== undefined).map((c) => ({ org, chore: c.chore, why: c.off ?? "" })),
  );
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1 border-t border-line pt-3">
      <h3 className="text-base font-medium text-fg">Turned off</h3>
      {rows.map(({ org, chore, why }) => (
        <div key={`${org.org}:${chore}`} className="flex min-w-0 items-center gap-2 text-sm">
          <Lamp state="paused" size={7} />
          <span className="min-w-0 flex-1 text-fg-soft text-pretty" title={why}>
            {org.name}: {CHORE_LABEL[chore]} is off. {why}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={choreOn.isPending}
            onClick={() =>
              choreOn.mutate(
                {
                  input: { org: org.org, chore },
                  reason: `Owner turned ${CHORE_LABEL[chore]} on again in ${org.name}`,
                },
                { onSuccess: () => toast(`${CHORE_LABEL[chore]} is on again in ${org.name}`) },
              )
            }
          >
            Turn on
          </Button>
        </div>
      ))}
    </section>
  );
}

/** The largest task the captain starts, the same in every workspace. */
function SizeLimit({ status }: { status: AutonomyStatus }) {
  const toast = useToast();
  const save = useAutonomyCommand("autonomy.configure");
  const size = status.settings.pick.size;
  return (
    <section className="flex flex-col gap-1.5 border-t border-line pt-3">
      <h3 className="text-base font-medium text-fg">Largest task it starts</h3>
      <Segmented
        label="Largest task it starts"
        value={size}
        segments={SIZES}
        onChange={(next) => {
          if (next === size) return;
          save.mutate(
            { input: { pick: { size: next } }, reason: "Owner changed the largest task the captain starts" },
            {
              onSuccess: () => toast("Saved"),
              onError: (error) => toast("Could not save it", { detail: describeError(error), tone: "error" }),
            },
          );
        }}
        className={cn("self-start", save.isPending && "opacity-70")}
      />
      <p className="text-xs text-fg-faint text-pretty">
        {SIZE_HELP[size]}
        {size !== "any" && " Laya rates each task. One it could not rate is not started."}
      </p>
    </section>
  );
}

/**
 * Delegation: who decides what, per workspace, in one grid. Cells toggle on a click and save at once;
 * the budget row takes an amount. Under it, the largest task the captain starts, the standing
 * instructions and the tasks it leaves alone.
 */
export function DelegationSheet({
  captain,
  now,
  onClose,
}: {
  captain: CaptainStatus;
  now: number;
  onClose: () => void;
}) {
  const autonomy = useAutonomyStatus(true).data;
  const accounts = useAccounts().data ?? [];
  const [more, setMore] = useState<string>();
  const moreOrg = captain.orgs.find((o) => o.org === more);
  const zone = autonomy?.settings.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Sheet
      title="Permissions"
      subtitle="Who decides what, per workspace"
      wide
      onClose={onClose}
      actions={
        <Button asChild size="sm" variant="ghost">
          <PageLink page="limits" onClick={onClose}>
            Limits
          </PageLink>
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {captain.captain === undefined && (
          <p className="rounded-xl border border-amber-line bg-amber-wash px-4 py-2.5 text-sm text-amber text-pretty">
            There is no captain yet. Choose one on the Agents page. Until then nothing here runs.
          </p>
        )}
        <Legend />
        <Grid orgs={captain.orgs} mode={captain.autonomy} onMore={setMore} />
        <OffChores orgs={captain.orgs} />
        <ShipRules orgs={captain.orgs} />
        {autonomy && (
          <>
            <SizeLimit status={autonomy} />
            <Fold label="Standing instructions" count={autonomy.settings.instructions.length}>
              <Instructions status={autonomy} now={now} />
            </Fold>
            <Fold label="Leave alone" count={autonomy.backlog.filter((b) => b.noAutonomy).length}>
              <LeaveAlone status={autonomy} />
            </Fold>
          </>
        )}
      </div>
      {moreOrg && (
        <Modal
          label={`More rules for ${moreOrg.name}`}
          onClose={() => setMore(undefined)}
          className="w-[min(760px,100vw)]"
        >
          <div className="flex max-h-[calc(100dvh-64px)] flex-col gap-3 overflow-y-auto p-5">
            <h2 className="text-md font-semibold">{moreOrg.name}: hours, freezes and more</h2>
            <MoreRules
              org={moreOrg}
              accounts={accounts}
              zone={zone}
              onDone={() => setMore(undefined)}
              doneLabel="Close"
            />
          </div>
        </Modal>
      )}
    </Sheet>
  );
}
