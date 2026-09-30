import {
  type AccountView,
  type AgentEntry,
  currentOrgId,
  type OrgView,
  type ToolInfo,
  type UsageTotals,
} from "@majhi/shared";
import { Plus, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { Dot, toneText } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import type { RosterRow } from "@/features/board/roster";
import { CostText } from "@/features/usage/cost";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatAgo, formatTokens, plural } from "@/lib/format";
import { useAccountModels, useHideModel, useRefreshUsage } from "@/lib/studio-queries";
import { HealthSteps } from "./health-steps";
import { authInfo, orgLabel, statusText } from "./model";
import { agentsByAccount, usedByGroups, whereLabel } from "./used-by-model";
import { WindowMeter } from "./window-meter";

export type AccountAction = "health" | "signin" | "remove";

/** The picked account: how it is doing and what to do about it, its limits, who uses it, its models and settings. */
export function AccountDetail({
  account,
  tool,
  orgs,
  agents,
  lamps,
  week,
  now,
  onAction,
}: {
  account: AccountView;
  tool: ToolInfo | undefined;
  orgs: readonly OrgView[];
  agents: readonly AgentEntry[];
  lamps: ReadonlyMap<string, RosterRow>;
  /** Tokens and cost this week: null when nothing ran, undefined while loading. */
  week: UsageTotals | null | undefined;
  now: number;
  onAction: (action: AccountAction) => void;
}) {
  const status = statusText(account, now);
  const auth = authInfo(account);
  const org = orgLabel(account.org, orgs);
  const orgKey = orgs.find((o) => o.id === currentOrgId(account.org))?.key;
  const used = agentsByAccount(agents).get(account.id) ?? [];
  const groups = usedByGroups(used, orgs);
  const toolName = tool?.name ?? account.tool;

  return (
    <DetailPane
      label="Account details"
      head={
        <div className="flex min-w-0 items-center gap-3">
          <OrgBadge
            label={badgeLetters(orgKey ?? org.name)}
            color={org.color}
            className="size-8 rounded-lg text-xs"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate font-mono text-md leading-6 font-semibold">{account.id}</h2>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
              <span className="truncate">
                {toolName}
                {account.usage?.plan && `, ${account.usage.plan} plan`}
                {account.auth === "api-key" && ", API key"}
              </span>
              <span aria-hidden="true" className="text-fg-dim">
                ·
              </span>
              <span className="shrink-0">{org.name}</span>
            </p>
          </div>
          <dl className="ml-auto flex shrink-0 items-baseline gap-5 text-sm">
            <div className="flex items-baseline gap-1.5">
              <dt className="sr-only">Tokens this week</dt>
              <dd className="tnum m-0 font-mono text-md text-fg">{formatTokens(week?.totalTokens ?? 0)}</dd>
              <span className="text-fg-muted">tokens</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="sr-only">Cost this week</dt>
              <dd className="m-0">
                <CostText
                  totals={week ?? { costUsd: 0, estimatedUsd: 0 }}
                  className="font-mono text-md text-fg"
                />
              </dd>
              <span className="text-fg-muted">this week</span>
            </div>
          </dl>
        </div>
      }
    >
      <DetailSection
        title="Status"
        className="border-t-0"
        actions={
          <>
            <Button size="sm" onClick={() => onAction("health")} aria-label={`Health check ${account.id}`}>
              Health check
            </Button>
            {account.auth === "login" && (
              <Button size="sm" onClick={() => onAction("signin")} aria-label={`Sign in again ${account.id}`}>
                Sign in again
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAction("remove")}
              aria-label={`Remove ${account.id}`}
            >
              Remove
            </Button>
          </>
        }
      >
        <div className="grid gap-x-8 gap-y-4 @[720px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] content-start gap-x-4 gap-y-2.5 text-base">
            <Fact label="Status">
              <span className={cn("inline-flex items-center gap-2", toneText(status.tone))}>
                <Dot tone={status.tone} size={7} />
                {status.label}
              </span>
            </Fact>
            <Fact label="Sign-in">
              <span className={cn("inline-flex items-center gap-2", toneText(auth.tone))}>
                <Dot tone={auth.tone} size={7} />
                {auth.label}
              </span>
            </Fact>
            {account.signedInAs && (
              <Fact label="Signed in as">
                <span className="block truncate font-mono text-sm text-fg-soft" title={account.signedInAs}>
                  {account.signedInAs}
                </span>
              </Fact>
            )}
            {account.usage?.plan && <Fact label="Plan">{account.usage.plan}</Fact>}
            <Fact label="Used by">{plural(account.agentCount, "agent")}</Fact>
          </dl>
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-fg-faint">
              Last health check
              {account.lastHealth && <>, {formatAgo(account.lastHealth.checkedAt, now)}</>}
            </span>
            {account.lastHealth ? (
              <HealthSteps health={account.lastHealth} />
            ) : (
              <span className="text-base text-fg-muted">Not checked yet.</span>
            )}
          </div>
        </div>
      </DetailSection>

      <Limits account={account} week={week} now={now} />

      <DetailSection
        title="Used by"
        note={plural(used.length, "agent")}
        actions={
          <Button asChild size="sm">
            <PageLink page="agents" search={{ account: account.id }}>
              <Plus aria-hidden="true" />
              New agent on it
            </PageLink>
          </Button>
        }
      >
        {groups.length === 0 ? (
          <p className="text-sm text-fg-faint">No agent uses this account yet.</p>
        ) : (
          <div className="grid gap-x-8 gap-y-4 @[720px]:grid-cols-2">
            {groups.map((group) => (
              <section
                key={group.scope}
                aria-label={`Used by, ${group.label}`}
                className="flex min-w-0 flex-col gap-1"
              >
                <h4 className="flex items-center gap-2 text-sm font-medium text-fg-soft">
                  {group.color && (
                    <span
                      aria-hidden="true"
                      className="size-2 rounded-xs"
                      style={{ backgroundColor: group.color }}
                    />
                  )}
                  {group.label}
                </h4>
                <ul className="flex flex-col">
                  {group.agents.map((a) => {
                    const f = a.agent.frontmatter;
                    const lamp = lamps.get(f.id);
                    const state = lamp?.lamp ?? "idle";
                    return (
                      <li
                        key={f.id}
                        className="flex min-w-0 flex-col gap-0.5 border-t border-line py-2 first:border-t-0"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <PageLink
                            page="agents"
                            search={{ agent: f.id }}
                            className="min-w-0 truncate rounded-xs font-mono text-sm text-fg underline-offset-2 hover:underline"
                          >
                            @{f.id}
                          </PageLink>
                          {a.isBoss && <span className="shrink-0 text-xs text-accent-text">Boss</span>}
                          <span
                            className={cn(
                              "ml-auto flex shrink-0 items-center gap-1.5 text-xs",
                              LAMP_TEXT[state],
                            )}
                          >
                            <Lamp state={state} size={7} />
                            {lamp?.state ?? "Idle"}
                          </span>
                        </span>
                        <span className="truncate text-xs text-fg-faint">
                          {f.role}, model {f.model ?? "account default"}, effort{" "}
                          {f.effort ?? "account default"}. Works in {whereLabel(f.where, orgs)}.
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </DetailSection>

      <DetailSection title="Models" note="A hidden model is left out of auto picks and fallback tiers.">
        <ModelSwitches account={account} />
      </DetailSection>

      <DetailSection title="Settings" note="Set when the account was added.">
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-base">
          <Fact label="Tool">{toolName}</Fact>
          <Fact label="Signs in with">
            {account.auth === "login" ? "The tool's own sign-in" : "An API key, kept in majhi's secrets"}
          </Fact>
          <Fact label="Org">
            <span className="inline-flex items-center gap-2">
              <OrgBadge label={badgeLetters(orgKey ?? org.name)} color={org.color} size="xs" />
              {org.name}
            </span>
          </Fact>
        </dl>
        <p className="text-sm text-fg-faint text-pretty">
          To use another org or sign-in, add a new account there and move the agents over.
        </p>
      </DetailSection>
    </DetailPane>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm leading-5 text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0 text-fg-soft">{children}</dd>
    </>
  );
}

/**
 * The 5-hour and weekly windows with their reset times, then the per-model weekly ones, with when they
 * were read and a Refresh. API-key accounts pay per token and have no windows.
 */
function Limits({
  account,
  week,
  now,
}: {
  account: AccountView;
  week: UsageTotals | null | undefined;
  now: number;
}) {
  const refresh = useRefreshUsage();
  const usage = account.usage;
  const hasWindows = usage?.window !== undefined || usage?.weekly !== undefined;
  const error = refresh.isError ? describeError(refresh.error) : usage?.error;
  if (account.auth === "api-key") {
    return (
      <DetailSection title="Limits">
        <p className="text-base text-fg-muted">
          Pays per token, no usage windows.{" "}
          {week && week.turns > 0 ? (
            <span className="text-fg-soft">
              <CostText totals={week} /> and {formatTokens(week.totalTokens)} tokens this week.
            </span>
          ) : (
            "Tokens and cost show after the first run."
          )}
        </p>
      </DetailSection>
    );
  }
  return (
    <DetailSection
      title="Limits"
      note={usage && hasWindows ? `Read ${formatAgo(usage.updatedAt, now)}` : undefined}
      actions={
        <>
          <Button asChild size="sm" variant="ghost">
            <PageLink page="usage">Health and usage</PageLink>
          </Button>
          <Button size="sm" onClick={() => refresh.mutate(account.id)} disabled={refresh.isPending}>
            <RefreshCw aria-hidden="true" className={cn(refresh.isPending && "animate-spin")} />
            {refresh.isPending ? "Reading" : "Refresh"}
          </Button>
        </>
      }
    >
      {hasWindows ? (
        <div className="grid gap-x-8 gap-y-3.5 @[720px]:grid-cols-2">
          {usage?.window && <WindowMeter label="5 hours" window={usage.window} now={now} />}
          {usage?.weekly && <WindowMeter label="Week" window={usage.weekly} now={now} />}
          {usage?.models.map((m) => (
            <WindowMeter key={m.label} label={`Week, ${m.label}`} window={m} now={now} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-fg-faint">No usage read yet.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red">
          Last read failed: {error}
        </p>
      )}
    </DetailSection>
  );
}

/** The models the account offers, each with a Hide switch: a hidden model is left out of `auto` picks. */
function ModelSwitches({ account }: { account: AccountView }) {
  const models = useAccountModels(account.id);
  const hide = useHideModel();
  if (models.isPending) return <span className="text-sm text-fg-faint">Loading</span>;
  if (models.isError)
    return (
      <span className="text-sm text-fg-faint">Could not read the models: {describeError(models.error)}</span>
    );
  const list = models.data.models.filter((m) => m.id !== "default");
  if (list.length === 0) return <span className="text-sm text-fg-faint">The account offers no models.</span>;
  return (
    <div className="flex flex-col gap-1">
      <ul className="m-0 grid list-none gap-x-8 p-0 @[720px]:grid-cols-2">
        {list.map((m) => (
          <li key={m.id}>
            <Switch
              label={`Hide ${m.id}`}
              checked={account.hiddenModels.includes(m.id)}
              disabled={hide.isPending}
              onChange={(hidden) => hide.mutate({ id: account.id, model: m.id, hidden })}
            />
          </li>
        ))}
      </ul>
      <span className="text-sm text-fg-faint text-pretty">An agent set to a hidden model still gets it.</span>
      {hide.isError && <span className="text-sm text-red">{describeError(hide.error)}</span>}
    </div>
  );
}
