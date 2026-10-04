import {
  AUTHORITY_LABEL,
  type AuthorityRow,
  hoursWord,
  MINUTES_KINDS,
  MINUTES_LABEL,
  moneyWord,
  OUTBOUND_CHANNEL_LABEL,
  type OutboundChannel,
  PRIVATE,
  type Scorecard,
  type ScorecardRange,
  scorecardLine,
  type Tally,
} from "@majhi/shared";
import { Scale } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useScorecard, useSetMinutes, useUnmute } from "@/lib/scorecard-queries";
import { useOrgs } from "@/lib/studio-queries";

/** Workspace names by id, Private included. */
function useNames(): (org: string) => string {
  const orgs = useOrgs().data ?? [];
  return (org) => (org === PRIVATE ? "Private" : (orgs.find((o) => o.id === org)?.name ?? org));
}

function pct(n: number | undefined): string {
  return n === undefined ? "n/a" : `${Math.round(n)}%`;
}

/** The row's name in words: an authority row or an outbound channel. */
function keyName(key: string): string {
  if (key.startsWith("outbound:")) {
    return `${OUTBOUND_CHANNEL_LABEL[key.slice(9) as OutboundChannel] ?? key.slice(9)} drafts`;
  }
  return (AUTHORITY_LABEL[key as AuthorityRow] ?? key).split(":")[0] ?? key;
}

/** "This week: kept 200 of 200, about 14 h saved, $176", from the week's total. */
export function WeekLine() {
  const t = useScorecard("week").data?.total;
  if (t === undefined || (t.judged === 0 && t.costUsd === 0 && t.minutesSaved === 0)) return null;
  const saved = t.minutesSaved > 0 ? `, about ${hoursWord(t.minutesSaved)} saved` : "";
  return (
    <p className="tnum text-sm text-fg-muted">
      This week: kept {t.kept} of {t.judged}
      {saved}, {moneyWord(t.costUsd)}
    </p>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mb-5 flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {note && <p className="text-xs text-fg-faint">{note}</p>}
      {children}
    </section>
  );
}

const TH = "px-2 py-1 text-left text-xs font-medium text-fg-faint";
const TD = "px-2 py-1.5 align-baseline tnum";

