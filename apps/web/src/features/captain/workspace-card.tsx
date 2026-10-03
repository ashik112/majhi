import {
  type AccountView,
  type BudgetAsk,
  type CaptainCapAsk,
  type CaptainOrg,
  CHORE_LABEL,
  PRIVATE,
} from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Lamp } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { useToast } from "@/components/ui/toast";
import { BudgetAskCard } from "@/features/limits/budget-ask";
import { useAnswerCap, useCaptainCommand, useCaptainRules } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { PAGE_PATH } from "@/lib/pages";
import { AuthorityTable } from "./authority-table";
import { parseDollars } from "./model";
import { MoreRules } from "./more-rules";

/** Today's line at the right of the card's head, with a lamp only for state. */
function TodayLine({ org }: { org: CaptainOrg }) {
  if (Object.values(org.authority).every((c) => c === "ask"))
    return <span className="shrink-0 text-sm text-fg-faint">Asks you about everything</span>;
  if (org.resting !== undefined) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted" title={org.resting}>
        <Lamp state="paused" size={7} />
        <span className="min-w-0 truncate">Resting: {org.resting}</span>
      </span>
    );
  }
  if (org.summary === "") return <span className="shrink-0 text-sm text-fg-faint">Nothing yet today</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg-soft" title={`Today: ${org.summary}`}>
      <Lamp state={org.forYou > 0 ? "needs" : "done"} size={7} />
      <span className="min-w-0 truncate">Today: {org.summary}</span>
    </span>
  );
}

/**
 * A chore that reached its daily cap here, and the captain's question: raise it for today, or leave
 * it. The card names the workspace already, so the line drops its name.
 */
function CapAskRow({ ask, name }: { ask: CaptainCapAsk; name: string }) {
  const toast = useToast();
  const answer = useAnswerCap();
  const line = ask.text.startsWith(`${name}: `) ? ask.text.slice(name.length + 2) : ask.text;
  const send = (choice: "raise" | "leave") =>
    answer.mutate(
      { org: ask.org, chore: ask.chore, answer: choice },
      {
        onSuccess: () =>
          toast(
            choice === "raise"
              ? `${CHORE_LABEL[ask.chore]}: up to ${ask.raiseTo} today in ${name}`
              : `${CHORE_LABEL[ask.chore]} stays at ${ask.cap} today in ${name}`,
          ),
        onError: (error) => toast("Could not answer it", { detail: describeError(error), tone: "error" }),
      },
    );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-line bg-amber-wash px-3 py-2">
      <span className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-sm text-fg-soft">
        <Lamp state="needs" size={7} />
        <span className="min-w-0 text-pretty">{upperFirst(line)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="primary" disabled={answer.isPending} onClick={() => send("raise")}>
          Raise to {ask.raiseTo} for today
        </Button>
        <Button size="sm" variant="secondary" disabled={answer.isPending} onClick={() => send("leave")}>
          Leave it
        </Button>
      </span>
    </div>
  );
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The daily budget under the table: a dollar amount, saved with Enter or Save. */
function Budget({ org, dayCap }: { org: CaptainOrg; dayCap: number | undefined }) {
  const toast = useToast();
  const save = useCaptainRules();
  const saved = org.budget?.cost === undefined ? "" : String(org.budget.cost);
  const [draft, setDraft] = useState<string>();
  const text = draft ?? saved;
  const dirty = draft !== undefined && draft.trim() !== saved;
  const amount = parseDollars(text);
  const invalid = dirty && text.trim() !== "" && amount === undefined;
  const submit = () => {
    if (!dirty || invalid) return setDraft(undefined);
    const cap = text.trim() === "" ? null : { cost: amount ?? 0 };
    save.mutate(
      {
        input: { orgs: { [org.org]: { cap } } },
        reason: `Owner set ${org.name}'s daily budget`,
      },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast(
            cap === null
              ? `${org.name} has no budget of its own`
              : `${org.name}'s daily budget is ${formatMoney(cap.cost)}`,
          );
        },
        onError: (error) =>
          toast("Could not save the budget", { detail: describeError(error), tone: "error" }),
      },
    );
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2.5">
      <label htmlFor={`budget-${org.org}`} className="text-sm text-fg-soft">
        Daily budget
      </label>
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-sm text-fg-faint"
        >
          $
        </span>
        <Input
          id={`budget-${org.org}`}
          inputMode="decimal"
          value={text}
          placeholder={dayCap === undefined ? "none" : String(dayCap)}
          aria-invalid={invalid ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setDraft(undefined);
          }}
          className="tnum h-8 w-[92px] pl-6 font-mono text-sm"
        />
      </div>
      {dirty && (
        <>
          <Button size="sm" variant="primary" disabled={invalid || save.isPending} onClick={submit}>
            {save.isPending ? "Saving" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDraft(undefined)}>
            Cancel
          </Button>
        </>
      )}
      <span className="tnum text-sm text-fg-faint">
        {invalid
          ? "Use an amount like 20"
          : `${formatMoney(org.used.cost)} used today${org.budget === undefined && dayCap !== undefined ? `, within the day budget of ${formatMoney(dayCap)}` : ""}`}
      </span>
    </div>
  );
}

