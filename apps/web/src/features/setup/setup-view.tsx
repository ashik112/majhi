import { collapseHome, EDITOR_LABEL, type Settings } from "@majhi/shared";
import { MessageSquare } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AppearanceControls } from "@/components/shell/appearance";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DetailPane,
  DetailSection,
  ListDetail,
  ListPane,
  ROW,
  ROW_SELECTED,
} from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { HealthDialog } from "@/features/accounts/health-dialog";
import { useBoss } from "@/features/boss/boss-context";
import { EditRootsDialog } from "@/features/roots/edit-roots-dialog";
import { useMountNow } from "@/features/roots/use-mount-now";
import { ACCENT_LABEL, useAppearance } from "@/lib/appearance";
import { useBackups } from "@/lib/backup-queries";
import { useSettings } from "@/lib/boss-queries";
import { cn } from "@/lib/cn";
import { useContainers } from "@/lib/container-queries";
import { useDecisionsStatus } from "@/lib/decisions-queries";
import { describeError } from "@/lib/errors";
import { MOD_KEY } from "@/lib/format";
import { useConfig, useHostStatus, useRepos } from "@/lib/queries";
import { useAccounts, useAgentHealth, useAgents, useOrgs } from "@/lib/studio-queries";
import { reopenOnboarding } from "@/onboarding/reopen";
import { useSearchParam } from "@/pages/parts/url-state";
import { ApprovalsSection, policyStatus } from "./approvals-panel";
import { BackupsSection } from "./backups-panel";
import { ContainersSection } from "./containers-panel";
import { DecisionsSection, firstProvider } from "./decisions-panel";
import { E2eSection } from "./e2e-panel";
import { EditorSection } from "./editor-panel";
import { HistorySection } from "./history-panel";
import { MemorySection } from "./memory-panel";
import { accountsCard, agentsCard, bossCard, readyCount, rootsCard, sshCard } from "./model";
import { NotificationsSection } from "./notifications-panel";
import { RulesPanel } from "./rules-panel";
import { isSetupSection, SECTION_ABOUT, SECTION_TITLE, SETUP_GROUPS, type SetupSection } from "./sections";
import { ContextSection, TeamsSection, TurnsSection } from "./settings-panel";
import {
  OverviewSection,
  PageButton,
  type ReadinessRow,
  RootsSection,
  SshSection,
  StateWord,
} from "./workspace-sections";

/**
 * Hub setup as a settings hub: the sections on the left, the picked one on the right. Overview says
 * what majhi still needs; every other section edits one part of majhi.yaml, saved per section as a
 * change that can be undone. The boss is one click (or Cmd+J) away in its drawer.
 */