function Table({ head, children }: { head: readonly string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-strong">
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn(TH, i > 0 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

function Num({ children, bad }: { children: ReactNode; bad?: boolean }) {
  return <td className={cn(TD, "text-right font-mono text-fg-soft", bad && "text-red")}>{children}</td>;
}

function tallyCells(t: Tally) {
  return (
    <>
      <Num>{t.actions}</Num>
      <Num bad={t.keptPct !== undefined && t.keptPct < 80}>{pct(t.keptPct)}</Num>
      <Num bad={(t.overruledPct ?? 0) > 20}>{pct(t.overruledPct)}</Num>
      <Num>{t.tokens === 0 && t.costUsd === 0 ? "n/a" : `${moneyWord(t.costUsd)}`}</Num>
      <Num>{t.minutesSaved === 0 ? "n/a" : hoursWord(t.minutesSaved)}</Num>
    </>
  );
}

const TALLY_HEAD = ["Actions", "Kept", "Undone or overruled", "Cost", "Time saved"] as const;

/** Minutes one kept action of each kind saves: the owner's estimate, saved on leaving the field. */
function MinutesEditor({ minutes }: { minutes: Record<string, number> }) {
  const set = useSetMinutes();
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-1 min-[560px]:grid-cols-2">
      {MINUTES_KINDS.map((kind) => (
        <li key={kind} className="flex items-center justify-between gap-3 text-sm">
          <label htmlFor={`minutes-${kind}`} className="min-w-0 truncate text-fg-soft">
            {MINUTES_LABEL[kind]}
          </label>
          <span className="flex shrink-0 items-center gap-1.5">
            <Input
              id={`minutes-${kind}`}
              type="number"
              min={0}
              max={600}
              inputMode="decimal"
              defaultValue={minutes[kind] ?? 0}
              key={`${kind}-${minutes[kind]}`}
              className="h-7 w-16 text-right font-mono"
              onBlur={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n) && n >= 0 && n !== minutes[kind]) set.mutate({ kind, minutes: n });
              }}
            />
            <span className="w-7 text-xs text-fg-faint">min</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Body({ card }: { card: Scorecard }) {
  const name = useNames();
  const unmute = useUnmute();
  const line = scorecardLine(card.total);
  return (
    <>
      <p className="mb-4 text-base text-fg-soft">
        {line ?? "Nothing was done in this span."}
        {card.total.pending > 0 && (
          <span className="text-fg-faint">
            {" "}
            {card.total.pending} not judged yet: an action counts as kept six hours after it, unless you undo
            it.
          </span>
        )}
      </p>

      <Section title="Workspaces">
        {card.orgs.length === 0 ? (
          <p className="text-sm text-fg-faint">No workspace did anything.</p>
        ) : (
          <Table head={["Workspace", ...TALLY_HEAD, "Findings taken"]}>
            {card.orgs.map((o) => (
              <tr key={o.org}>
                <th scope="row" className={cn(TD, "max-w-[160px] truncate text-left font-medium")}>
                  {name(o.org)}
                </th>
                {tallyCells(o.tally)}
                <Num>{o.findings.filed === 0 ? "n/a" : `${o.findings.accepted} of ${o.findings.filed}`}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Authority and outbound channels"
        note={`The ladder reads the last ${card.window} judged actions of each. Under 80% kept it drops to You, or Draft for a channel. Above 95% it asks you in Decisions; it never promotes itself.`}
      >
        {card.rows.length === 0 ? (
          <p className="text-sm text-fg-faint">Nothing yet.</p>
        ) : (
          <Table head={["Row", ...TALLY_HEAD, `Last ${card.window}`]}>
            {card.rows.map((r) => (
              <tr key={`${r.org}:${r.key}`}>
                <th scope="row" className={cn(TD, "text-left font-medium")}>
                  <span className="block max-w-[200px] truncate">{keyName(r.key)}</span>
                  <span className="block text-xs font-normal text-fg-faint">
                    {name(r.org)}
                    {r.note && `, ${r.note.toLowerCase()}`}
                  </span>
                </th>
                {tallyCells(r.tally)}
                <Num>{r.window.judged === 0 ? "n/a" : `${r.window.kept} of ${r.window.judged}`}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Playbooks"
        note="A playbook whose findings you dismiss more than 70% of the time runs weekly instead."
      >
        {card.playbooks.length === 0 ? (
          <p className="text-sm text-fg-faint">No playbook ran.</p>
        ) : (
          <Table head={["Playbook", "Runs", "Findings", "Taken", "Dismissed", "Tokens"]}>
            {card.playbooks.map((p) => (
              <tr key={`${p.org}:${p.playbook}`}>
                <th scope="row" className={cn(TD, "text-left font-medium")}>
                  <span className="block max-w-[200px] truncate">{p.playbook}</span>
                  <span className="flex items-center gap-2 text-xs font-normal text-fg-faint">
                    {name(p.org)}
                    {p.muted && (
                      <>
                        <span className="text-amber-soft">weekly, muted</span>
                        <button
                          type="button"
                          disabled={unmute.isPending}
                          onClick={() => unmute.mutate({ org: p.org, playbook: p.playbook })}
                          className="cursor-pointer underline underline-offset-2 hover:text-fg"
                        >
                          Undo
                        </button>
                      </>
                    )}
                  </span>
                </th>
                <Num>{p.runs}</Num>
                <Num>{p.findings.filed}</Num>
                <Num>{p.findings.accepted}</Num>
                <Num bad={(p.findings.conversionPct ?? 100) < 30}>{p.findings.dismissed}</Num>
                <Num>{p.tally.tokens === 0 ? "n/a" : p.tally.tokens.toLocaleString("en-US")}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Minutes saved per kept action"
        note="Your estimate, per kind of action. Time saved is kept actions times these."
      >
        <MinutesEditor minutes={card.minutes} />
      </Section>
    </>
  );
}

/** The full scorecard: today or this week, per workspace, per authority row and channel, per playbook. */
export function ScorecardSheet() {
  const [range, setRange] = useState<ScorecardRange>("week");
  const query = useScorecard(range);
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <Segmented
          label="Span"
          value={range}
          onChange={setRange}
          segments={[
            { value: "today", label: "Today" },
            { value: "week", label: "This week" },
          ]}
        />
        <Scale aria-hidden="true" className="size-4 text-fg-faint" />
      </div>
      {query.isError && (
        <p role="alert" className="text-sm text-red">
          {describeError(query.error)}
        </p>
      )}
      {query.data === undefined && !query.isError && <Skeleton className="h-40 w-full" />}
      {query.data && <Body card={query.data} />}
    </>
  );
}
