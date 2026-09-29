import type { AccountView, AgentLive } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, RefreshCcw } from "lucide-react";
import { useId, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { PageLink } from "@/components/ui/page-link";
import { toneText } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { statusText } from "@/features/accounts/model";
import { WindowLine } from "@/features/accounts/usage-view";
import { PERMS } from "@/features/agents/model";
import type { AgentInfo } from "@/lib/agent-index";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatAgo } from "@/lib/format";
import { type AgentState, agentDot, contextMeter, nowDoingLine } from "./model";

const STATE_TEXT = {
  amber: "text-amber",
  violet: "text-violet",
  red: "text-red",
  muted: "text-fg-muted",
  faint: "text-fg-dim",
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
  defaultOpen,
}: {
  task: string;
  id: string;
  live: AgentLive | undefined;
  info: AgentInfo | undefined;
  state: AgentState;
  account: AccountView | undefined;
  now: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();
  const line = nowDoingLine(live);
  const idle = line === "Idle";
  return (
    <div className="flex flex-col border-t border-line-strong pt-2.5">
      <div className="flex h-11 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          title={open ? "Hide details" : "Show details"}
          className="-ml-1 flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-1 text-left hover:bg-raised"
          onClick={() => setOpen((o) => !o)}
        >
          <AgentAvatar id={id} size={28} dot={agentDot(live)} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-mono text-base font-medium">@{id}</span>
              {info && (
                <span className="shrink-0 rounded-sm bg-selected px-1.5 py-0.5 text-xs text-fg-soft">
                  {info.role}
                </span>
              )}
              {/* The second line already says Idle. */}
              {state.label !== "Idle" && (
                <span className={cn("shrink-0 whitespace-nowrap text-xs", STATE_TEXT[state.tone])}>
                  {state.label}
                </span>
              )}
              {live && live.queued > 0 && (
                <span className="tnum shrink-0 whitespace-nowrap text-xs text-fg-faint">
                  · {live.queued} queued
                </span>
              )}
            </span>
            <span
              aria-live="polite"
              title={idle ? undefined : line}
              className={cn("truncate text-xs", idle ? "text-fg-dim" : "text-fg-faint")}
            >
              {line}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 shrink-0 text-fg-faint transition-transform", open && "rotate-180")}
          />
        </button>
        {live && <FreshButton task={task} agent={id} />}
      </div>
      {open && <AgentDetails id={detailsId} agent={id} live={live} info={info} account={account} now={now} />}
    </div>
  );
}

/** The open row: the account's limits, then context, model, effort, permissions and fallback. */
function AgentDetails({
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
    <div id={id} className="flex flex-col gap-3 pt-2.5 pb-1">
      {info && <AccountLimits accountId={info.account} account={account} now={now} />}
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
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
      <div className="flex gap-4 text-sm">
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
    <section aria-label={`Limits of ${accountId}`} className="flex flex-col gap-2">
      <span className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="truncate font-mono text-fg-soft">{accountId}</span>
        {usage?.plan && <span className="shrink-0 text-fg-faint">{usage.plan}</span>}
        {status && (
          <span className={cn("ml-auto shrink-0 text-xs", toneText(status.tone))}>{status.label}</span>
        )}
      </span>
      {!account ? (
        <span className="text-sm text-red">This account is not set up.</span>
      ) : account.auth === "api-key" ? (
        <span className="text-sm text-fg-faint">API key: no 5-hour or weekly limits.</span>
      ) : hasWindows && usage ? (
        <>
          {usage.window && <WindowLine label="5-hour" window={usage.window} />}
          {usage.weekly && <WindowLine label="Weekly" window={usage.weekly} />}
          {usage.models.map((m) => (
            <WindowLine key={m.label} label={`Weekly, ${m.label}`} window={m} />
          ))}
          <span className="text-xs text-fg-faint">
            Read {formatAgo(usage.updatedAt, now)}
            {usage.error && <span className="text-red"> · last read failed</span>}
          </span>
        </>
      ) : (
        <span className="text-sm text-fg-faint">
          {usage?.error ? "Usage unavailable" : "No usage read yet"}
        </span>
      )}
    </section>
  );
}

/** A thin bar: how much of the agent's context window is in use. */
function ContextMeter({ share, label, agent }: { share: number; label: string; agent: string }) {
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
