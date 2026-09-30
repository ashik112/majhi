import type { AccountView, AgentEntry, OrgView, ToolInfo } from "@majhi/shared";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PageLink } from "@/components/ui/page-link";
import { Dot, toneText } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useAccountModels, useHideModel } from "@/lib/studio-queries";
import { HealthSteps } from "./health-steps";
import { orgLabel, statusText } from "./model";
import { UsageDetails } from "./usage-view";
import { agentsByAccount, usedByGroups, whereLabel } from "./used-by-model";

export type AccountAction = "health" | "signin" | "remove";

/** The selected account in full: what it is, how it is doing, and every agent that uses it. */
export function AccountDetails({
  account,
  tool,
  orgs,
  agents,
  now,
  onClose,
  onAction,
}: {
  account: AccountView;
  tool: ToolInfo | undefined;
  orgs: readonly OrgView[];
  agents: readonly AgentEntry[];
  now: number;
  onClose: () => void;
  onAction: (action: AccountAction) => void;
}) {
  const status = statusText(account, now);
  const org = orgLabel(account.org, orgs);
  const groups = usedByGroups(agentsByAccount(agents).get(account.id) ?? [], orgs);

  return (
    <aside aria-label="Account details" className="flex h-full w-full flex-col bg-rail">
      <div className="flex items-center gap-2 border-b border-line-strong px-5 py-3.5">
        <h2 className="min-w-0 truncate font-mono text-md font-semibold">{account.id}</h2>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-sm"
          aria-label="Close account details"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <dl className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 pt-4 pb-6 scroll-fade">
        <Row label="Tool">{tool?.name ?? account.tool}</Row>
        <Row label="Org">
          <span className="inline-flex items-center gap-2">
            {org.color && (
              <span aria-hidden="true" className="size-2 rounded-xs" style={{ backgroundColor: org.color }} />
            )}
            {org.name}
          </span>
        </Row>
        <Row label="Signs in with">{account.auth === "login" ? "The tool's own sign-in" : "An API key"}</Row>
        <Row label="Status">
          <span className={cn("inline-flex items-center gap-2", toneText(status.tone))}>
            <Dot tone={status.tone} size={7} />
            {status.label}
          </span>
          {account.signedInAs && (
            <span className="block font-mono text-sm text-fg-faint">{account.signedInAs}</span>
          )}
        </Row>
        <Row label="Usage">
          <UsageDetails account={account} now={now} />
        </Row>
        <Row label="Last health check">
          {account.lastHealth ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm text-fg-faint">{formatAgo(account.lastHealth.checkedAt, now)}</span>
              <HealthSteps health={account.lastHealth} />
            </div>
          ) : (
            <span className="text-fg-faint">Not checked yet</span>
          )}
        </Row>
        <Row label="Models">
          <ModelSwitches account={account} />
        </Row>
        <Row label="Used by">
          {groups.length === 0 ? (
            <span className="text-fg-faint">Not used</span>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((group) => (
                <section
                  key={group.scope}
                  aria-label={`Used by, ${group.label}`}
                  className="flex flex-col gap-1.5"
                >
                  <h3 className="flex items-center gap-2 text-xs tracking-[0.08em] text-fg-faint uppercase">
                    {group.color && (
                      <span
                        aria-hidden="true"
                        className="size-2 rounded-xs"
                        style={{ backgroundColor: group.color }}
                      />
                    )}
                    {group.label}
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {group.agents.map((a) => {
                      const f = a.agent.frontmatter;
                      return (
                        <li key={f.id} className="rounded-lg border border-line-strong bg-card px-2.5 py-2">
                          <PageLink
                            page="agents"
                            search={{ agent: f.id }}
                            className="font-mono text-base text-fg hover:underline"
                          >
                            @{f.id}
                            {a.isBoss && (
                              <span className="ml-2 font-sans text-xs text-accent-text">Boss</span>
                            )}
                          </PageLink>
                          <span className="block text-sm text-fg-muted">
                            {f.role}, model {f.model ?? "account default"}, effort{" "}
                            {f.effort ?? "account default"}
                          </span>
                          <span className="block text-sm text-fg-faint">
                            Works in: {whereLabel(f.where, orgs)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Row>
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-line-strong px-5 py-3">
        <Button onClick={() => onAction("health")} aria-label={`Health check ${account.id}`}>
          Check now
        </Button>
        {account.auth === "login" && (
          <Button onClick={() => onAction("signin")} aria-label={`Sign in again ${account.id}`}>
            Sign in again
          </Button>
        )}
        <Button
          className="ml-auto"
          variant="ghost"
          onClick={() => onAction("remove")}
          aria-label={`Remove ${account.id}`}
        >
          Remove
        </Button>
      </div>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-fg-faint">{label}</dt>
      <dd className="m-0 text-base text-fg-soft">{children}</dd>
    </div>
  );
}

/** The models the account offers, each with a Hide switch: a hidden model is left out of `auto` picks. */
function ModelSwitches({ account }: { account: AccountView }) {
  const models = useAccountModels(account.id);
  const hide = useHideModel();
  if (models.isPending) return <span className="text-fg-faint">Loading</span>;
  if (models.isError)
    return <span className="text-fg-faint">Could not read the models: {describeError(models.error)}</span>;
  const list = models.data.models.filter((m) => m.id !== "default");
  if (list.length === 0) return <span className="text-fg-faint">The account offers no models</span>;
  return (
    <div className="flex flex-col gap-1">
      <ul className="m-0 flex list-none flex-col p-0">
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
      <span className="text-sm text-fg-faint text-pretty">
        A hidden model is left out of auto picks and fallback tiers. An agent set to that model still gets it.
      </span>
      {hide.isError && <span className="text-sm text-red">{describeError(hide.error)}</span>}
    </div>
  );
}
