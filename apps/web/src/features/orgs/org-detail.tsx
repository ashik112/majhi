import {
  type AccountView,
  type AgentEntry,
  collapseHome,
  type OrgView,
  type ProjectView,
  type ToolInfo,
  type UsageTotals,
} from "@majhi/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { Dot, toneText } from "@/components/ui/status-dot";
import { statusText } from "@/features/accounts/model";
import type { RosterRow } from "@/features/board/roster";
import { CostText } from "@/features/usage/cost";
import { cn } from "@/lib/cn";
import { badgeLetters, plural } from "@/lib/format";
import { useConfig } from "@/lib/queries";
import { useNow } from "@/lib/use-now";
import { GitAccounts } from "./git-accounts";
import { OrgSettings } from "./org-settings";
import { TrackerSettings } from "./tracker-settings";

const ROW = "flex min-h-9 min-w-0 items-center gap-3 border-t border-line py-1.5 first:border-t-0";

/** One org: its accounts, agents and projects, then its settings, each editable where it sits. */
export function OrgDetail({
  org,
  accounts,
  agents,
  projects,
  tools,
  lamps,
  openTasks,
  month,
  onAddAccount,
  onRenamed,
}: {
  org: OrgView;
  accounts: readonly AccountView[];
  agents: readonly AgentEntry[];
  projects: readonly ProjectView[];
  tools: readonly ToolInfo[] | undefined;
  lamps: ReadonlyMap<string, RosterRow>;
  openTasks: number;
  month: UsageTotals | undefined;
  onAddAccount: () => void;
  onRenamed: (id: string) => void;
}) {
  const now = useNow(60_000);
  const home = useConfig().data?.home;
  const own = agents.flatMap((e) => (e.status === "ok" && e.agent.frontmatter.scope === org.id ? [e] : []));
  return (
    <DetailPane
      label={org.name}
      head={
        <div className="flex min-w-0 items-center gap-3">
          <OrgBadge label={badgeLetters(org.key)} color={org.color} className="size-8 rounded-lg text-xs" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate text-md leading-6 font-semibold">{org.name}</h2>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
              <span className="font-mono text-fg-faint">{org.id}</span>
              <span aria-hidden="true" className="text-fg-dim">
                ·
              </span>
              <span>
                Task key <span className="font-mono text-fg-soft">{org.key}</span>
              </span>
            </p>
          </div>
          <dl className="ml-auto flex shrink-0 items-baseline gap-5 text-sm">
            <div className="flex items-baseline gap-1.5">
              <dt className="sr-only">Open tasks</dt>
              <dd className="tnum m-0 font-mono text-md text-fg">{openTasks}</dd>
              <span className="text-fg-muted">open</span>
            </div>
            {month && (
              <div className="flex items-baseline gap-1.5">
                <dt className="sr-only">Cost this month</dt>
                <dd className="m-0">
                  <CostText totals={month} className="font-mono text-md text-fg" />
                </dd>
                <span className="text-fg-muted">this month</span>
              </div>
            )}
          </dl>
        </div>
      }
    >
      <div className="grid gap-x-8 @[820px]:grid-cols-2">
        <DetailSection
          title="Accounts"
          note={plural(accounts.length, "account")}
          actions={
            <Button size="sm" onClick={onAddAccount} aria-label={`Add account to ${org.name}`}>
              <Plus aria-hidden="true" />
              Add account
            </Button>
          }
          className="border-t-0"
        >
          {accounts.length === 0 ? (
            <p className="text-sm text-fg-faint">No accounts yet. Agents in this workspace need one.</p>
          ) : (
            <ul aria-label={`Accounts of ${org.name}`} className="flex flex-col">
              {accounts.map((account) => {
                const status = statusText(account, now);
                return (
                  <li key={account.id} className={ROW}>
                    <PageLink
                      page="accounts"
                      search={{ account: account.id }}
                      className="min-w-0 truncate rounded-xs font-mono text-sm text-fg underline-offset-2 hover:underline"
                    >
                      {account.id}
                    </PageLink>
                    <span className="shrink-0 text-xs text-fg-faint">
                      {tools?.find((t) => t.id === account.tool)?.name ?? account.tool}
                    </span>
                    <span
                      className={cn(
                        "ml-auto flex shrink-0 items-center gap-1.5 text-xs",
                        toneText(status.tone),
                      )}
                    >
                      <Dot tone={status.tone} size={7} />
                      {status.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </DetailSection>

        <DetailSection
          title="Agents"
          note={plural(own.length, "agent")}
          actions={
            <Button asChild size="sm">
              <PageLink page="agents" search={{ create: org.id }} aria-label={`New agent in ${org.name}`}>
                <Plus aria-hidden="true" />
                New agent
              </PageLink>
            </Button>
          }
          className="@[820px]:border-t-0"
        >
          {own.length === 0 ? (
            <p className="text-sm text-fg-faint">No agents yet. Root agents can still work here.</p>
          ) : (
            <ul aria-label={`Agents of ${org.name}`} className="flex flex-col">
              {own.map((entry) => {
                const f = entry.agent.frontmatter;
                const lamp = lamps.get(f.id);
                const state = lamp?.lamp ?? "idle";
                return (
                  <li key={f.id} className={ROW}>
                    <PageLink
                      page="agents"
                      search={{ agent: f.id }}
                      className="min-w-0 truncate rounded-xs font-mono text-sm text-fg underline-offset-2 hover:underline"
                    >
                      @{f.id}
                    </PageLink>
                    <span className="shrink-0 text-xs text-fg-faint">{f.role}</span>
                    <span
                      className={cn("ml-auto flex shrink-0 items-center gap-1.5 text-xs", LAMP_TEXT[state])}
                    >
                      <Lamp state={state} size={7} />
                      {lamp?.state ?? "Idle"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </DetailSection>
      </div>

      <DetailSection
        title="Projects"
        note={plural(projects.length, "repo")}
        actions={
          <Button asChild size="sm" variant="ghost">
            <PageLink page="projects">Projects and links</PageLink>
          </Button>
        }
      >
        {projects.length === 0 ? (
          <p className="text-sm text-fg-faint">No repos registered for this workspace yet.</p>
        ) : (
          <ul aria-label={`Projects of ${org.name}`} className="flex flex-col">
            {projects.map((p) => (
              <li key={p.id} className={ROW}>
                <span className="w-[180px] shrink-0 truncate font-mono text-sm text-fg">{p.id}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-faint" title={p.path}>
                  {home ? collapseHome(p.path, home) : p.path}
                </span>
                {p.exists ? (
                  p.base && <span className="shrink-0 font-mono text-xs text-fg-muted">{p.base}</span>
                ) : (
                  <span className="shrink-0 text-xs text-red">Not found on disk</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <GitAccounts key={`git-${org.id}`} org={org} />

      <TrackerSettings key={`tracker-${org.id}`} org={org} projects={projects} />

      <OrgSettings key={org.id} org={org} onRenamed={onRenamed} />
    </DetailPane>
  );
}
