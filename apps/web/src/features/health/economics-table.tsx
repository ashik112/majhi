import {
  changeWord,
  type EconomicsRange,
  type EconomicsRow,
  hoursWord,
  moneyWord,
  type Pair,
  PRIVATE,
} from "@majhi/shared";
import { useState } from "react";
import { Lamp } from "@/components/ui/lamp";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useEconomics } from "@/lib/scorecard-queries";
import { useOrgs } from "@/lib/studio-queries";

/** A figure with how it moved against the period before, in small type under it. */
function Figure({ pair, text, worseWhenUp }: { pair: Pair; text: string; worseWhenUp?: boolean }) {
  const change = changeWord(pair);
  const up = pair.now > pair.before;
  return (
    <td className="px-2 py-1.5 text-right align-top">
      <div className="tnum font-mono text-fg-soft">{text}</div>
      <div
        className={cn(
          "tnum text-xs",
          change === "" || change === "same"
            ? "text-fg-faint"
            : worseWhenUp && up
              ? "text-amber"
              : "text-fg-muted",
        )}
      >
        {change === "" ? " " : change}
      </div>
    </td>
  );
}

const active = (r: EconomicsRow): boolean =>
  r.shipped.now + r.shipped.before > 0 ||
  r.spentUsd.now + r.spentUsd.before > 0 ||
  r.agentMinutes.now > 0 ||
  r.ownerMinutes.now > 0 ||
  r.flags.length > 0 ||
  r.retainerUsd !== undefined;

/**
 * What each workspace did and cost, this week or this month against the one before. Your time is an
 * estimate and says so. With no retainer entered below, "Left" reads "n/a": nothing is guessed.
 */
export function EconomicsTable() {
  const [range, setRange] = useState<EconomicsRange>("week");
  const query = useEconomics(range);
  const orgs = useOrgs().data ?? [];
  const name = (org: string) => (org === PRIVATE ? "Private" : (orgs.find((o) => o.id === org)?.name ?? org));
  const data = query.data;
  const rows = data?.rows.filter(active) ?? [];
  const flagged = rows.filter((r) => r.flags.length > 0);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="m-0 text-sm font-semibold">Per workspace</h3>
        <Segmented
          label="Period"
          value={range}
          segments={[
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
          onChange={setRange}
        />
        {data && <span className="text-xs text-fg-faint">{data.label}, against the same stretch before</span>}
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-red">
          {describeError(query.error)}
        </p>
      ) : data === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-faint">Nothing shipped or spent yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <caption className="sr-only">
                Shipped work, agent time, spend and your time per workspace
              </caption>
              <thead>
                <tr className="border-b border-line-strong text-xs font-medium text-fg-faint">
                  <th scope="col" className="px-2 py-1 text-left">
                    Workspace
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    Shipped
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    Agent time
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    Spent
                  </th>
                  <th scope="col" className="px-2 py-1 text-right" title={data.estimate}>
                    Your time (est.)
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    Left
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.org}>
                    <th
                      scope="row"
                      className="max-w-[160px] truncate px-2 py-1.5 text-left align-top font-medium"
                    >
                      {name(r.org)}
                    </th>
                    <Figure pair={r.shipped} text={String(r.shipped.now)} />
                    <Figure pair={r.agentMinutes} text={hoursWord(r.agentMinutes.now)} />
                    <Figure pair={r.spentUsd} text={moneyWord(r.spentUsd.now)} worseWhenUp />
                    <Figure pair={r.ownerMinutes} text={hoursWord(r.ownerMinutes.now)} worseWhenUp />
                    <td
                      className={cn(
                        "tnum px-2 py-1.5 text-right align-top font-mono",
                        r.marginUsd === undefined
                          ? "text-fg-faint"
                          : r.marginUsd < 0
                            ? "text-red"
                            : "text-fg-soft",
                      )}
                    >
                      {r.marginUsd === undefined ? "n/a" : moneyWord(r.marginUsd)}
                      {r.valueUsd !== undefined && (
                        <div className="text-xs text-fg-faint">of {moneyWord(r.valueUsd)}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {flagged.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {flagged.flatMap((r) =>
                r.flags.map((f) => (
                  <li key={`${r.org}:${f.kind}`} className="flex min-w-0 items-baseline gap-2 text-sm">
                    <Lamp state="paused" size={7} />
                    <span className="shrink-0 font-medium">{name(r.org)}</span>
                    <span className="min-w-0 text-fg-muted text-pretty">{f.text}</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
