import type { AccountView, AgentEntry, OrgView, ToolInfo } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";
import { formatAgo } from "@/lib/format";
import { HealthSteps } from "./health-steps";
import { orgLabel, statusInfo } from "./model";
import { UsageDetails } from "./usage-view";
import { agentsByAccount, usedByGroups, whereLabel } from "./used-by-model";

/** The selected account in full: what it is, how it is doing, and every agent that uses it. */
export function AccountDetails({
  account,
  tool,
  orgs,
  agents,
  now,
  onClose,
}: {
  account: AccountView;
  tool: ToolInfo | undefined;
  orgs: readonly OrgView[];
  agents: readonly AgentEntry[];
  now: number;
  onClose: () => void;
}) {
  const status = statusInfo(account.status);
  const org = orgLabel(account.org, orgs);
  const groups = usedByGroups(agentsByAccount(agents).get(account.id) ?? [], orgs);

  return (
    <aside
      aria-label="Account details"
      className="flex w-[380px] shrink-0 flex-col border-l border-line-strong bg-rail"
    >
      <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
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
      <dl className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
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
          <span className={cn("inline-flex items-center gap-2", TONE_TEXT[status.tone])}>
            <StatusDot tone={status.tone} />
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
                        <li key={f.id} className="rounded-md border border-line-strong bg-card px-2.5 py-2">
                          <Link
                            to="/studio/$tab"
                            params={{ tab: "agents" }}
                            search={{ agent: f.id }}
                            className="font-mono text-base text-fg hover:underline"
                          >
                            @{f.id}
                            {a.isBoss && <span className="ml-2 font-sans text-xs text-amber">Boss</span>}
                          </Link>
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
