import { collapseHome } from "@majhi/shared";
import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLink } from "@/components/ui/page-link";
import { toneText } from "@/components/ui/status-dot";
import { HealthDialog } from "@/features/accounts/health-dialog";
import { SshNotice } from "@/features/repos/ssh-notice";
import { EditRootsDialog } from "@/features/roots/edit-roots-dialog";
import { useMountNow } from "@/features/roots/use-mount-now";
import { cn } from "@/lib/cn";
import { useConfig, useHostStatus, useRepos } from "@/lib/queries";
import { useAccounts, useAgentHealth, useAgents, useOrgs } from "@/lib/studio-queries";
import { reopenOnboarding } from "@/onboarding/reopen";
import { accountsCard, agentsCard, bossCard, type CardState, readyCount, rootsCard, sshCard } from "./model";

/**
 * Hub setup. The boss will run setup as a conversation here in Phase 2b; until then the page shows
 * what majhi can set up today, one card each.
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
        subtitle="What majhi needs to run agents on your machine. Everything here stays editable in Agents and Orgs."
      />
      <div className="flex min-h-0 flex-1 gap-6 px-8 pt-5 pb-6">
        <div className="flex min-w-0 flex-1 items-start">
          <section
            aria-label="Setup conversation"
            className="flex w-full max-w-[640px] flex-col gap-5 rounded-xl border border-line-strong bg-raised p-6"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-green-wash text-green">
                <MessagesSquare aria-hidden="true" className="size-[18px]" />
              </span>
              <div className="flex flex-col gap-0.5">
                <h2 className="text-md font-semibold">Soon the boss will run setup with you</h2>
                <p className="text-sm text-fg-muted">A conversation in this space, arriving in Phase 2b.</p>
              </div>
            </div>
            <ol className="flex flex-col gap-3">
              {[
                [
                  "It looks around",
                  "Reads your workspace folders, git remotes and ~/.ssh/config. Config files and public keys only.",
                ],
                [
                  "It drafts, you decide",
                  "Orgs, accounts and agents come as drafts, one question at a time. Everything stays editable.",
                ],
                [
                  "It writes after you confirm",
                  "Nothing lands in your config until you say so, and every change is a commit you can undo.",
                ],
              ].map(([title, body], i) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-line-bright font-mono text-xs text-fg-muted">
                    {i + 1}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-base font-medium">{title}</span>
                    <span className="text-sm text-fg-muted text-pretty">{body}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="border-t border-line-strong pt-4 text-sm text-fg-muted">
              Until then, the cards on the right set up what majhi needs today.
            </p>
            <div>
              <Button onClick={() => reopenOnboarding("roots")}>Run first-time setup again</Button>
            </div>
          </section>
        </div>

        <aside aria-label="Setup today" className="flex w-[420px] shrink-0 flex-col gap-2.5 overflow-auto">
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
                <PageLink page="usage">
                  {accounts.data?.length ? "Health and accounts" : "Add account"}
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
      className="flex items-center gap-3 rounded-[10px] border border-line-strong bg-raised p-3 transition-colors hover:border-line-hover"
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
        <p className="font-mono text-sm leading-[1.4] break-words whitespace-pre-line text-fg-muted">
          {state.detail}
        </p>
      </div>
      {actions && <div className="flex shrink-0 flex-col gap-1.5">{actions}</div>}
    </section>
  );
}
