import type { AutonomyAccount, AutonomyStatus, CapUse } from "@majhi/shared";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { UsageBar } from "@/components/ui/usage-bar";
import { meterTone } from "@/features/accounts/window-meter";
import { cn } from "@/lib/cn";
import { useOrgs } from "@/lib/studio-queries";
import { capText, capTone, clockTime } from "./model";
import { CardHead } from "./sections";

const PCT_TEXT = { calm: "text-fg-muted", amber: "text-amber", red: "text-red" } as const;

/** One cap: its name, the share used, what was spent against it, and a bar when there is a cap. */
function CapRow({ label, use }: { label: string; use: CapUse }) {
  const tone = capTone(use);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="min-w-0 truncate text-fg-soft">{label}</span>
        <span className="tnum ml-auto shrink-0 text-fg-muted">{capText(use)}</span>
        {use.cap && (
          <span className={cn("tnum w-10 shrink-0 text-right font-mono", PCT_TEXT[tone])}>
            {Math.floor(use.percent)}%
          </span>
        )}
      </span>
      {use.cap && <UsageBar pct={use.percent} tone={tone} height={5} />}
    </div>
  );
}

/** A window's bar with the floor marked: no new autonomous work starts past the mark. */
function FloorBar({
  label,
  window,
  floor,
  now,
}: {
  label: string;
  window: { usedPct: number; resetsAt?: string | undefined } | undefined;
  /** Percent left that autonomous mode keeps. */
  floor: number;
  now: number;
}) {
  if (!window) return <span className="text-xs text-fg-faint">{label}: not read yet</span>;
  const tone = meterTone(window.usedPct);
  const mark = Math.max(0, Math.min(100, 100 - floor));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className={cn("tnum font-mono", PCT_TEXT[tone])}>{Math.round(window.usedPct)}%</span>
        {window.resetsAt && (
          <span className="ml-auto truncate text-fg-faint">resets {clockTime(window.resetsAt, now)}</span>
        )}
      </span>
      <span className="relative block">
        <UsageBar pct={window.usedPct} tone={tone} height={4} />
        <span
          aria-hidden="true"
          title={`Keeps ${floor}% left`}
          style={{ left: `${mark}%` }}
          className="absolute -top-0.5 h-2 w-px -translate-x-1/2 bg-fg-muted"
        />
      </span>
    </div>
  );
}

function AccountRow({
  account,
  floors,
  now,
}: {
  account: AutonomyAccount;
  floors: { window: number; weekly: number };
  now: number;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2 first:border-t-0">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span className="min-w-0 truncate font-mono text-fg-soft">{account.id}</span>
        <span className="shrink-0 text-xs text-fg-faint">{account.org}</span>
        {account.blocked && <span className="ml-auto shrink-0 text-xs text-amber">held</span>}
      </span>
      <div className="grid grid-cols-2 gap-3">
        <FloorBar label="5 hours" window={account.window} floor={floors.window} now={now} />
        <FloorBar label="Week" window={account.weekly} floor={floors.weekly} now={now} />
      </div>
      {account.blocked && (
        <span className="text-xs text-amber text-pretty">
          {account.blocked.why}
          {account.blocked.until && ` Until ${clockTime(account.blocked.until, now)}.`}
        </span>
      )}
    </li>
  );
}

/** Today's spend against the day cap and each org's, every account's windows with the floors, and the holds. */
export function SpendCard({ status, now }: { status: AutonomyStatus; now: number }) {
  const orgs = useOrgs().data ?? [];
  const name = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;
  const { spend, settings } = status;
  return (
    <Card aria-label="Spend">
      <CardHead title="Spend">
        <span className="text-sm text-fg-faint">today, resets {clockTime(spend.resetsAt, now)}</span>
      </CardHead>
      <CapRow label="Day cap" use={spend.total} />
      {spend.orgs.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {spend.orgs.map((o) => (
            <CapRow key={o.org} label={name(o.org)} use={o} />
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <SectionLabel className="mt-1">Holds</SectionLabel>
        {status.holds.length === 0 ? (
          <p className="text-sm text-fg-faint">Nothing holds new work.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {status.holds.map((h) => (
              <li key={`${h.kind}:${h.id ?? ""}`} className="text-sm text-amber text-pretty">
                {h.text}
                {h.until && <span className="text-fg-faint"> Until {clockTime(h.until, now)}.</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <SectionLabel className="mt-1">Accounts</SectionLabel>
        {status.accounts.length === 0 ? (
          <p className="text-sm text-fg-faint">No accounts with usage windows.</p>
        ) : (
          <ul className="flex flex-col">
            {status.accounts.map((a) => (
              <AccountRow key={a.id} account={a} floors={settings.floors} now={now} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