/**
 * One workspace on the Captain page: today's line, who decides what, the
 * budget, chores that turned off, and "More rules" folded away.
 */
export function WorkspaceCard({
  org,
  badge,
  color,
  accounts,
  autonomyOn,
  dayCap,
  zone,
  asks,
  budgetAsks,
}: {
  /** What the captain asks about this workspace's daily caps today. */
  asks: readonly CaptainCapAsk[];
  /** The question about this workspace's daily budget, when it ran out while work waits. */
  budgetAsks: readonly BudgetAsk[];
  org: CaptainOrg;
  badge: string;
  color: string | undefined;
  accounts: readonly AccountView[];
  autonomyOn: boolean;
  dayCap: number | undefined;
  zone: string;
}) {
  const toast = useToast();
  const choreOn = useCaptainCommand("captain.choreOn");
  const [open, setOpen] = useState(false);
  const off = org.chores.filter((c) => c.off !== undefined);
  return (
    <Card aria-label={org.name} className="gap-3 rounded-2xl px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <OrgBadge
          label={badge}
          color={color}
          size="md"
          className={org.org === PRIVATE ? "bg-fg-faint" : ""}
        />
        <h2 className="min-w-0 truncate text-md font-semibold text-fg">{org.name}</h2>
        <span className="ml-auto flex min-w-0 justify-end">
          <TodayLine org={org} />
        </span>
      </div>
      <AuthorityTable org={org} autonomyOn={autonomyOn} />
      {asks.map((ask) => (
        <CapAskRow key={ask.chore} ask={ask} name={org.name} />
      ))}
      {budgetAsks.map((ask) => (
        <BudgetAskCard key={ask.scope} ask={ask} />
      ))}
      {off.map((c) => (
        <div key={c.chore} className="flex min-w-0 items-center gap-2 text-sm">
          <Lamp state="paused" size={7} />
          <span className="min-w-0 flex-1 truncate text-fg-soft" title={c.off}>
            {CHORE_LABEL[c.chore]} is off: {c.off}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={choreOn.isPending}
            onClick={() =>
              choreOn.mutate(
                {
                  input: { org: org.org, chore: c.chore },
                  reason: `Owner turned ${CHORE_LABEL[c.chore]} on again in ${org.name}`,
                },
                { onSuccess: () => toast(`${CHORE_LABEL[c.chore]} is on again in ${org.name}`) },
              )
            }
          >
            Turn on
          </Button>
        </div>
      ))}
      <div className="flex min-h-8 min-w-0 items-center gap-3">
        {Object.values(org.authority).includes("decide") && <Budget org={org} dayCap={dayCap} />}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm text-fg-muted underline decoration-line-bright underline-offset-[3px] hover:text-fg"
        >
          More rules
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open && <MoreRules org={org} accounts={accounts} zone={zone} onDone={() => setOpen(false)} />}
    </Card>
  );
}
