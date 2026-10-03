import type { AutonomyStatus, BudgetAsk, CapUse } from "@majhi/shared";
import { ChevronDown, Gauge } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { UsageBar } from "@/components/ui/usage-bar";
import { BROWSER_ZONE } from "@/features/automations/model";
import {
  type CapDraft,
  capTone,
  type LimitsDraft,
  limitsDraft,
  limitsPatch,
  type OrgDraft,
} from "@/features/autonomy/model";
import { BudgetsPanel } from "@/features/usage/budgets-panel";
import { useAutonomyCommand, useAutonomyStatus } from "@/lib/autonomy-queries";
import { useCaptainAsks, useCaptainStatus } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatMoney, formatTokens } from "@/lib/format";
import { useMedia } from "@/lib/use-media";
import { BudgetAskCard, budgetShort } from "./budget-ask";

const PCT_TEXT = { calm: "text-fg-muted", amber: "text-amber", red: "text-red" } as const;

/** A cost and a tokens field side by side. Empty means no budget of that kind. */
function CapFields({
  label,
  value,
  empty,
  onChange,
}: {
  label: string;
  value: CapDraft;
  /** What an empty dollar field means, in a word. */
  empty: string;
  onChange: (next: CapDraft) => void;
}) {
  return (
    <span className="flex shrink-0 gap-1.5">
      <span className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-sm text-fg-faint"
        >
          $
        </span>
        <Input
          aria-label={`${label}, dollars`}
          placeholder={empty}
          inputMode="decimal"
          value={value.cost}
          onChange={(e) => onChange({ ...value, cost: e.target.value })}
          className="tnum h-8 w-[88px] pr-2 pl-6 font-mono text-sm"
        />
      </span>
      <Input
        aria-label={`${label}, tokens`}
        placeholder="tokens"
        value={value.tokens}
        onChange={(e) => onChange({ ...value, tokens: e.target.value })}
        className="tnum h-8 w-[84px] px-2 font-mono text-sm"
      />
    </span>
  );
}

/** What was used against a budget, with a bar when there is one: "$4.20 of $20.00 today" and the share. */
function UseLine({ use, raised, none }: { use: CapUse; raised: boolean; none: string }) {
  const tone = capTone(use);
  const cap = use.cap;
  const text =
    cap === undefined
      ? `${formatMoney(use.used.cost)} used today. ${none}`
      : [
          ...(cap.cost === undefined
            ? []
            : [`${formatMoney(use.used.cost)} of ${budgetShort({ cost: cap.cost })}`]),
          ...(cap.tokens === undefined
            ? []
            : [`${formatTokens(use.used.tokens)} of ${formatTokens(cap.tokens)} tokens`]),
        ].join(" and ");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
        <span className="tnum min-w-0 text-fg-muted">
          {text}
          {cap !== undefined && " today"}
        </span>
        {cap !== undefined && (
          <span
            className={cn("tnum ml-auto shrink-0", use.reached ? "font-medium" : "font-mono", PCT_TEXT[tone])}
          >
            {use.reached ? "Used up" : `${Math.floor(use.percent)}%`}
          </span>
        )}
      </span>
      {cap !== undefined && <UsageBar pct={use.percent} tone={tone} height={5} />}
      {raised && cap !== undefined && (
        <span className="text-xs text-amber">Raised to {budgetShort(cap)} for today only</span>
      )}
    </div>
  );
}

const NONE: CapUse = { used: { tokens: 0, cost: 0 }, percent: 0, reached: false };

/**
 * The one place for limits: the autonomous budget per day, an optional budget per workspace inside
 * it, and the safety limits (account floors, weekly budgets). The first two save together with Save,
 * which shows only while something changed. The budget questions the captain asks sit right under
 * the budget they are about.
 */
