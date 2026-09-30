import { collapseHome } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { toneText } from "@/components/ui/status-dot";
import { HealthDialog } from "@/features/accounts/health-dialog";
import { BossConversation } from "@/features/boss/boss-conversation";
import { SshNotice } from "@/features/repos/ssh-notice";
import { EditRootsDialog } from "@/features/roots/edit-roots-dialog";
import { useMountNow } from "@/features/roots/use-mount-now";
import { cn } from "@/lib/cn";
import { useConfig, useHostStatus, useRepos } from "@/lib/queries";
import { useAccounts, useAgentHealth, useAgents, useOrgs } from "@/lib/studio-queries";
import { reopenOnboarding } from "@/onboarding/reopen";
import { DecisionsPanel } from "./decisions-panel";
import { HistoryPanel } from "./history-panel";
import { MemoryPanel } from "./memory-panel";
import { accountsCard, agentsCard, bossCard, type CardState, readyCount, rootsCard, sshCard } from "./model";
import { SettingsPanel } from "./settings-panel";

/**
 * Hub setup. On the left, the conversation with the boss, who sets things up as the owner asks.
 * On the right, the setup cards, the last changes with Undo, and the settings.
 */
export function SetupView() {
  const config = useConfig();
  const repos = useRepos(true);
  const host = useHostStatus();
  const accounts = useAccounts();
  const agents = useAgents();
  const orgs = useOrgs();
  const agentHealth = useAgentHealth();
  const [editingRoots, setEditingRoots] = useState(false);
  const [checkingBoss, setCheckingBoss] = useState<string>();
  const state = config.data;
  const home = state?.home ?? "";
  const mount = useMountNow(home);

  const roots = state?.status === "loaded" ? state.config.workspaces : [];
  const rootsState = rootsCard(
    repos.data?.roots,
    roots.map((r) => collapseHome(r, home)),
  );
  const ssh = sshCard(host.data);
  const acc = accountsCard(accounts.data);
  const ag = agentsCard(agents.data, orgs.data ?? []);
  const boss = bossCard(agents.data, accounts.data);
  const ready = readyCount([rootsState, ssh, acc, ag, boss]);
  const needsMount = repos.data?.roots.some((r) => !r.mounted) ?? false;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Hub setup"
        subtitle="Talk to the boss to set up orgs, accounts and agents. Every change is a commit you can undo."
      />
      <div className="flex min-h-0 flex-1 gap-6 px-8 pt-5 pb-6">
        <section
          aria-label="Setup conversation"
          className="flex min-h-0 min-w-0 max-w-[720px] flex-1 flex-col gap-3"
        >
          <BossConversation />
        </section>

        <aside
          aria-label="Setup today"
          className="flex w-[420px] shrink-0 flex-col gap-2.5 overflow-auto pr-1 pb-6 scroll-fade"
        >
          <div className="flex items-baseline gap-2">
            <h2 className="text-md font-semibold">Setup today</h2>
            <span className="text-sm text-fg-faint">{ready} of 5 ready</span>
          </div>

          <Card
            title="Workspace roots"
            state={rootsState}
            actions={
              <>
                {needsMount && mount.canMount && (
                  <Button size="sm" onClick={mount.mountNow} disabled={mount.pending}>
                    {mount.pending ? "Mounting" : "Mount now"}
                  </Button>
                )}
                <Button size="sm" onClick={() => setEditingRoots(true)}>
                  Edit roots
                </Button>
              </>
            }
          />
          <Card title="SSH keys" state={ssh} />
          <SshNotice />
          <Card
            title="Accounts"
            state={acc}
            actions={
              <Button asChild size="sm">
                <PageLink page="accounts">
                  {accounts.data?.length ? "Manage accounts" : "Add account"}
                </PageLink>
              </Button>
            }
          />
          <Card
            title="Agents"
            state={ag}
            actions={
              <Button asChild size="sm">
                <PageLink page="agents">Open Agents</PageLink>
              </Button>
            }
          />
          <Card
            title="Boss"
            state={boss}
            actions={
              boss.id ? (
                <Button size="sm" onClick={() => setCheckingBoss(boss.id)}>
                  Health check
                </Button>
              ) : (
                <Button size="sm" onClick={() => reopenOnboarding("boss")}>
                  Choose the boss
                </Button>
              )
            }
          />
          <p className="text-sm leading-[1.45] text-fg-faint">
            majhi reads config files and public keys only. Passphrases and API keys go to the macOS Keychain
            and never to a file.
          </p>
          <div>
            <Button size="sm" onClick={() => reopenOnboarding("roots")}>
              Run first-time setup again
            </Button>
          </div>
          <div className="mt-3 flex flex-col gap-5">
            <HistoryPanel />
            <DecisionsPanel />
            <MemoryPanel />
            <SettingsPanel />
          </div>
        </aside>
      </div>

      {editingRoots && <EditRootsDialog onClose={() => setEditingRoots(false)} />}
      {mount.modal}
      {checkingBoss && (
        <HealthDialog
          title={`Health check: @${checkingBoss}`}
          run={() => agentHealth.mutateAsync(checkingBoss)}
          onClose={() => setCheckingBoss(undefined)}
        />
      )}
    </div>
  );
}

function Card({ title, state, actions }: { title: string; state: CardState; actions?: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex items-center gap-3 rounded-[10px] border border-line-strong bg-card p-3 transition-colors hover:border-line-hover"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">{title}</h3>
          <span
            className={cn(
              "text-xs",
              state.tone === "green"
                ? toneText("green")
                : state.tone === "coral"
                  ? "text-coral"
                  : state.tone === "blue"
                    ? "text-blue"
                    : "text-fg-faint",
            )}
          >
            {state.pill}
          </span>
        </div>
        <p className="text-sm leading-[1.4] break-words whitespace-pre-line text-fg-muted">{state.detail}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-col gap-1.5">{actions}</div>}
    </section>
  );
}