export function SetupView() {
  const config = useConfig();
  const repos = useRepos(true);
  const host = useHostStatus();
  const accounts = useAccounts();
  const agents = useAgents();
  const orgs = useOrgs();
  const agentHealth = useAgentHealth();
  const settings = useSettings();
  const decisions = useDecisionsStatus();
  const containers = useContainers();
  const backups = useBackups();
  const appearance = useAppearance();
  const boss = useBoss();
  const [param, setParam] = useSearchParam("section");
  const [editingRoots, setEditingRoots] = useState(false);
  const [checkingBoss, setCheckingBoss] = useState<string>();
  const section: SetupSection = isSetupSection(param) ? param : "overview";

  const state = config.data;
  const home = state?.home ?? "";
  const mount = useMountNow(home);
  const configured = state?.status === "loaded" ? state.config.workspaces : [];
  const roots = rootsCard(
    repos.data?.roots,
    configured.map((r) => collapseHome(r, home)),
  );
  const ssh = sshCard(host.data);
  const acc = accountsCard(accounts.data);
  const ag = agentsCard(agents.data, orgs.data ?? []);
  const bossState = bossCard(agents.data, accounts.data);
  const ready = readyCount([roots, ssh, acc, ag, bossState]);
  const needsMount = repos.data?.roots.some((r) => !r.mounted) ?? false;

  const rootActions = (
    <>
      {needsMount && mount.canMount && (
        <Button size="sm" variant="primary" onClick={mount.mountNow} disabled={mount.pending}>
          {mount.pending ? "Mounting" : "Mount now"}
        </Button>
      )}
      <Button size="sm" onClick={() => setEditingRoots(true)}>
        Edit folders
      </Button>
    </>
  );
  const readiness: ReadinessRow[] = [
    {
      section: "roots",
      title: "Project folders",
      state: roots,
      action:
        needsMount && mount.canMount ? (
          <Button size="sm" variant="primary" onClick={mount.mountNow} disabled={mount.pending}>
            {mount.pending ? "Mounting" : "Mount now"}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setEditingRoots(true)}>
            Edit folders
          </Button>
        ),
    },
    {
      section: "ssh",
      title: "SSH keys",
      state: ssh,
      action: (
        <Button size="sm" onClick={() => setParam("ssh")}>
          {ssh.tone === "coral" ? "Fix keys" : "Open"}
        </Button>
      ),
    },
    {
      section: undefined,
      title: "Accounts",
      state: acc,
      action: (
        <PageButton page="accounts">{accounts.data?.length ? "Manage accounts" : "Add account"}</PageButton>
      ),
    },
    {
      section: undefined,
      title: "Agents",
      state: ag,
      action: <PageButton page="agents">Open Agents</PageButton>,
    },
    {
      section: undefined,
      title: "Boss",
      state: bossState,
      action: bossState.id ? (
        <Button size="sm" onClick={() => setCheckingBoss(bossState.id)}>
          Health check
        </Button>
      ) : (
        <Button size="sm" onClick={() => reopenOnboarding("boss")}>
          Choose the boss
        </Button>
      ),
    },
  ];

  const s = settings.data;
  const status: Record<SetupSection, ReactNode> = {
    overview: (
      <StateWord state={{ pill: `${ready} of 5 ready`, tone: ready === 5 ? "green" : "coral", detail: "" }} />
    ),
    roots: <StateWord state={roots} />,
    ssh: <StateWord state={ssh} />,
    decisions: firstProvider(decisions.data),
    memory: s && (s.memory.housekeeper ? `Housekeeper @${s.memory.housekeeper}` : "Housekeeper: the boss"),
    context:
      s &&
      `${s.context.cap > 0 ? `${s.context.cap / 1000}k cap` : "No cap"}, compact at ${Math.round(s.context.compact_at * 100)}%, ${s.limits.agents_max} agents at once`,
    turns: s && turnsStatus(s.turns),
    teams: s && `${s.rooms.review_rounds} review rounds`,
    approvals: s && policyStatus(s.policy),
    notifications: s && notificationsStatus(s.notifications),
    editor: s && EDITOR_LABEL[s.editor.app],
    e2e: s && (Object.values(s.e2e.projects).some((on) => !on) ? "Off for some projects" : "On for majhi"),
    containers: containersStatus(containers.data),
    appearance: `${appearance.theme[0]?.toUpperCase()}${appearance.theme.slice(1)}, ${ACCENT_LABEL[appearance.accent]}`,
    backups: backupsStatus(backups.data),
    history: "Undo any change",
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Hub setup"
        subtitle="What majhi needs to run, and how it behaves. Every change is a commit you can undo."
      >
        <Button onClick={boss.show} aria-pressed={boss.open}>
          <MessageSquare aria-hidden="true" />
          Ask the boss
          <Kbd className="ml-1">{MOD_KEY} J</Kbd>
        </Button>
      </PageHeader>
      <ListDetail>
        <ListPane label="Setup sections">
          <div className="flex flex-col gap-3">
            {SETUP_GROUPS.map((group) => (
              <section key={group.label} aria-label={group.label} className="flex flex-col gap-px">
                <h2 className="flex h-8 items-center pl-2.5 text-sm font-medium text-fg-faint">
                  {group.label}
                </h2>
                <ul className="flex flex-col gap-px">
                  {group.sections.map((id) => (
                    <li key={id}>
                      <SectionRow
                        title={SECTION_TITLE[id]}
                        status={status[id]}
                        selected={section === id}
                        onSelect={() => setParam(id === "overview" ? undefined : id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ListPane>
        <DetailPane
          key={section}
          label={SECTION_TITLE[section]}
          head={
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="text-md leading-6 font-semibold">{SECTION_TITLE[section]}</h2>
              <p className="truncate text-sm text-fg-muted">{SECTION_ABOUT[section]}</p>
            </div>
          }
        >
          {section === "overview" && (
            <OverviewSection rows={readiness} ready={ready} onOpen={(id) => setParam(id)} />
          )}
          {section === "roots" && (
            <RootsSection
              roots={repos.data?.roots}
              configured={configured}
              home={home}
              state={roots}
              actions={rootActions}
            />
          )}
          {section === "ssh" && <SshSection host={host.data} state={ssh} />}
          {section === "decisions" && <DecisionsSection />}
          {section === "memory" && (
            <WithSettings settings={settings}>{(data) => <MemorySection saved={data.memory} />}</WithSettings>
          )}
          {section === "context" && (
            <WithSettings settings={settings}>{(data) => <ContextSection settings={data} />}</WithSettings>
          )}
          {section === "turns" && (
            <WithSettings settings={settings}>{(data) => <TurnsSection settings={data} />}</WithSettings>
          )}
          {section === "teams" && (
            <WithSettings settings={settings}>{(data) => <TeamsSection settings={data} />}</WithSettings>
          )}
          {section === "approvals" && (
            <>
              <WithSettings settings={settings}>
                {(data) => <ApprovalsSection settings={data} />}
              </WithSettings>
              <RulesPanel />
            </>
          )}
          {section === "notifications" && (
            <WithSettings settings={settings}>
              {(data) => <NotificationsSection saved={data.notifications} />}
            </WithSettings>
          )}
          {section === "editor" && (
            <WithSettings settings={settings}>{(data) => <EditorSection saved={data.editor} />}</WithSettings>
          )}
          {section === "e2e" && (
            <WithSettings settings={settings}>
              {(data) => <E2eSection saved={data.e2e.projects} />}
            </WithSettings>
          )}
          {section === "containers" && <ContainersSection />}
          {section === "appearance" && (
            <DetailSection
              title="Theme and accent"
              note="The same as the sidebar's Appearance button"
              className="border-t-0"
            >
              <AppearanceControls className="max-w-[320px]" />
            </DetailSection>
          )}
          {section === "backups" && <BackupsSection />}
          {section === "history" && <HistorySection />}
        </DetailPane>
      </ListDetail>

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

function notificationsStatus(n: Settings["notifications"]): string {
  if (!n.mac && !n.browser) return "Off";
  return n.mac && n.browser ? "Mac and browser" : n.mac ? "Mac" : "Browser";
}

function containersStatus(data: ReturnType<typeof useContainers>["data"]): string | undefined {
  if (data === undefined) return undefined;
  if (!data.available) return "Off";
  const n = data.containers.filter((c) => c.status === "running").length;
  return n === 0 ? "Nothing running" : `${n} running`;
}

function backupsStatus(data: ReturnType<typeof useBackups>["data"]): string | undefined {
  if (data === undefined) return undefined;
  return data.pending ? "Restore waiting" : data.lastDaily ? "Daily, 7 kept" : "No snapshot yet";
}

function WithSettings({
  settings,
  children,
}: {
  settings: ReturnType<typeof useSettings>;
  children: (data: Settings) => ReactNode;
}) {
  if (settings.isPending) return <p className="pt-5 text-sm text-fg-faint">Loading</p>;
  if (settings.isError) return <p className="pt-5 text-sm text-red">{describeError(settings.error)}</p>;
  return children(settings.data);
}

function SectionRow({
  title,
  status,
  selected,
  onSelect,
}: {
  title: string;
  status: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        ROW,
        "min-h-[46px] flex-col justify-center gap-0.5 px-2.5 py-1.5",
        selected && ROW_SELECTED,
      )}
    >
      <span className={cn("text-body font-medium", selected ? "text-fg" : "text-fg-soft")}>{title}</span>
      {status !== undefined && status !== null && status !== false && (
        <span className="min-w-0 truncate text-xs text-fg-faint">{status}</span>
      )}
    </button>
  );
}

/** "2h turns, idle 25m", or "No limits". */
function turnsStatus(t: Settings["turns"]): string {
  const parts = [
    ...(t.max_length === "off" ? [] : [`${t.max_length} turns`]),
    ...(t.idle === "off" ? [] : [`idle ${t.idle}`]),
    ...(t.max_tool_calls > 0 ? [`${t.max_tool_calls} tool calls`] : []),
  ];
  return parts.length === 0 ? "No limits" : parts.join(", ");
}