export function LimitsView() {
  const query = useAutonomyStatus();
  const captain = useCaptainStatus().data;
  const asks = useCaptainAsks().data?.budgets ?? [];
  const status = query.data;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {query.isError ? (
        <>
          <PageHeader title="Limits" />
          <Problem icon={<Gauge />} title="Could not load the limits" body={describeError(query.error)} />
        </>
      ) : !status ? (
        <>
          <PageHeader title="Limits" />
          <RowsSkeleton rows={3} height={120} />
        </>
      ) : (
        <LimitsForm
          status={status}
          workspaces={(captain?.orgs ?? []).map((o) => ({ id: o.org, name: o.name }))}
          asks={asks}
        />
      )}
    </div>
  );
}

function LimitsForm({
  status,
  workspaces,
  asks,
}: {
  status: AutonomyStatus;
  workspaces: readonly { id: string; name: string }[];
  asks: readonly BudgetAsk[];
}) {
  const ids = useId();
  const settings = status.settings;
  const key = workspaces.map((w) => w.id).join(" ");
  const base = useMemo(() => limitsDraft(settings, key === "" ? [] : key.split(" ")), [settings, key]);
  const [draft, setDraft] = useState<LimitsDraft>();
  const [problem, setProblem] = useState<string>();
  // Two columns from 1280px: Safety fills the second one, so it starts open there.
  const wide = useMedia("(min-width: 1280px)");
  const [safetyPicked, setSafety] = useState<boolean>();
  const safety = safetyPicked ?? wide;
  const save = useAutonomyCommand("autonomy.configure");
  const form = draft ?? base;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(base);
  const name = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id;

  const edit = (change: Partial<LimitsDraft>) => {
    setProblem(undefined);
    setDraft({ ...form, ...change });
  };
  const editOrg = (id: string, change: Partial<OrgDraft>) => {
    const row = form.orgs[id] ?? { cost: "", tokens: "" };
    edit({ orgs: { ...form.orgs, [id]: { ...row, ...change } } });
  };
  const submit = () => {
    const out = limitsPatch(form, settings, BROWSER_ZONE);
    if ("problem" in out) return setProblem(out.problem);
    save.mutate(
      { input: out.patch, reason: "Owner changed the limits of autonomous mode" },
      { onSuccess: () => setDraft(undefined) },
    );
  };
  const askFor = (scope: string) => asks.filter((a) => a.scope === scope);
  const orgUse = (id: string): CapUse => status.spend.orgs.find((o) => o.org === id) ?? NONE;

  return (
    <>
      <PageHeader title="Limits" subtitle="What autonomous work may spend each day, and what it keeps back.">
        {(dirty || save.isPending) && (
          <>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={submit}>
              {save.isPending ? "Saving" : "Save"}
            </Button>
          </>
        )}
      </PageHeader>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-6 scroll-fade">
        <div className="grid w-full min-w-0 items-start gap-3 min-[1280px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          {(problem ?? save.error) && (
            <p
              role="alert"
              className="rounded-xl border border-red-line bg-red-wash px-4 py-2.5 text-sm text-red min-[1280px]:col-span-2"
            >
              {problem ?? `Could not save: ${describeError(save.error)}`}
            </p>
          )}
          <div className="flex min-w-0 flex-col gap-3">
            <Card aria-label="Autonomous budget per day" id="autonomous-budget">
              <div className="flex min-w-0 items-center gap-3">
                <h2 className="min-w-0 flex-1 text-base font-semibold text-fg">Autonomous budget per day</h2>
                <CapFields
                  label="Autonomous budget"
                  empty="needed"
                  value={form.day}
                  onChange={(day) => edit({ day })}
                />
              </div>
              <p className="text-sm text-fg-muted text-pretty">
                One number for all autonomous work: the captain's own turns and every task it starts or
                resumes. Autonomous needs it while it is on.
              </p>
              <UseLine use={status.spend.total} raised={status.raised.day !== undefined} none="" />
              {askFor("day").map((ask) => (
                <BudgetAskCard key={ask.scope} ask={ask} />
              ))}
              <div className="flex min-w-0 items-center gap-3 border-t border-line pt-2.5 text-sm">
                <label htmlFor={`${ids}-summary`} className="min-w-0 flex-1 text-fg-soft">
                  Daily summary at
                </label>
                <Input
                  id={`${ids}-summary`}
                  type="time"
                  value={form.summaryAt}
                  onChange={(e) => edit({ summaryAt: e.target.value })}
                  className="h-8 w-[124px] px-2"
                />
              </div>
            </Card>

            <Card aria-label="Budget per workspace">
              <h2 className="text-base font-semibold text-fg">Per workspace</h2>
              <p className="text-sm text-fg-muted text-pretty">
                A daily budget inside the autonomous one, so one client cannot spend another's money. Empty
                shares the whole autonomous budget.
              </p>
              <ul className="flex flex-col">
                {Object.keys(form.orgs).map((id) => {
                  const row = form.orgs[id] ?? { cost: "", tokens: "" };
                  const use = orgUse(id);
                  return (
                    <li key={id} className="flex min-w-0 flex-col gap-2 border-t border-line py-2.5">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-base text-fg" title={name(id)}>
                          {name(id)}
                        </span>
                        <CapFields
                          label={`Budget of ${name(id)}`}
                          empty="shared"
                          value={row}
                          onChange={(cap) => editOrg(id, cap)}
                        />
                      </div>
                      <UseLine
                        use={use}
                        raised={status.raised[id] !== undefined}
                        none="Shares the autonomous budget."
                      />
                      {askFor(id).map((ask) => (
                        <BudgetAskCard key={ask.scope} ask={ask} />
                      ))}
                    </li>
                  );
                })}
              </ul>
              {Object.keys(form.orgs).length === 0 && (
                <p className="text-sm text-fg-faint">No workspaces yet.</p>
              )}
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <Card aria-label="Safety">
              <button
                type="button"
                aria-expanded={safety}
                onClick={() => setSafety(!safety)}
                className="flex min-h-7 w-full cursor-pointer items-center gap-2 text-left"
              >
                <h2 className="text-base font-semibold text-fg">Safety</h2>
                <span className="min-w-0 flex-1 truncate text-sm text-fg-faint">
                  Account floors and weekly budgets
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn("size-4 shrink-0 text-fg-muted transition-transform", safety && "rotate-180")}
                />
              </button>
              {safety && (
                <div className="flex flex-col gap-4 pt-1">
                  <div className="flex flex-col gap-2">
                    <p className="text-sm text-fg-muted text-pretty">
                      Account floors: autonomous work starts nothing on an account with less than this left.
                    </p>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-sm">
                      <label htmlFor={`${ids}-window`} className="text-fg-soft">
                        Keep of each 5-hour window, %
                      </label>
                      <Input
                        id={`${ids}-window`}
                        inputMode="numeric"
                        value={form.window}
                        onChange={(e) => edit({ window: e.target.value })}
                        className="h-8 w-[76px] justify-self-end px-2"
                      />
                      <label htmlFor={`${ids}-weekly`} className="text-fg-soft">
                        Keep of each week, %
                      </label>
                      <Input
                        id={`${ids}-weekly`}
                        inputMode="numeric"
                        value={form.weekly}
                        onChange={(e) => edit({ weekly: e.target.value })}
                        className="h-8 w-[76px] justify-self-end px-2"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="text-sm text-fg-muted text-pretty">
                      Weekly budgets per workspace and per account. They pause runs at 100% and alert at 80%.
                      Also limits your own tasks.
                    </p>
                    <BudgetsPanel bare />
                  </div>
                </div>
              )}
            </Card>
            <p className="text-xs text-fg-faint text-pretty">
              Days and the summary time follow {BROWSER_ZONE}, this browser's zone. Who decides merging and
              pushing is set per workspace under Rules on the Captain page.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
