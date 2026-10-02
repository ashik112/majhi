import type { AccountUsage, AccountView, AgentLive } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { PageLink } from "@/components/ui/page-link";
import { toneText } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { UsageBar } from "@/components/ui/usage-bar";
import { barTone, formatPct, resetFull, statusText } from "@/features/accounts/model";
import { PERMS } from "@/features/agents/model";
import type { AgentInfo } from "@/lib/agent-index";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { type AgentState, agentDot, contextMeter, nowDoingLine } from "./model";

const STATE_TEXT = {
  working: "text-lamp-working",
  needs: "text-lamp-needs",
  paused: "text-lamp-paused",
  red: "text-red",
  muted: "text-fg-muted",
  faint: "text-fg-faint",
} as const;

/**
 * One agent under "In this room". The row has a fixed height and always shows what the agent is
 * doing, so it never jumps while the agent works. Clicking it opens the details in place.
 */
export function AgentRow({
  task,
  id,
  live,
  info,
  state,
  account,
  now,
  change,
  showFresh = false,
}: {
  task: string;
  id: string;
  live: AgentLive | undefined;
  info: AgentInfo | undefined;
  state: AgentState;
  account: AccountView | undefined;
  now: number;
  /** The Change agent control, on the task's own agent. */
  change?: ReactNode;
  /** A Fresh session button on the row; team tasks have it in the member menu instead. */
  showFresh?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const tick = useNow(live?.status === "working" ? 5_000 : 60_000);
  const quiet = silentFor(live, tick);
  const turn = turnLength(live, tick);
  // A turn with nothing new on screen for a while still says what it is in: the tool, or thinking.
  const line = quiet === undefined ? nowDoingLine(live) : `${live?.nowDoing ?? "Thinking"}, ${quiet}`;
  const idle = line === "Idle";
  return (
    <div className="flex flex-col border-t border-line-strong pt-1">
      <div className="flex h-10 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          title={open ? "Hide details" : "Show details"}
          className="-ml-1 flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-1 text-left hover:bg-raised"
          onClick={() => setOpen((o) => !o)}
        >
          <AgentAvatar id={id} size={24} dot={agentDot(live)} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-mono text-sm font-medium">@{id}</span>
              {turn && (
                <span title="How long this turn has run" className="tnum shrink-0 text-xs text-fg-faint">
                  turn {turn}
                </span>
              )}
            </span>
            {/*
              State first, then what it is doing: the row keeps one height while the agent works.
              While it is doing something, that line takes the place of the role and the state
              word (the lamp on the avatar shows the state), so it is never cut to nothing.
            */}
            <span aria-live="polite" className="flex min-w-0 items-baseline gap-1.5 text-xs">
              {idle ? (
                <>
                  {info && <span className="shrink-0 text-fg-faint">{info.role} ·</span>}
                  <span className={cn("min-w-0 truncate", STATE_TEXT[state.tone])}>{state.label}</span>
                </>
              ) : (
                <span
                  title={`${state.label}: ${line}`}
                  className={cn("min-w-[6.5rem] truncate", STATE_TEXT[state.tone])}
                >
                  {line}
                </span>
              )}
              {live && live.queued > 0 && (
                <span className="tnum min-w-0 truncate whitespace-nowrap text-fg-faint">
                  · {live.queued} queued
                </span>
              )}
              {/* Limits sit on this line, so the name above keeps the full width. */}
              {account?.usage && (
                <span className="ml-auto pl-1.5">
                  <LimitsSummary usage={account.usage} />
                </span>
              )}
            </span>
          </span>
        </button>
        {change}
        {showFresh && live && <FreshButton task={task} agent={id} />}
      </div>
      {open && <AgentDetails id={detailsId} agent={id} live={live} info={info} account={account} now={now} />}
    </div>
  );
}

/**
 * Only while working: how long the agent has sent nothing, once that passes 20 seconds. Counted
 * from its last event, or from the start of the turn when that is later (a turn that has said
 * nothing yet).
 */
function silentFor(live: AgentLive | undefined, now: number): string | undefined {
  if (live?.status !== "working") return undefined;
  const since = Math.max(
    live.activeAt === undefined ? 0 : Date.parse(live.activeAt),
    live.turnAt === undefined ? 0 : Date.parse(live.turnAt),
  );
  if (since === 0) return undefined;
  const ms = now - since;
  if (!(ms > 20_000)) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)} min`;
}

/** While working: how long the current turn has run, like `45s`, `12 min` or `1h 05m`. */
function turnLength(live: AgentLive | undefined, now: number): string | undefined {
  if (live?.status !== "working" || live.turnAt === undefined) return undefined;
  const s = Math.max(0, Math.floor((now - Date.parse(live.turnAt)) / 1000));
  if (Number.isNaN(s)) return undefined;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The open row: the account's limits, then context, model, effort, permissions and fallback. */
export function AgentDetails({
  id,
  agent,
  live,
  info,
  account,
  now,
}: {
  id: string;
  agent: string;
  live: AgentLive | undefined;
  info: AgentInfo | undefined;
  account: AccountView | undefined;
  now: number;
}) {
  const meter = contextMeter(live?.usage);
  const perms = PERMS.filter((p) => info?.perms.includes(p.id)).map((p) => p.label);
  return (
    <div id={id} className="flex flex-col gap-2.5 pt-1.5 pb-2">
      {info && <AccountLimits accountId={info.account} account={account} now={now} />}
      <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-fg-faint">Context</dt>
        <dd>
          {meter ? (
            <ContextMeter share={meter.share} label={meter.label} agent={agent} />
          ) : (
            <span className="text-fg-faint">{live ? "No reading yet" : "Not started"}</span>
          )}
        </dd>
        <dt className="text-fg-faint">Model</dt>
        <dd className="truncate font-mono">{live?.model ?? info?.model ?? "Account default"}</dd>
        <dt className="text-fg-faint">Effort</dt>
        <dd className="truncate font-mono">{live?.effort ?? info?.effort ?? "Default"}</dd>
        <dt className="text-fg-faint">Permissions</dt>
        <dd>{perms.length > 0 ? perms.join(", ") : "None, asks each time"}</dd>
        <dt className="text-fg-faint">Fallback</dt>
        <dd className="truncate font-mono">{info?.fallback ? `@${info.fallback}` : "None"}</dd>
      </dl>
      <div className="flex gap-4 text-xs">
        <PageLink page="agents" search={{ agent }} className="text-blue hover:underline">
          Edit agent
        </PageLink>
        {info && (
          <PageLink page="accounts" search={{ account: info.account }} className="text-blue hover:underline">
            Check account
          </PageLink>
        )}
      </div>
    </div>
  );
}

/** The account's 5-hour, weekly and per-model weekly windows, from what majhi last read. */
function AccountLimits({
  accountId,
  account,
  now,
}: {
  accountId: string;
  account: AccountView | undefined;
  now: number;
}) {
  const status = account ? statusText(account, now) : undefined;
  const usage = account?.usage;
  const hasWindows =
    usage?.window !== undefined || usage?.weekly !== undefined || (usage?.models.length ?? 0) > 0;
  return (
    <section aria-label={`Limits of ${accountId}`} className="flex flex-col gap-1.5">
      <span className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="truncate font-mono text-fg-soft">{accountId}</span>
        {usage?.plan && <span className="shrink-0 text-fg-faint">{usage.plan}</span>}
        {status && (
          <span className={cn("ml-auto shrink-0 text-xs", toneText(status.tone))}>{status.label}</span>
        )}
      </span>
      {!account ? (
        <span className="text-xs text-red">This account is not set up.</span>
      ) : account.auth === "api-key" ? (
        <span className="text-xs text-fg-faint">API key: no 5-hour or weekly limits.</span>
      ) : hasWindows && usage ? (
        <>
          {usage.window && <LimitLine label="5-hour" window={usage.window} />}
          {usage.weekly && <LimitLine label="Weekly" window={usage.weekly} />}
          {usage.models.map((m) => (
            <LimitLine key={m.label} label={`Weekly, ${m.label}`} window={m} />
          ))}
          <span className="text-xs text-fg-faint">
            Read {formatAgo(usage.updatedAt, now)}
            {usage.error && <span className="text-red"> · last read failed</span>}
          </span>
        </>
      ) : (
        <span className="text-xs text-fg-faint">
          {usage?.error ? "Usage unavailable" : "No usage read yet"}
        </span>
      )}
    </section>
  );
}

/** "5h 48% · wk 74%" in the row, so the limits read without opening it. */
function LimitsSummary({ usage }: { usage: AccountUsage }) {
  const parts = [
    usage.window && { key: "5h", pct: usage.window.usedPct },
    usage.weekly && { key: "wk", pct: usage.weekly.usedPct },
  ].filter((p) => p !== undefined);
  if (parts.length === 0) return null;
  return (
    <span className="tnum flex shrink-0 gap-2 text-xs whitespace-nowrap" title="Account limits used">
      {parts.map((p) => (
        <span key={p.key} className="whitespace-nowrap">
          <span className="text-fg-faint">{p.key}</span>{" "}
          <span className={toneText(barTone(p.pct))}>{formatPct(p.pct)}</span>
        </span>
      ))}
    </span>
  );
}

/** One window on one line: label, bar, share used; the reset time is in the tooltip and on the right. */
function LimitLine({
  label,
  window,
}: {
  label: string;
  window: { usedPct: number; resetsAt?: string | undefined };
}) {
  const tone = barTone(window.usedPct);
  return (
    <span
      className="grid grid-cols-[92px_minmax(0,1fr)_36px] items-center gap-2 text-xs"
      title={window.resetsAt ? `Resets ${resetFull(window.resetsAt)}` : undefined}
    >
      <span className="truncate text-fg-soft">{label}</span>
      <UsageBar pct={window.usedPct} tone={tone} height={3} />
      <span className={cn("tnum text-right", toneText(tone))}>{formatPct(window.usedPct)}</span>
    </span>
  );
}

/** A thin bar: how much of the agent's context window is in use. */
export function ContextMeter({ share, label, agent }: { share: number; label: string; agent: string }) {
  const percent = Math.round(share * 100);
  return (
    <span className="flex items-center gap-2" title={`Context: ${label} tokens`}>
      <meter
        className="sr-only"
        aria-label={`Context of @${agent}`}
        aria-valuetext={`${label} tokens`}
        min={0}
        max={100}
        value={percent}
      />
      {/* The native meter is for assistive tech; this bar is what the eye reads. */}
      <span aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-selected">
        <span
          className={cn("block h-full rounded-full", share >= 0.8 ? "bg-amber" : "bg-fg-dim")}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="tnum shrink-0 text-xs text-fg-faint">{label}</span>
    </span>
  );
}

/** Replaces the agent's session with a fresh one that carries a handoff note (5.13). */
function FreshButton({ task, agent }: { task: string; agent: string }) {
  const toast = useToast();
  const fresh = useMutation<unknown, ApiRequestError>({
    mutationFn: () => cmd("room.fresh", { task, agent }, { reason: "Owner pressed Fresh session" }),
    onError: (error) => toast("Could not start a fresh session", { detail: error.message, tone: "error" }),
  });
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="size-7 shrink-0"
      aria-label={`Fresh session for @${agent}`}
      title="Fresh session: start over with a handoff note"
      disabled={fresh.isPending}
      onClick={() => fresh.mutate()}
    >
      <RefreshCcw aria-hidden="true" />
    </Button>
  );
}
