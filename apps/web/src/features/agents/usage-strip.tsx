import type { AccountView } from "@majhi/shared";
import { Dot, toneText } from "@/components/ui/status-dot";
import { UsageBar } from "@/components/ui/usage-bar";
import { authInfo, barTone, formatPct, resetLabel, statusInfo } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import type { AgentState } from "./model";

/** Status, auth and the account's two usage windows, from what majhi last read. Spends nothing. */
export function UsageStrip({
  state,
  account,
  accountId,
  now,
}: {
  state: AgentState;
  account: AccountView | undefined;
  accountId: string;
  now: number;
}) {
  const auth = account ? authInfo(account) : undefined;
  const window = account?.usage?.window;
  const weekly = account?.usage?.weekly;
  const status = account ? statusInfo(account.status) : undefined;
  return (
    <section
      aria-label="Status and usage"
      className="grid grid-cols-4 gap-x-[10px] rounded-lg border border-line-strong bg-card px-3.5 py-3"
    >
      <Cell label="Status">
        <span className={cn("flex items-center gap-1.5 text-base", toneText(state.tone))}>
          <Dot tone={state.tone} size={7} />
          {state.label}
        </span>
        {status && state.kind === "idle" && (
          <span className="sr-only">Account {status.label.toLowerCase()}</span>
        )}
      </Cell>
      <Cell label="Auth">
        {auth ? (
          <span className={cn("text-base", toneText(auth.tone))}>{auth.label}</span>
        ) : (
          <span className="text-base text-red">No account</span>
        )}
      </Cell>
      <Cell label={`${accountId} · current window`}>
        {account?.auth === "api-key" ? (
          <span className="text-base text-fg-muted">Tokens and cost show after the first run</span>
        ) : window ? (
          <Meter
            pct={window.usedPct}
            text={`${formatPct(window.usedPct)}${window.resetsAt ? ` · resets ${resetLabel(window.resetsAt, now)}` : ""}`}
          />
        ) : (
          <span className="text-base text-fg-muted">
            {account?.usage?.error ? "Usage unavailable" : "No usage yet"}
          </span>
        )}
      </Cell>
      <Cell label="Weekly">
        {account?.auth === "api-key" ? (
          <span className="text-base text-fg-faint">Not applicable</span>
        ) : weekly ? (
          <Meter pct={weekly.usedPct} text={formatPct(weekly.usedPct)} />
        ) : (
          <span className="text-base text-fg-muted">No usage yet</span>
        )}
      </Cell>
    </section>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="truncate text-xs text-fg-faint">{label}</span>
      {children}
    </div>
  );
}

function Meter({ pct, text }: { pct: number; text: string }) {
  const tone = barTone(pct);
  return (
    <>
      <span className={cn("text-base tabular-nums", toneText(tone))}>{text}</span>
      <UsageBar pct={pct} tone={tone} height={4} />
    </>
  );
}
