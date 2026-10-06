import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Command, dockerTty, localSpawner, orphanRuns } from "@majhi/acp";
import {
  BUILT_IN_CONNECT_APPS,
  DEFAULT_GIT_HOST,
  failureFromError,
  GLOBAL_CONNECTIONS,
  isOwnerChat,
  MAP_BRIEF_LINES,
  type MrHost,
  NotificationsSettingsSchema,
  PRIVATE,
  type ServiceEntry,
  type TaskId,
  textValue,
  UPDATE_STATUS_FILE,
  UpdateStatusSchema,
} from "@majhi/shared";
import { AccountCache } from "./accounts/cache.ts";
import { AccountProbes } from "./accounts/health.ts";
import { startLogin } from "./accounts/login.ts";
import { AccountService } from "./accounts/service.ts";
import { AccountUsageReader, UsageSweeper } from "./accounts/usage.ts";
import { AdminAccess } from "./admin/access.ts";
import { findBossChat, isBossChat } from "./admin/boss.ts";
import { AdminService } from "./admin/service.ts";
import { AdminTokens } from "./admin/tokens.ts";
import { AgendaRepo } from "./agenda/repo.ts";
import { AgendaService } from "./agenda/service.ts";
import { AgentService } from "./agents/service.ts";
import { AgentStore } from "./agents/store.ts";
import { createActionHost } from "./automation/host.ts";
import { type Automation, createAutomation } from "./automation/index.ts";
import { watchIdOf } from "./automation/migrate.ts";
import { ScheduleRepo } from "./automation/schedules.ts";
import { AutonomyDriver } from "./autonomy/driver.ts";
import { AutonomyService, zoneOr } from "./autonomy/service.ts";
import { Background } from "./background.ts";
import { BackupService } from "./backup/service.ts";
import { alertLine } from "./budgets/alert-line.ts";
import { atLimit, liftLimits } from "./budgets/limit-action.ts";
import { BudgetMonitor } from "./budgets/monitor.ts";
import { BudgetAlertRepo } from "./budgets/repo.ts";
import { freshCaptainAfterUpdate } from "./captain/fresh-after-update.ts";
import { Lanes } from "./captain/lanes.ts";
import { authorityOf, workspaceIds } from "./captain/levels.ts";
import { LoopGuard } from "./captain/loop-guard.ts";
import { CaptainRepo } from "./captain/repo.ts";
import { CaptainService } from "./captain/service.ts";
import { CaptainTell } from "./captain/tell.ts";
import { captainWorld } from "./captain/world.ts";
import type { Dispatch } from "./commands/dispatch.ts";
import { resolvePath } from "./config/load.ts";
import { connectionScopes } from "./config/sections.ts";
import { ConfigService } from "./config/service.ts";
import { AppClientStore } from "./connect/app-client.ts";
import { hostCli } from "./connect/cli-connect.ts";
import { GrantStore } from "./connect/grant.ts";
import { McpUrlService } from "./connect/mcp-url.ts";
import { assertHostAllowed, type Lookup } from "./connect/self-host.ts";
import { ConnectService } from "./connect/service.ts";
import { type BrowserServer, RUNNER_BROWSERS_PATH } from "./connections/browser.ts";
import { GitLink } from "./connections/git-link.ts";
import { ConnectionHealthService } from "./connections/health.ts";
import { probePort } from "./connections/host-probe.ts";
import { LiveHostServices } from "./connections/live-host.ts";
import { listTools, remoteTransport } from "./connections/mcp-client.ts";
import { type GitProvider, type PlanDeps, planConnections } from "./connections/plan.ts";
import { redactSecrets } from "./connections/redact.ts";
import type { RemoteRunFn } from "./connections/remote.ts";
import { sweepRunFiles } from "./connections/run-files.ts";
import { ConnectionService, connectionDir } from "./connections/service.ts";
import { ConnectionTester } from "./connections/tester.ts";
import { TOOLS_TARGET } from "./containers/args.ts";
import { DockerCli } from "./containers/docker.ts";
import { ImageCheckFailed, runImageCheck } from "./containers/image-check.ts";
import { type ContainerDocker, ContainerService } from "./containers/service.ts";
import { ConversationsService } from "./conversations/service.ts";
import { AcpProvider } from "./decisions/acp.ts";
import { builtinRegistry } from "./decisions/builtinSlots.ts";
import { CalibrationStore } from "./decisions/calibrationStore.ts";
import { EvalStore } from "./decisions/evalStore.ts";
import { LabelStore } from "./decisions/labels.ts";
import { dockerCli, LayaDocker } from "./decisions/layaDocker.ts";
import { LayaProvider } from "./decisions/layaProvider.ts";
import { DecisionLog } from "./decisions/log.ts";
import { rulesProvider } from "./decisions/rules.ts";
import { DecisionService } from "./decisions/service.ts";
import { DecideTokens } from "./decisions/tokens.ts";
import { layaEvalRunner } from "./decisions/uses/weekly-eval.ts";
import type { ServerEnv } from "./env.ts";
import { errorMessage, UserError } from "./errors.ts";
import { EventHub } from "./events/hub.ts";
import { HomeWatcher } from "./events/watcher.ts";
import { FindingsRepo } from "./findings/repo.ts";
import { FindingsService } from "./findings/service.ts";
import { triageFinding } from "./findings/triage.ts";
import { git } from "./git/git.ts";
import { GitLoginService } from "./git/logins.ts";
import { checkGitToken } from "./gitConnect/check.ts";
import type { Fetch } from "./gitConnect/http.ts";
import { TokenRefused } from "./gitConnect/http.ts";
import { createGitConnect, createGitTokens, type GitConnect, pushAuthFor } from "./gitConnect/wire.ts";
import { HomeChecks } from "./handoff/home-checks.ts";
import { DEFAULT_HANDOFF_MEMORY, defaultHandoffCpus } from "./handoff/limits.ts";
import { MergeGate } from "./handoff/merge-gate.ts";
import { shipReadiness } from "./handoff/ready.ts";
import type { HandoffService } from "./handoff/service.ts";
import { createHandoff, type HandoffWiring } from "./handoff/wire.ts";
import type { HostLink } from "./host/link.ts";
import { RecommendationRepo } from "./inbox/recommendations.ts";
import { InboxService } from "./inbox/service.ts";
import { InstallRequests } from "./installs/service.ts";
import { busyReason } from "./machine/busy.ts";
import { MemoryWatch } from "./machine/memwatch.ts";
import { MachineSensor } from "./machine/sensor.ts";
import { GraphRunner, graphFolder } from "./map/graph/run.ts";
import { CodeGraphTools } from "./map/graph/tools.ts";
import { housekeeperPrice } from "./map/price.ts";
import { MapRepo } from "./map/repo.ts";
import { MapService } from "./map/service.ts";
import { McpRegistry } from "./mcp-servers/registry.ts";
import { McpService } from "./mcp-servers/service.ts";
import { ChatMemory } from "./memory/chats.ts";
import { cleanupRepoDocFacts } from "./memory/cleanup.ts";
import { Curator } from "./memory/curator.ts";
import type { Embedder } from "./memory/embedder.ts";
import { ESCALATIONS_PER_DAY } from "./memory/escalate.ts";
import { curationTask, Extraction } from "./memory/extraction.ts";
import { Housekeeper, NoHousekeeper } from "./memory/housekeeper.ts";
import { briefAbout, Placer, type Registry } from "./memory/placement.ts";
import { Promotion } from "./memory/promote.ts";
import { LESSON_DOC_COSINE, RepoDocs } from "./memory/repo-docs.ts";
import type { MemoryService } from "./memory/service.ts";
import { landedNow } from "./memory/task-git.ts";
import { createMemory, TaskScopes } from "./memory/wiring.ts";
import { createHostGit } from "./mrs/hostGit.ts";
import { createMrHosts, type MrHostOptions } from "./mrs/hosts/index.ts";
import { MrPoller } from "./mrs/poller.ts";
import { MrService } from "./mrs/service.ts";
import type { Subject } from "./notify/attention.ts";
import { MacNotifyAccess } from "./notify/mac-access.ts";
import { Notifier } from "./notify/service.ts";
import { Unavailable } from "./ops/anything/checks.ts";
import type { WatchEngine } from "./ops/anything/engine.ts";
import { createWatchHost } from "./ops/anything/host.ts";
import { incidentLines } from "./ops/digest-lines.ts";
import type { ProbePorts } from "./ops/probes.ts";
import { opsRunners } from "./ops/runner.ts";
import type { OpsWatch } from "./ops/watch.ts";
import { createOps, type Ops } from "./ops/wire.ts";
import { mrKindOf } from "./orgs/gitAccount.ts";
import { OrgService } from "./orgs/service.ts";
import { OutcomesService } from "./outcomes/service.ts";
import { Catalog } from "./playbooks/catalog.ts";
import { parsePlan, planPrompt } from "./playbooks/custom.ts";
import { GoalsService } from "./playbooks/goals.ts";
import { OutboundGate } from "./playbooks/outbound.ts";
import { PlaybookRepo } from "./playbooks/repo.ts";
import { RULES_RUNNERS, type RulesRunner } from "./playbooks/rules.ts";
import { PlaybookService } from "./playbooks/service.ts";
import { ProcessManager } from "./processes/manager.ts";
import { suggestRepoAliases } from "./projectcard/scanner.ts";
import type { ProjectCards } from "./projectcard/service.ts";
import { createCards } from "./projectcard/wire.ts";
import { ProjectService } from "./projects/service.ts";
import { RoomService } from "./room/service.ts";
import { RoomAccess } from "./rooms/access.ts";
import { RoomCoordinator } from "./rooms/coordinator.ts";
import { IdleWatch } from "./rooms/idle-watch.ts";
import type { Inspect } from "./runner/network.ts";
import { type Runner, runnerSetup } from "./runner/setup.ts";
import { DEFAULT_IDENTITY } from "./runs/checkpoint.ts";
import { processLaunch, repoMounts } from "./runs/launch.ts";
import { limitPauseText } from "./runs/limit.ts";
import { RunManager } from "./runs/manager.ts";
import { type Probe, probeFromSetting } from "./runs/network.ts";
import { packageCache } from "./runs/package-cache.ts";
import { Resilience } from "./runs/resilience.ts";
import { SERENA_COMMAND } from "./runs/serena.ts";
import { signedIn } from "./runs/start-failure.ts";
import { type AcpRuntime, realRuntime } from "./runtime.ts";
import { classifyHost } from "./scan/remote.ts";
import { RepoScanner } from "./scan/scanner.ts";
import { KeyExports } from "./secrets/backup.ts";
import { SecretService } from "./secrets/service.ts";
import { SecretStore } from "./secrets/store.ts";
import { SkillsCli } from "./skills/cli.ts";
import { skillGitEnv } from "./skills/git-env.ts";
import { migrateAgentSkills } from "./skills/migrate.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { SkillService } from "./skills/service.ts";
import { SkillStore } from "./skills/store.ts";
import { logSqliteBaseline } from "./store/db.ts";
import { DB_FILE_NAME, Store } from "./store/index.ts";
import { pruneOld } from "./store/retention.ts";
import { CardActions } from "./tasks/card-actions.ts";
import { CleanupService } from "./tasks/cleanup.ts";
import { TaskFolderSweep } from "./tasks/folder-sweep.ts";
import type { LinkOptions } from "./tasks/links.ts";
import { PendingShips } from "./tasks/pending-ship.ts";
import { QueuedMerges } from "./tasks/queued-merge.ts";
import { TaskService } from "./tasks/service.ts";
import { TerminalManager, type TerminalTimers } from "./terminal/manager.ts";
import { openTaskTerminal } from "./terminal/task-terminal.ts";
import { ToolInstaller } from "./tools/installer.ts";
import { UploadStore } from "./uploads/store.ts";
import { readPrices } from "./usage/prices.ts";
import { UsageRecorder } from "./usage/recorder.ts";
import { UsageRepo } from "./usage/repo.ts";
import { UsageService } from "./usage/service.ts";

/** How often chats are checked for memory. */
const CHAT_SWEEP_MS = 60_000;
const RETENTION_SWEEP_MS = 24 * 60 * 60_000;
const RETENTION_FIRST_MS = 10 * 60_000;
/** How often paused budget runs are checked against the week. */
const LIMIT_SWEEP_MS = 60_000;
const AGENDA_SWEEP_MS = 60_000;
/** How often majhi looks whether the weekly prune of its old images is due. */
const PRUNE_SWEEP_MS = 86_400_000;

export interface ServiceOptions {
  /** Replaces `@majhi/acp`, so tests never start a real CLI. */
  runtime?: AcpRuntime;
  terminalTimers?: TerminalTimers;
  /** Replaces `fetch` and the limits for task links, so tests never reach the network. */
  links?: LinkOptions;
  /** Asks the host helper to load the owner's SSH keys again, for a fetch that lacked them. */
  reloadKeys?: () => Promise<boolean>;
  /** The host helper link, for Laya and wake from sleep. Without it Laya reports the helper as not connected. */
  hostLink?: HostLink;
  /** Replaces the network probe, so tests can go offline. Default: from `MAJHI_NET_PROBE`. */
  probe?: Probe;
  /** The clock of agent runs and the network watch, so tests can let time pass. */
  runClock?: () => Date;
  /** Replaces the hand-off's command runner and its timeouts, so tests never run a real project's commands. */
  handoff?: Pick<HandoffWiring, "exec" | "options">;
  /** Replaces `docker network inspect` for the runner network. */
  runnerInspect?: Inspect;
  /** Replaces the `gh` and `glab` programs, the Bitbucket API and the process runner, so tests never reach a real host. */
  mrHosts?: MrHostOptions;
  /** Seconds between checks of open merge requests. Default 60. */
  mrPollMs?: number;
  /** Laya in Docker, so tests can play laya-serve. Default: from `MAJHI_LAYA_URL`. */
  layaDocker?: LayaDocker;
  /** Replaces the embedding model, so tests never download one. */
  embedder?: Embedder;
  /** Replaces the docker CLI of the containers majhi runs for agents, so tests never start a real container. */
  containerDocker?: ContainerDocker;
  /** Replaces ssh for majhi-connections, so tests never reach a host. */
  connectionsRemote?: RemoteRunFn;
  /** How long after a turn ends a silent room is looked at. Default `IDLE_CHECK_MS`. */
  idleWatchMs?: number;
  /** Replaces `fetch` for git sign-in and the git hosts' APIs, so tests never reach a real host. */
  gitFetch?: Fetch;
  /** Replaces the ops watch's network (addresses, certificates, names), so tests never reach a real host. */
  opsProbes?: Partial<ProbePorts>;
  /** Replaces `fetch` for the phone push, so tests never reach an ntfy server. */
  ntfyFetch?: typeof fetch;
  /** The wait between a failed look and its second look. Default 15 s. */
  opsRetryMs?: number;
  /** Replaces `fetch` for Connect's sign-in calls, so tests reach a fake authorization server. */
  connectFetch?: Fetch;
  /** Replaces the service catalog, so tests connect to a fake server. */
  connectCatalog?: readonly ServiceEntry[];
  /** Replaces the DNS lookup of the self-hosted host check, so tests never resolve a real name. */
  hostLookup?: Lookup;
  /** Replaces the `skills` program, so tests never run the real CLI or reach a git host. */
  skillsCommand?: Command;
  /** Replaces `fetch` for the skills.sh directory, so tests never reach it. */
  skillsFetch?: ConstructorParameters<typeof SkillRegistry>[0];
  /** Replaces `fetch` for the MCP Registry, so tests never reach it. */
  mcpFetch?: ConstructorParameters<typeof McpRegistry>[0];
}

/** Everything the commands, the sockets and the CLI share, wired once. */
export interface Services {
  config: ConfigService;
  runtime: AcpRuntime;
  secrets: SecretStore;
  /** The passphrase-protected export of the secrets key, and which key it was. */
  keyExports: KeyExports;
  secretService: SecretService;
  /** Connections of every org: definitions, secrets, files and the last Test of each (5.14). */
  connections: ConnectionService;
  /** Connect (5.14): joining remote MCP servers with OAuth, and keeping their tokens fresh. */
  connect: ConnectService;
  /** The Test of each connection, for connections.test and the Health page. */
  connectionTests: ConnectionTester;
  /** The one state of every connection: connecting, connected, failed or needs-attention (5.14). */
  connectionHealth: ConnectionHealthService;
  /** A workspace's git host sign-in as a connection. */
  gitLink: GitLink;
  /** MCP servers by address: how they sign in, and connecting with a header token. */
  mcpUrl: McpUrlService;
  /** Starts the checks of connections: a connection for every git sign-in, one check of each connection never checked, then every few hours. */
  startConnectionChecks: () => void;
  /** Installed skills and the per-agent switches (5.2). */
  skills: SkillService;
  /** The skills store, for runs to copy from. */
  skillStore: SkillStore;
  /** Command-line tools installed into a workspace's tools folder, checked against the vendor's checksum. */
  tools: ToolInstaller;
  /** MCP servers: install as connections and the per-agent switches (5.2). */
  mcpServers: McpService;
  /** "@agent install this skill <link>" in a room (Phase 6): one approval card, then install and enable. */
  installRequests: InstallRequests;
  /** Bearer tokens of the majhi-admin MCP server, and the URL agents reach it at. */
  adminTokens: AdminTokens;
  /** The captain's tool calls, approvals and secret requests. */
  admin: AdminService;
  agents: AgentService;
  agentStore: AgentStore;
  /** The decision provider: pass it to the run manager as `Decisions`. */
  decisions: DecisionService;
  /** Bearer tokens of `majhi-decide`. */
  decideTokens: DecideTokens;
  /** Who gets majhi-room and majhi-tasks, and their tokens. */
  roomAccess: RoomAccess;
  /** Routes agent messages in team rooms (5.3). */
  coordinator: RoomCoordinator;
  orgs: OrgService;
  accounts: AccountService;
  terminals: TerminalManager;
  events: EventHub;
  watcher: HomeWatcher;
  usageSweeper: UsageSweeper;
  store: Store;
  /** The daily snapshot of majhi.db, kept 7 days, and restore (PRV-31). */
  backup: BackupService;
  uploads: UploadStore;
  projects: ProjectService;
  room: RoomService;
  runs: RunManager;
  tasks: TaskService;
  /** Push, open, watch and merge the merge requests of a task (5.5). */
  mrs: MrService;
  gitLogins: GitLoginService;
  /** Git sign-in per workspace, tokens, clone jobs, and making and publishing projects. */
  gitConnect: GitConnect;
  /** The buttons on review and paused cards. */
  cardActions: CardActions;
  pendingShips: PendingShips;
  queuedMerges: QueuedMerges;
  /** Worktrees, merged branches and room logs of tasks done for a while. */
  cleanup: CleanupService;
  /** Frees dependency folders and build output of done tasks (5.18 Cleanup). */
  folderSweep: TaskFolderSweep;
  /** The owner's computer and majhi's containers, polled every 45 s. */
  machine: MachineSensor;
  mrPoller: MrPoller;
  /** Jira, ClickUp and GitHub Issues per org: pull into Up next, push, write MR links and status back (5.11). */
  /** One notification for each thing that needs the owner: a desktop banner and a browser notice. */
  notifier: Notifier;
  /** Background processes agents start through majhi-processes (5.15). */
  processes: ProcessManager;
  /** Previews and service containers majhi runs for agents (PRV-53). */
  containers: ContainerService;
  /** Autonomous mode (PRV-74): the mode, its tasks, the run gate, spend, holds and the feed. */
  autonomy: AutonomyService;
  /** The owner's inbox of everything that waits for them (5.18). */
  inbox: InboxService;
  /** The chat dock: task rooms and captain threads with their unread counts. */
  conversations: ConversationsService;
  /** The captain per workspace (5.18): the choice, the upkeep chores, the lanes, the log and the stop switch. */
  captain: CaptainService;
  /** What playbooks and agents noticed, deduplicated (5.18, Findings). */
  findings: FindingsService;
  /** Playbooks: the one scheduler for the captain's standing work (5.18). */
  playbooks: PlaybookService;
  /** The owner's goals (5.18). */
  goals: GoalsService;
  /** The ops watch: services, incidents, escalation and the phone push (5.18). */
  ops: Ops;
  /** The outbound gate: everything that would leave the machine passes it (5.18). */
  outbound: OutboundGate;
  /** Outcomes, the scorecard, the trust ladder and the monthly ceiling (5.18). */
  outcomes: OutcomesService;
  /** The checked hand-off: tests, build, lint and a review before "Ready to ship" (5.18). */
  handoff: HandoffService;
  /** The checks of every review task in one read, for Home. */
  homeChecks: HomeChecks;
  /** The owner's agenda and the morning brief (5.18). */
  agenda: AgendaService;
  /** The project map of each workspace (5.21). */
  map: MapService;
  /** `code_graph`: agents ask a task's own repos' code graph (5.21). */
  codeGraph: CodeGraphTools;
  /** `tasks.tell`: the captain writes to a task's lead (5.18). */
  captainTell: CaptainTell;
  /** The captain's chat per workspace (5.18). */
  lanes: Lanes;
  /** The captain's chores run commands through the dispatcher, made after the services. */
  bindCaptain(dispatch: Dispatch): void;
  /** Schedules and the action runner they share with watch triggers (PRV-63). */
  automation: Automation;
  /** Project knowledge cards, refreshed when a base branch moves. */
  cards: ProjectCards;
  /** Facts, hybrid search and recall (5.6). */
  memory: MemoryService;
  /** After a task: the Housekeeper reads its room and its facts go through curation. */
  extraction: Extraction;
  /** Active project facts into the repo's AGENTS.md, through a task in review. */
  promotion: Promotion;
  /** Which scopes a task's memory covers. */
  memoryScopes: TaskScopes;
  /** Resume after restarts, lost internet and sleep, and the network watch. */
  resilience: Resilience;
  /** Tokens and cost: the queries behind `usage.*`. */
  usage: UsageService;
  /** Writes one row per agent turn. */
  usageRecorder: UsageRecorder;
  /** Weekly budgets: the check after each turn, the alerts and `budgets.status`. */
  budgets: BudgetMonitor;
  /** The runner network and config, when agents run in runner containers (MAJHI_RUNNER=container). */
  runner: Runner | undefined;
  /** Stops every agent process and closes the database. */
  close: () => Promise<void>;
  startLogin: (id: string) => Promise<{ terminalId: string; command: string }>;
  /** The task's shell, started or the one that runs (5.15). */
  openTaskTerminal: (task: string) => Promise<{ terminalId: string }>;
}

export function createServices(env: ServerEnv, options: ServiceOptions = {}): Services {
  const runtime = options.runtime ?? realRuntime;
  const config = new ConfigService({ majhiHome: env.majhiHome, hostHome: env.hostHome });
  // Hooks and chores started without waiting: `close` waits for them before the stores close.
  const background = new Background();
  // The built-in org used to be `personal`. Old files read as `private` meanwhile, so this can run late.
  background.run(
    () => config.migrateLegacyOrg(),
    (err) => console.error(`Could not rename the Personal org: ${errorMessage(err)}`),
  );
  background.run(
    () => config.migrateUpdateTargetPolicy(),
    (err) => console.error(`Could not update the branch-sync approval setting: ${errorMessage(err)}`),
  );
  const secrets = new SecretStore(env.majhiHome, env.secretsKeyFile);
  const cache = new AccountCache(env.majhiHome);
  const agentStore = new AgentStore(env.majhiHome);
  const events = new EventHub();
  const terminals = new TerminalManager(options.terminalTimers);
  const usage = new AccountUsageReader({
    majhiHome: env.majhiHome,
    runtime,
    options: env.runtime,
    cache,
    onChanged: () => events.emit(["accounts"]),
  });
  const probes = new AccountProbes({
    majhiHome: env.majhiHome,
    runtime,
    options: env.runtime,
    secrets,
    cache,
    usage,
  });
  const accounts = new AccountService({
    majhiHome: env.majhiHome,
    config,
    agents: agentStore,
    secrets,
    cache,
    probes,
    usage,
    runtime,
    options: env.runtime,
    onRemoving: (id) => terminals.killKey(`login:${id}`),
    onChanged: () => events.emit(["accounts"]),
    now: () => options.runClock?.() ?? new Date(),
  });
  const store = Store.open(env.majhiHome);
  logSqliteBaseline(store.baseline);
  const memory = createMemory(env.majhiHome, options.embedder);
  const backup = new BackupService({
    majhiHome: env.majhiHome,
    databases: () => [
      { rel: DB_FILE_NAME, backup: async (dest) => void (await store.raw.backup(dest)) },
      { rel: "memory/memory.db", backup: async (dest) => void (await memory.rawDatabase.backup(dest)) },
    ],
    history: config.history,
    key: () => secrets.identityForBackups(),
    version: { version: env.version, commit: env.commit },
    // Under docker compose the container restarts itself (restart: unless-stopped), onto the staged restore.
    ...(existsSync("/.dockerenv")
      ? { restart: () => void setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000) }
      : {}),
  });
  backup.start();
  memory.project.setLanded(async (task, repo) => {
    const found = store.tasks
      .get(task)
      ?.repos.find((r) => r.project === repo.project && r.branch === repo.branch);
    return found === undefined ? undefined : landedNow(found, repo.head);
  });
  const memoryScopes = new TaskScopes(store, config, async () =>
    Object.entries((await config.sections()).projects).map(([id, p]) => ({
      id,
      path: resolvePath(p.path, config.paths.hostHome),
      org: p.org,
    })),
  );
  const room = new RoomService(store, join(env.majhiHome, "cache", "agent-commands.json"));
  const agents = new AgentService(config, agentStore, cache, accounts, Date.now, {
    isWorking: (agent) => runs.isWorking(agent),
    renameInTasks: (agent, newId) => {
      for (const id of store.tasks.renameAgent(agent, newId)) {
        const task = store.tasks.get(id);
        if (task !== undefined) room.publishTask(task);
      }
      events.emit(["tasks"]);
    },
    renameCommands: (agent, newId) => room.renameCommands(agent, newId),
    toolsChanged: (agent) => runs.remountAgent(agent),
  });
  const runner = runnerSetup(env, options.runnerInspect, (task) => containers.taskNetworks(task), {
    taskSubnets: (task) => containers.taskSubnets(task),
    // Runners reach majhi by its name on their network, on the port it listens on (main.ts sets the MCP address).
    server: () => ({ host: env.runner.mcpHost, port: Number(new URL(adminTokens.mcpUrl).port) || env.port }),
  });
  const sessionOptions = runner.sessionOptions;
  const usageRepo = new UsageRepo(store.raw);
  const budgets = new BudgetMonitor({
    usage: usageRepo,
    alerts: new BudgetAlertRepo(store.raw),
    budgets: async () => (await config.settings()).budgets,
    announce: (alert) => {
      const task = alert.task === undefined ? undefined : store.tasks.get(alert.task);
      if (task === undefined) return;
      const { text, level } = alertLine(alert);
      room.post(task.id, `budget:${randomUUID()}`, {
        type: "system",
        level,
        text,
      });
    },
    onChange: () => events.emit(["budgets"]),
    onLimit: (alert) => atLimit(alert, runs),
    lift: async () => {
      // Marks whose time passed go first, so the lift sees the account as free.
      await accounts.expireLimits().catch(() => undefined);
      await liftLimits({
        runs,
        accountLimited: async (account) => (await accounts.limitOf(account)) !== undefined,
        autoResume: async (task) => {
          const found = store.tasks.get(task);
          return found === undefined ? true : resilience.autoResume(found);
        },
        // A run autonomous mode holds stays held when no budget does.
        limited: async (task, agent) => (await limitedRun(task, agent)) ?? autonomy.holdFor(task)?.why,
        pausedTasks: () =>
          store.tasks.getMany(store.tasks.idsWithStatus("paused")).filter((t) => t.pausedReason === "limit"),
        start: (id) => tasks.start(id, "majhi"),
      });
    },
  });
  /** The account a run of this agent in this task uses: the captain's lane account, else the agent's own. */
  const accountOfRun = async (task: string, agent: string): Promise<string | undefined> => {
    const swap = await lanes.accountFor(task, agent).catch(() => undefined);
    if (swap?.account !== undefined) return swap.account;
    const stored = await agentStore.get(agent);
    return stored === undefined ? undefined : stored.ok ? stored.agent.frontmatter.account : stored.account;
  };
  /** The account of this run and the usage limit that holds it now, if one does. */
  const accountLimitOf = async (task: string, agent: string) => {
    const account = await accountOfRun(task, agent);
    const limit = account === undefined ? undefined : await accounts.limitOf(account);
    return account === undefined || limit === undefined ? undefined : { account, limit };
  };
  /** Whether a budget holds this agent's task: its org's budget, or its account's. */
  /** Whether `candidate` can take work over now: it exists, its account is up and under its limits. */
  const canTakeOver = async (task: string, candidate: string): Promise<boolean> => {
    const target = await agentStore.get(candidate);
    if (target === undefined || !target.ok) return false;
    // The status folds in a sign-in, an unreachable account and a limit mark or a full window.
    const view = (await accounts.list().catch(() => [])).find(
      (v) => v.id === target.agent.frontmatter.account,
    );
    if (view === undefined || ["needs-login", "at-limit", "unreachable"].includes(view.status)) return false;
    return (await budgetLimited(task, candidate)) === undefined;
  };
  const budgetLimited = async (task: string, agent: string): Promise<string | undefined> => {
    const found = store.tasks.get(task);
    // The captain is how the owner raises a budget (SPEC 5.17): its chat is never held.
    if (found !== undefined && isBossChat(found)) return undefined;
    const org = found?.org ?? null;
    const stored = await agentStore.get(agent);
    const account =
      stored === undefined ? undefined : stored.ok ? stored.agent.frontmatter.account : stored.account;
    return budgets.limitedFor({ org, account, task });
  };
  /** Whether a budget or the account's usage limit holds this agent's task. */
  const limitedRun = async (task: string, agent: string): Promise<string | undefined> => {
    const budget = await budgetLimited(task, agent);
    if (budget !== undefined) return budget;
    const held = await accountLimitOf(task, agent);
    return held === undefined
      ? undefined
      : limitPauseText(held.account, held.limit.until, options.runClock?.() ?? new Date());
  };
  const usageRecorder = new UsageRecorder({
    repo: usageRepo,
    store,
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
    prices: () => readPrices(config.file),
    onRecorded: () => events.emit(["usage"]),
    afterRecord: async (turn) => {
      await budgets.afterTurn(turn);
      await autonomy.afterTurn(turn).catch(() => undefined);
    },
  });
  const usageService = new UsageService({ repo: usageRepo, config, events: store.usageEvents });
  const adminTokens = new AdminTokens(`http://127.0.0.1:${env.port}/mcp`);
  const layaDocker =
    options.layaDocker ??
    (env.laya === undefined
      ? undefined
      : new LayaDocker({
          url: env.laya.url,
          container: env.laya.container,
          docker: dockerCli(env.runner.cliEnv),
        }));
  const decideTokens = new DecideTokens();
  const decisions = new DecisionService({
    config,
    log: new DecisionLog(store.raw),
    labels: new LabelStore(store.raw),
    slots: builtinRegistry(),
    evals: new EvalStore(store.raw),
    calibrations: new CalibrationStore(store.raw),
    tokens: decideTokens,
    laya: new LayaProvider(options.hostLink, layaDocker),
    acp: new AcpProvider({
      config,
      agents: agentStore,
      secrets,
      runtime,
      options: sessionOptions,
      majhiHome: env.majhiHome,
      standIn: async () => (await decisions.settings()).acp_agent,
      usage: usageRecorder,
    }),
    rules: rulesProvider,
    secrets,
    agents: agentStore,
    adminMcpUrl: () => adminTokens.mcpUrl,
  });
  const roomAccess = new RoomAccess(
    () => adminTokens.mcpUrl,
    () => containers.available(),
  );
  // Where runs find their connections' files (5.14). In a runner, the image keeps the browsers.
  // The ports majhi itself listens on: no service on this computer may name one (5.14).
  const ownPorts = (): number[] => [
    env.port,
    ...(env.laya === undefined ? [] : [new URL(env.laya.url).port].map(Number).filter((p) => p > 0)),
  ];
  // Bearer tokens of connections signed in through Connect (5.14); bound once that service exists.
  const oauth: { bearer?: (id: string) => Promise<{ token: string } | { problem: string }> } = {};
  // A workspace signed in to a git host: bound once the git link exists.
  const gitLinkRef: {
    signedIn?: (done: {
      org: string;
      kind: MrHost;
      host: string;
      via?: "browser" | "token" | undefined;
    }) => void;
  } = {};
  // The workspaces' own git sign-ins, for `git` connections; bound once the git tokens exist.
  const gitSignIn: { token?: NonNullable<PlanDeps["gitToken"]> } = {};
  const connectionFiles = {
    connectionDir: (id: string) => connectionDir(env.majhiHome, id),
    oauth: async (id: string) => oauth.bearer?.(id) ?? { problem: "Sign-in is not ready." },
    gitToken: async (org: string, provider: GitProvider, host: string) =>
      gitSignIn.token?.(org, provider, host) ?? { problem: "Sign-in is not ready." },
    // A service on this computer is offered to a run only while its check passes (5.14).
    connected: (id: string) => connectionHealth.get(id)?.state === "connected",
    hostServices: (task: string, services: { id: string; ports: number[] }[]) =>
      containers.hostForward(task, services),
    browsersPath:
      sessionOptions.base.PLAYWRIGHT_BROWSERS_PATH ??
      (env.runner.mode === "container" ? RUNNER_BROWSERS_PATH : undefined),
  };
  // No run is alive yet: every connection folder left from before goes.
  background.run(() => sweepRunFiles(env.majhiHome));
  const runningProcesses = new Map<string, string>();
  const processes = new ProcessManager({
    spawner: sessionOptions.spawner ?? localSpawner,
    launch: async (task, agent) => {
      const launched = await processLaunch(
        {
          store,
          options: sessionOptions,
          secrets,
          majhiHome: env.majhiHome,
          agents: agentStore,
          config,
          connectionFiles,
        },
        task,
        agent,
      );
      // Bound below: the room keeps a process's secret values out too, like a session's.
      runs.rememberSecrets(task, launched.secrets ?? []);
      return launched;
    },
    onChange: (task, list) => {
      room.setProcesses(task, list);
      if (list.some((p) => p.container !== undefined)) events.emit(["containers"]);
      // Home lists what runs: tell it when one starts or ends, not for every line of output.
      const running = list
        .filter((p) => p.status === "running")
        .map((p) => p.id)
        .join(",");
      if ((runningProcesses.get(task) ?? "") !== running) {
        if (running === "") runningProcesses.delete(task);
        else runningProcesses.set(task, running);
        events.emitTask(task);
      }
    },
    // Bound below, like the run manager's callbacks.
    onEnded: (p, wakes) => background.run(() => tasks.processEnded(p, wakes)),
  });
  // Previews and services run as processes, so they need the process manager (PRV-53).
  const containerDocker =
    options.containerDocker ??
    (env.runner.mode === "container"
      ? new DockerCli({
          docker: env.runner.docker,
          cliEnv: env.runner.cliEnv,
          majhiHome: env.majhiHome,
          hostHome: env.hostHome,
          protectedPaths: [env.secretsKeyFile],
        })
      : undefined);
  const containers = new ContainerService({
    docker: containerDocker,
    processes,
    task: (id) => store.tasks.get(id),
    openTasks: () => [...store.tasks.statuses()].flatMap(([id, status]) => (status === "done" ? [] : [id])),
    settings: async () => (await config.settings()).containers,
    runnerNetwork: env.runner.network,
    runnerImage: env.runner.image,
    guardServer: () => ({
      host: env.runner.mcpHost,
      port: Number(new URL(adminTokens.mcpUrl).port) || env.port,
    }),
    ownPorts,
    paths: { majhiHome: env.majhiHome, hostHome: env.hostHome, protectedPaths: [env.secretsKeyFile] },
    changed: () => events.emit(["containers"]),
  });
  background.run(
    () => containers.startup(),
    (err) => console.error(`Could not clean up containers: ${errorMessage(err)}`),
  );
  const skillStore = new SkillStore(env.majhiHome);
  // The weekly prune of majhi's old images and build cache: looked at on start and once a day.
  const pruneContainers = () =>
    background.run(
      () => containers.pruneIfDue(),
      (err) => console.error(`Could not prune old images: ${errorMessage(err)}`),
    );
  pruneContainers();
  const pruneSweep = setInterval(pruneContainers, PRUNE_SWEEP_MS);
  pruneSweep.unref();
  // The captain is built after the runs; a finished turn reaches it through this.
  const captainRef: { current: CaptainService | undefined } = { current: undefined };
  const runs = new RunManager({
    store,
    limited: limitedRun,
    // Bound below: autonomous mode is built after the task service.
    held: (task) => autonomy.held(task),
    cores: () => machine.get()?.host?.cores,
    slotPolicy: { fair: () => autonomy.slotsFair(), owner: (task) => autonomy.ownerRuns(task) },
    onLoopEnd: (task) => autonomy.loopEnded(task),
    // Bound below: the captain's lanes are built after the task service.
    accountFor: (task, agent) => lanes.accountFor(task, agent),
    rooms: roomAccess,
    processes,
    usage: usageRecorder,
    room,
    runtime,
    options: sessionOptions,
    agents: agentStore,
    config,
    secrets,
    majhiHome: env.majhiHome,
    admin: new AdminAccess(adminTokens),
    decisions,
    connectionFiles,
    skills: skillStore,
    containerRunner: env.runner.mode === "container",
    ...(env.runner.mode === "container" ? { serena: { command: SERENA_COMMAND } } : {}),
    onTasksChanged: (task, rows) => events.emitTask(task, rows ? true : undefined),
    onSkillsChanged: () => events.emit(["skills"]),
    // Bound below: the task service and the resume coordinator are built after the run manager.
    onIdle: (task, refused) => {
      background.run(() => tasks.agentsIdle(task, refused));
      idleWatch.idle(task);
    },
    beforePrompt: (turn) => tasks.beforePrompt(turn),
    onPaused: (task, reason, why) => background.run(() => tasks.pausedByRuns(task, reason, why)),
    checkAccount: async (id) => {
      const { account } = await accounts.health(id, true);
      const full = [account.usage?.window, account.usage?.weekly].find(
        (w) => w !== undefined && w.usedPct >= 100 && w.resetsAt !== undefined,
      );
      return { status: account.status, resetsAt: full?.resetsAt ?? account.usage?.window?.resetsAt };
    },
    markSignedOut: async (account, detail) => {
      await accounts.markSignedOut(account, detail);
    },
    accountLimit: accountLimitOf,
    markLimit: (account, failure) => accounts.markLimit(account, failure),
    takeOver: (task, from, to) => tasks.takeOver(task, from, to),
    fallbackFor: async (task, agent) => {
      const found = store.tasks.get(task);
      if (found === undefined || !(await resilience.handoffOn(found))) return undefined;
      const stored = await agentStore.get(agent);
      const fallback = stored?.ok ? stored.agent.frontmatter.fallback : undefined;
      if (fallback === undefined || found.team.includes(fallback)) return undefined;
      return (await canTakeOver(task, fallback)) ? fallback : undefined;
    },
    teammateFor: async (task, agent) => {
      const found = store.tasks.get(task);
      if (found === undefined || found.team[0] !== agent || !(await resilience.handoffOn(found)))
        return undefined;
      for (const other of found.team) {
        if (other !== agent && (await canTakeOver(task, other))) return other;
      }
      return undefined;
    },
    teamCanRun: async (task, agent) => {
      const team = store.tasks.get(task)?.team ?? [];
      for (const other of team) {
        if (other === agent) continue;
        if ((await accounts.signedOutAccountOf(other)) === undefined) return true;
      }
      return false;
    },
    onTurnFailed: (turn) => idleWatch.turnFailed(turn),
    // Bound below: autonomous mode is built after the task service.
    overCap: (task, spent) => autonomy.overCap(task, spent),
    onResumed: (task) => background.run(() => tasks.resumedByRuns(task)),
    onTurnEnd: (turn) => {
      idleWatch.turnEnded(turn);
      captainRef.current?.turnEnded(turn);
      return coordinator.turnEnded(turn);
    },
    onCheckpoint: (task) => background.run(() => tasks.restackOnto(task)),
    onNetworkError: () => background.run(() => resilience.networkError()),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  runs.recover();
  // What runs held of their connections never reaches the room (5.14).
  room.redactWith((task, text) => redactSecrets(text, runs.secretsOf(task)));
  const uploads = new UploadStore(env.majhiHome);
  const projects = new ProjectService(config, store.tasks);
  memory.onChange(() => events.emit(["memory"]));
  const repoDocs = new RepoDocs({ embed: (texts) => memory.embed(texts) });
  /** Registered projects with their checkout and org. */
  const projectList = async () =>
    Object.entries((await config.sections()).projects).map(([id, p]) => ({
      id,
      path: resolvePath(p.path, config.paths.hostHome),
      org: p.org,
    }));
  /** The registered orgs and projects, each project with a line from its brief, for placing facts. */
  const memoryRegistry = async (): Promise<Registry> => {
    const sections = await config.sections();
    return {
      orgs: Object.entries(sections.orgs).map(([id, o]) => ({ id, name: o.name })),
      projects: Object.entries(sections.projects).map(([id, p]) => ({
        id,
        org: p.org,
        aliases: p.aliases,
        about: briefAbout(memory.project.currentBrief(id)?.body),
      })),
    };
  };
  // Curation: agents' proposals and the Housekeeper's lessons take the same path.
  const curator = new Curator({
    memory,
    decisions,
    settings: async () => (await config.settings()).memory,
    task: (id) => {
      const t = store.tasks.get(id);
      return t === undefined ? undefined : curationTask(t);
    },
    allowed: (t) => memoryScopes.writable(t.id),
    placer: new Placer({ decisions, registry: memoryRegistry }),
    // Laya unsure about a waiting memory: the stand-in answers once, 40 a day at most, before the owner is left with it.
    escalate: { perDay: ESCALATIONS_PER_DAY },
    inDocs: async (t, text) => {
      if (t === undefined) return undefined;
      const paths = (await projectList()).filter((p) => t.projects.includes(p.id)).map((p) => p.path);
      const match = await repoDocs.match(text, await repoDocs.chunks(paths), LESSON_DOC_COSINE);
      return match?.chunk.file;
    },
  });
  memory.useCurator((fact) => curator.curate(fact));
  // The owner keeping or dropping a fact is the right answer to "is it worth keeping".
  memory.onOwnerChoice((id, action) =>
    decisions.resolve(
      "memory",
      String(id),
      action === "approved" ? "keep" : "not-keep",
      action === "approved" ? "the owner kept it" : "the owner dropped it",
    ),
  );
  const housekeeper = new Housekeeper({
    config,
    agents: agentStore,
    secrets,
    runtime,
    options: sessionOptions,
    majhiHome: env.majhiHome,
    usage: usageRecorder,
  });
  // Each project's code graph (5.21), read by graphify in a runner container with no network. In the tasks
  // folder: runners can mount it, and it is never inside majhi's config folder.
  const graphRoot = async () => {
    const loaded = await config.load();
    if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
    return join(loaded.state.config.tasksDir, ".map");
  };
  const graphRunner =
    env.runner.mode === "container"
      ? new GraphRunner({
          spawner: sessionOptions.spawner ?? localSpawner,
          base: sessionOptions.base,
          root: graphRoot,
        })
      : undefined;
  const codeGraph = new CodeGraphTools({
    root: graphRoot,
    scope: (task) => {
      const row = store.tasks.get(task);
      if (row === undefined) return undefined;
      return { org: lanes.orgOf(task) ?? row.org ?? PRIVATE, repos: row.repos.map((r) => r.project) };
    },
    orgOf: async (project) => (await projects.infos()).find((p) => p.id === project)?.org,
  });
  // The project map (5.21). Its code pass is a Housekeeper question per project: the smallest model, no tools.
  const map = new MapService({
    graph: graphRunner,
    graphFolder: async (o, p) => graphFolder(await graphRoot(), o, p),
    repo: new MapRepo(store.raw),
    projects: async () =>
      (await projects.infos()).map((p) => ({ id: p.id, org: p.org, path: p.path, exists: p.exists })),
    tasks: () =>
      store.tasks.list(false).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        org: t.org ?? PRIVATE,
        repos: t.repos,
        chat: t.chat,
        lane: t.lane,
      })),
    ask: (task, prompt, parse) => housekeeper.ask(task, prompt, parse),
    unavailable: async (org) => {
      try {
        await housekeeper.resolve(org);
        return undefined;
      } catch (err) {
        return err instanceof NoHousekeeper
          ? "No model is set, so the update reads config files only. Choose a captain to turn the code pass on."
          : `The code pass cannot run here: ${errorMessage(err)}`;
      }
    },
    price: async (org) => {
      try {
        const { account } = await housekeeper.resolve(org);
        const owner = await readPrices(config.file).catch(() => ({}));
        return housekeeperPrice((await config.settings()).memory.housekeeper_model, account.tool, owner);
      } catch {
        return undefined;
      }
    },
    spent: (task, since) => usageRepo.totals({ filters: { task }, start: since }).costUsd,
    changed: () => events.emit(["map"]),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  // The owner's outcome switches, by workspace and rule id. Bound below, once the playbooks exist.
  const ruleSwitches: {
    off: (org: string, rule: string) => boolean;
    briefHidden: (org: string, playbook: string | undefined) => boolean;
  } = { off: () => false, briefHidden: () => false };
  // Bound below: the findings store is built after the cards.
  let reportFinding: FindingsService["report"] | undefined;
  let findingsStore: FindingsService | undefined;
  const cards = createCards({
    store,
    projects,
    memory,
    housekeeper,
    log: (message) => console.error(message),
    ruleOff: (org, rule) => ruleSwitches.off(org, rule),
    reportGap: async (project, gap) => {
      await reportFinding?.(
        {
          org: project.org,
          project: project.id,
          source: "setup",
          title: `${project.id}: ${gap.label.toLowerCase()} missing`,
          detail: gap.fix ?? "",
          evidence: [],
          severity: "low",
          dedupeKey: `readiness:${project.id}:${gap.id}`,
        },
        { kind: "owner" },
      );
    },
  });
  memory.useCards((project) => cards.compact(project));
  const extraction = new Extraction({
    housekeeper,
    curator,
    memory,
    repoDocs,
    task: (id) => store.tasks.get(id),
    room: (id) => store.room.page(id, 400).items,
    madeFrom: (id) =>
      store.tasks
        .linksTo(id)
        .filter((l) => l.type === "follow-up" || l.type === "parent")
        .flatMap((l) => {
          const t = store.tasks.get(l.task);
          return t === undefined ? [] : [{ id: t.id, title: t.title, status: t.status }];
        }),
    project: async (id) => (await projectList()).find((p) => p.id === id),
    registry: memoryRegistry,
    say: (id, level, text) => room.post(id, `${level}:${randomUUID()}`, { type: "system", level, text }),
  });
  let chatMemory: ChatMemory | undefined;
  // Bound below, after the services it reads: the checked hand-off (5.18).
  let handoffService: HandoffService | undefined;
  // Bound below, once the captain's tables are read: the loop guard counts the captain's answers.
  let loopGuard: LoopGuard | undefined;
  // The merge rule: every merge of a task branch asks this, read from the hand-off bound below.
  const mergeGate = new MergeGate({
    handoff: () => handoffService,
    configured: (project) => {
      const commands = cards.get(project)?.commands ?? {};
      return [commands.test, commands.build, commands.lint].some((c) => c !== undefined && c.trim() !== "");
    },
  });
  const tasks = new TaskService({
    mergeGate,
    mapNotes: (task) =>
      map.briefLines(
        task.org ?? PRIVATE,
        task.repos.map((r) => r.project),
        MAP_BRIEF_LINES,
      ),
    protectedPaths: [env.secretsKeyFile],
    onCaptainAnswer: (task) => void loopGuard?.answered(task).catch(() => undefined),
    onOwnerResumedLimit: (task) => budgets.exempt(task),
    // Bound below: autonomous mode is built after the task service.
    onOwnerResumed: (task) => autonomy.ownerResumed(task),
    store,
    config,
    projects,
    agents: agentStore,
    accounts,
    uploads,
    runs,
    room,
    events,
    decisions,
    processes,
    containers,
    terminals,
    memory,
    memoryScopes,
    onChatTurn: (id) => void chatMemory?.afterTurn(id),
    onDone: async (task) => {
      if (!isBossChat(task)) extraction.afterClose(task);
      await promotion.release(task);
    },
    onRemoving: async (task) => {
      handoffService?.forget(task.id);
      await promotion.release(task);
    },
    // Bound below: autonomous mode keeps its chat while the mode is not off.
    guardRemoval: (task, action) => autonomy.guardChat(task, action),
    // Bound below: the merge requests service is built after the task service.
    onReview: (id) => {
      void labelFinishedTask(id);
      handoffService?.reviewReached(id);
      captain.reviewReached(id);
      return pendingShips.reviewReached(id);
    },
    onMerged: (merge) => {
      cards.onMerged(merge.project);
    },
    usage: usageRepo,
    flushUsage: () => usageRecorder.flush(),
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.reloadKeys === undefined ? {} : { reloadKeys: options.reloadKeys }),
  });
  chatMemory = new ChatMemory({
    store,
    settings: async () => (await config.settings()).memory,
    extraction,
    housekeeper,
    mentioned: (id) => memoryScopes.mentioned(id),
    working: (id) => runs.working(id).length > 0,
    setTitle: (id, title) => tasks.autoTitleChat(id, title),
  });
  /**
   * A task reached review: its size decisions get a label from what the task turned out to be (the
   * diff, the turns and the output tokens). A failure here never touches the task.
   */
  const labelFinishedTask = async (id: string): Promise<void> => {
    try {
      const diffs = await tasks.diff(id);
      const spent = store.raw
        .prepare(
          "SELECT COUNT(*) AS turns, COALESCE(SUM(output_tokens + reasoning_tokens), 0) AS tokens FROM turns WHERE task = ?",
        )
        .get(id) as { turns: number; tokens: number };
      const files = diffs.reduce((n, d) => n + d.files.length + d.omitted, 0);
      const lines = diffs.reduce((n, d) => n + d.files.reduce((m, f) => m + f.additions + f.deletions, 0), 0);
      decisions.taskReviewed(id, { files, lines, turns: spent.turns, outputTokens: spent.tokens });
    } catch {
      // No label this time; the next review tries again.
    }
  };
  /** Whether the hand-off check of a task in review has a verdict: the gate every screen's "ready" follows. */
  const checksOf = (id: string, status: string): Pick<Subject, "checks"> => {
    const gate = status === "review" ? handoffService?.gate(id) : undefined;
    return gate === undefined ? {} : { checks: gate };
  };
  /** The task an item belongs to, as notifications and the Decisions inbox name it. */
  const subjectOf = (id: string): Subject | undefined => {
    const task = store.tasks.subjectInfo(id);
    return task === undefined
      ? undefined
      : {
          id: task.id,
          title: task.title,
          chat: isOwnerChat(task),
          ...(task.org === undefined ? {} : { org: task.org }),
          repos: task.repos,
          status: task.status,
          ...checksOf(id, task.status),
          ...(() => {
            const kids = store.tasks.openSubtasks(id);
            return {
              openSubtasks: kids.open,
              ...(kids.newest === undefined ? {} : { newestSubtask: kids.newest }),
            };
          })(),
        };
  };
  /** The subjects of many tasks in three queries, for a list that names a task per row. Done and missing tasks are left out. */
  const openSubjectsOf = (ids: readonly string[]): Map<string, Subject> => {
    const out = new Map<string, Subject>();
    for (const [id, task] of store.tasks.subjectsMany(ids)) {
      if (task.status === "done") continue;
      out.set(id, {
        id,
        title: task.title,
        chat: isOwnerChat(task),
        ...(task.org === undefined ? {} : { org: task.org }),
        repos: task.repos,
        status: task.status,
        ...checksOf(id, task.status),
        openSubtasks: task.open,
        ...(task.newest === undefined ? {} : { newestSubtask: task.newest }),
      });
    }
    return out;
  };
  const hostLink = options.hostLink;
  /** Whether the Mac lets majhi's notifier show anything; one decision while it does not. */
  const macNotify =
    hostLink === undefined
      ? undefined
      : new MacNotifyAccess({
          notify: (notice) => hostLink.call("notify", notice),
          openSettings: () => hostLink.call("notify.openSettings", {}),
        });
  const notifier = new Notifier({
    subject: subjectOf,
    // The captain answers it by itself when Autonomous is on and the workspace lets it decide: an
    // alert waits a while, so a card it handles never alerts (SPEC 5.18).
    captainHandles: async (item, subject) => {
      if (autonomy.mode() !== "on") return false;
      const row =
        item.type === "permission"
          ? item.connection === undefined
            ? "approvals"
            : undefined
          : item.type === "ask" || item.type === "choice" || item.type === "owner-question"
            ? "questions"
            : undefined;
      if (row === undefined) return false;
      const settings = (await config.settings()).autonomy;
      return authorityOf(settings, subject.org ?? PRIVATE)[row] === "decide";
    },
    item: (task, id) => store.room.get(task, id),
    pendingReview: (task) => store.room.pendingOfType(task, "review"),
    settings: async () => {
      try {
        return (await config.settings()).notifications;
      } catch {
        return NotificationsSettingsSchema.parse({});
      }
    },
    events,
    ...(macNotify === undefined ? {} : { desktop: (notice) => macNotify.send(notice) }),
  });
  room.onWrite((task, item) => notifier.observe(task, item));
  room.onWrite((task, item) => captain.roomWrote(task, item));
  const conversations = new ConversationsService({ store, events });
  room.onWrite((task, item) => conversations.observe(task, item));
  const updateWatch = setInterval(() => void watchUpdate(env.majhiHome, notifier), UPDATE_WATCH_MS);
  updateWatch.unref();
  const chatSweep = setInterval(() => background.run(async () => chatMemory?.sweep()), CHAT_SWEEP_MS);
  chatSweep.unref();
  // A new week lifts the budget pauses; a raised budget lifts them at once, through `recheck`.
  const limitSweep = setInterval(() => background.run(() => budgets.lift()), LIMIT_SWEEP_MS);
  limitSweep.unref();
  const promotion = new Promotion({ memory, tasks, projects, config });
  // Once: old pending facts that only repeat the repo docs are rejected (logged, undoable).
  background.run(
    () => cleanupRepoDocFacts({ memory, repoDocs, projects: projectList }),
    (err) => console.error(`Memory cleanup failed: ${errorMessage(err)}`),
  );
  const gitLogins = new GitLoginService(options.hostLink, async () => (await config.load()).projectPaths);
  const hostGit =
    options.hostLink === undefined
      ? undefined
      : createHostGit(options.hostLink, async () => {
          const loaded = await config.load();
          if (loaded.state.status !== "loaded") return [];
          return [...loaded.state.config.workspaces, loaded.state.config.tasksDir, ...loaded.projectPaths];
        });
  const gitTokens = createGitTokens(config, secrets, options.gitFetch ?? fetch);
  const signedOut = (org: string, host: string) =>
    `${org} is not signed in to ${host}. Sign the workspace in to ${host} on the Workspaces page.`;
  gitSignIn.token = async (org, provider, host) => {
    const cred = await gitTokens.credential(org, provider, host);
    if (cred.tokenRef === undefined) return { problem: signedOut(org, host) };
    const token = await gitTokens.value(cred.tokenRef).catch(() => undefined);
    return token === undefined ? { problem: signedOut(org, host) } : { token };
  };
  const mrs = new MrService({
    gitLogins,
    freshToken: (ref) => gitTokens.value(ref),
    pushAuth: async (org, url) =>
      pushAuthFor(gitTokens, (await config.sections()).orgs, org, url, (host) =>
        mrKindOf(classifyHost(host)),
      ),
    ...(hostGit === undefined ? {} : { hostGit }),
    store,
    config,
    projects,
    secrets,
    room,
    events,
    tasks,
    working: (id) => runs.working(id).length > 0,
    hosts: createMrHosts(options.mrHosts),
    ...(options.reloadKeys === undefined ? {} : { reloadKeys: options.reloadKeys }),
  });
  const pendingShips = new PendingShips({ store, tasks, mrs, room, events, now: () => new Date() });
  const queuedMerges = new QueuedMerges(store.raw, {
    task: (id) => {
      const t = store.tasks.get(id);
      return t === undefined ? undefined : { id: t.id, status: t.status, repos: t.repos.length };
    },
    checks: (id) => {
      const t = tasks.get(id);
      return mergeGate.checks(t, t.repos);
    },
    run: async (q) => {
      const input = {
        id: q.task,
        ...(q.targets === undefined ? { into: q.into } : { targets: q.targets }),
        done: true,
        by: q.by,
        method: q.method,
        deleteAfter: q.deleteAfter,
      };
      const out = q.action === "mergePush" ? await mrs.mergeAndPush(input) : await tasks.merge(input);
      const failed = out.results.filter((r) => !r.ok);
      return failed.length === 0 ? undefined : failed.map((r) => `${r.project}: ${r.detail}`).join(" ");
    },
    say: (id, text) =>
      room.post(id as TaskId, `info:${randomUUID()}`, { type: "system", level: "info", text }),
    refuse: (id, text) => {
      const t = tasks.get(id);
      if (t.status === "review") tasks.cards.review(t, text);
      else room.post(id as TaskId, `warn:${randomUUID()}`, { type: "system", level: "warn", text });
    },
    changed: (id) => events.emitTask(id),
    now: () => new Date(),
  });
  const resumeLimited = async (org: string): Promise<string[]> => {
    const resumed: string[] = [];
    for (const t of store.tasks.list(false)) {
      if (t.org !== org || t.status !== "paused" || t.pausedReason !== "limit") continue;
      let held = false;
      for (const agent of t.team) held ||= (await limitedRun(t.id, agent)) !== undefined;
      if (held || autonomy.holdFor(t.id) !== undefined) continue;
      try {
        await tasks.start(t.id, "majhi");
        resumed.push(t.id);
      } catch (err) {
        console.error(`Could not resume ${t.id} after its limit: ${errorMessage(err)}`);
      }
    }
    return resumed;
  };
  const actionHost = createActionHost({
    store,
    tasks,
    processes,
    projects,
    agents: agentStore,
    resumeLimited,
  });
  const watchHost = createWatchHost({
    store,
    processes,
    usage: usageService,
    actions: actionHost,
    limits: {
      accountList: async () => (await accounts.list()).map((a) => ({ id: a.id, org: a.org })),
      account: async (id) => {
        const found = (await accounts.list()).find((a) => a.id === id);
        return found === undefined
          ? undefined
          : {
              org: found.org,
              window: found.usage?.window && {
                percent: found.usage.window.usedPct,
                resetsAt: found.usage.window.resetsAt,
              },
              weekly: found.usage?.weekly && {
                percent: found.usage.weekly.usedPct,
                resetsAt: found.usage.weekly.resetsAt,
              },
            };
      },
      budget: async (scope, id) => {
        const row = (await budgets.status()).rows.find((r) => r.scope === scope && r.id === id);
        return row === undefined ? undefined : { percent: row.percent, resetsAt: row.resetsAt };
      },
      autopilotDay: () => autonomy.dayUse(),
      monthly: async () => {
        const m = await outcomes.money();
        return m.ceilingUsd === undefined
          ? undefined
          : { percent: (m.spentUsd / m.ceilingUsd) * 100, resetsAt: m.to };
      },
    },
  });
  const playbookCatalog = new Catalog();
  const automation = createAutomation({
    db: store.raw,
    catalog: playbookCatalog,
    host: actionHost,
    orgIds: async () => new Set(Object.keys((await config.sections()).orgs)),
    changed: () => events.emit(["schedules"]),
  });
  const coordinator = new RoomCoordinator({
    store,
    room,
    runs,
    tasks,
    agents: agentStore,
    config,
    decisions,
    signedOut: (agent) => accounts.signedOutAccountOf(agent),
    waitsOnProcess: (task, agent) => processes.waiting(task).some((p) => p.agent === agent),
  });
  coordinator.sweepEmptyQuestions();
  const idleWatch = new IdleWatch({
    store,
    room,
    runs,
    pauseForOwner: (task, text) => tasks.pauseForOwner(task, text, "blocked"),
    waitsOnProcess: (task) => processes.waiting(task).length > 0,
    delayMs: options.idleWatchMs,
  });
  const admin = new AdminService({ config, room, store, secrets, tasks });
  const scheduleRows = new ScheduleRepo(store.raw);
  const captainRepo = new CaptainRepo(store.raw);
  loopGuard = new LoopGuard({
    repo: captainRepo,
    mark: async (id) => {
      const task = store.tasks.get(id);
      if (task === undefined || task.status === "done") return undefined;
      const heads: string[] = [];
      for (const r of task.repos) {
        const tip = await git(r.source, ["rev-parse", "--verify", `refs/heads/${r.branch}`]).catch(() => "");
        heads.push(`${r.project}@${tip.trim()}`);
      }
      return `${task.status}|${heads.join(",")}`;
    },
    pause: (id, text) => tasks.pauseForOwner(id, text),
  });
  const cardActions = new CardActions({ tasks, mrs, room });
  const knownOrg = async (org: string) =>
    org === PRIVATE || (await config.sections()).orgs[org] !== undefined;
  const goals = new GoalsService({
    db: store.raw,
    knownOrg,
    changed: () => events.emit(["playbooks"]),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  // Bound below, after the playbooks: the trust ladder decides which channels may be Auto.
  let outcomesService: OutcomesService | undefined;
  const outbound = new OutboundGate({
    db: store.raw,
    knownOrg,
    autoAllowed: (org, channel) => outcomesService?.autoAccepted(org, channel) ?? false,
    tz: async (org) => {
      const a = (await config.settings()).autonomy;
      return zoneOr(a.orgs[org]?.tz ?? a.tz);
    },
    changed: () => events.emit(["playbooks"]),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  let opsWatch: OpsWatch | undefined;
  let opsEngine: WatchEngine | undefined;
  const inbox = new InboxService({
    outbound,
    incidents: () => opsWatch?.unacked() ?? [],
    items: () => store.room.waitingDecisions(),
    working: () => runs.workingTasks(),
    changed: (task) => events.emitTask(task),
    // The same live look the captain's ship chore takes: a card never offers a merge that fails.
    shipBlock: async (task) => {
      const check = await shipReadiness({ store, room, runs, mrs }, task);
      return check.ready || check.unmergeable === undefined
        ? undefined
        : { why: check.why, empty: check.unmergeable === "empty" };
    },
    subject: (id) => {
      const task = store.tasks.subjectInfo(id);
      return task === undefined || task.status === "done" ? undefined : subjectOf(id);
    },
    subjects: openSubjectsOf,
    budgets: () => autonomy.budgetAsks(),
    signedOut: async () =>
      (await accounts.list())
        .filter((a) => a.status === "needs-login" || a.status === "unreachable")
        .map((a) => ({ id: a.id, at: a.lastHealth?.checkedAt ?? new Date().toISOString() })),
    recommendations: new RecommendationRepo(store.raw),
    orgNames: async () =>
      Object.fromEntries(Object.entries((await config.sections()).orgs).map(([id, o]) => [id, o.name])),
    lastAgentMessage: (task) => {
      room.flush(task);
      for (const item of store.room.page(task, 60).items) {
        if (item.type === "agent" && item.text.trim() !== "") {
          return { agent: item.agent, text: item.text.trim(), at: item.at };
        }
      }
      return undefined;
    },
    diff: (task) => tasks.diff(task),
    shipOptions: (task) => mrs.shipOptions(task),
    actions: {
      answerAsk: (task, item, answers) => tasks.answerAsk(task, item, answers),
      answerQuestion: (task, item, choice) => tasks.answerQuestion(task, item, choice),
      answerChoice: (task, item, option) => tasks.answerChoice(task, item, option),
      answerPermission: (task, item, option) => tasks.answerPermission(task, item, option),
      decideApproval: (task, item, decision) => admin.decide(task, item, decision, undefined),
      cardAction: (task, item, action) => cardActions.act({ task, item, action, by: "owner", agent: false }),
      askChanges: (task, text, lead) =>
        tasks.send({
          task,
          text,
          attachments: [],
          mode: "queue",
          ...(lead === undefined ? {} : { agent: lead }),
        }),
      answerBudget: (scope, answer) => autonomy.answerBudget(scope, answer),
      decideDraft: (id, decision) => outbound.decide(id, decision),
      decideBatch: (org, channel, decision) => outbound.decideBatch(org, channel, decision),
      ackIncident: async (id) => {
        await opsWatch?.ack(id);
      },
      answerIncident: async (id, option) => {
        await opsEngine?.answerFix(id, option);
      },
      answerTrust: (id, option) => outcomesService?.answerNotice(id, option) ?? Promise.resolve(),
      answerCeiling: (month, option) => outcomesService?.answerCeiling(month, option) ?? Promise.resolve(),
      answerNotifyAccess: (option) => macNotify?.answer(option) ?? Promise.resolve(),
    },
    extras: () => [...(outcomesService?.decisions() ?? []), ...(macNotify?.decision() ?? [])],
    answered: (decision, option) => outcomesService?.answered(decision, option),
  });
  const lanes = new Lanes({
    repo: captainRepo,
    store,
    tasks,
    config,
    agents: agentStore,
    now: () => options.runClock?.() ?? new Date(),
    // Bound below: autonomous mode measures the spend.
    rest: (org, account) => autonomy.laneRest(org, account),
  });
  const machineDocker = dockerCli(env.runner.cliEnv);
  const memoryWatch = new MemoryWatch();
  /** A run container that sits at its memory limit is noted once on its task, so the captain or owner sees it. */
  const noteHotMemory = async (): Promise<void> => {
    const hot = memoryWatch.read(machine.get()?.containers ?? []);
    if (hot.length === 0) return;
    const rows = await machineDocker([
      "ps",
      "--filter",
      "label=majhi.runner=1",
      "--format",
      '{{.Names}}\t{{.Label "majhi.task"}}',
    ]);
    for (const line of rows.split("\n")) {
      const [name, task] = line.split("\t");
      if (name === undefined || task === undefined || task === "" || !hot.includes(name)) continue;
      if (store.tasks.get(task) === undefined) continue;
      room.post(task as TaskId, `memory:${randomUUID()}`, {
        type: "system",
        level: "warn",
        text: "An agent on this task is using almost all of its memory limit and may be slow or get stopped. Ask it to do less at once, or stop the task if it keeps stalling.",
      });
    }
  };
  /**
   * Run containers a restart or crash left behind keep their CPU while majhi counts no run, and the
   * load keeps every start refused. The reading names them; the runner removes them.
   */
  const sweepOrphans = async (): Promise<void> => {
    if (runner.runner === undefined) return;
    const names = (machine.get()?.containers ?? []).map((c) => c.name);
    if (orphanRuns(names, runner.runner.live()).length === 0) return;
    const removed = await runner.runner.sweep();
    if (removed.length > 0)
      console.warn(`Removed ${removed.length} run container(s) no run held: ${removed.join(", ")}`);
  };
  const machine = new MachineSensor({
    host: async () =>
      options.hostLink?.isConnected() === true
        ? await options.hostLink.call("machine.read", {}, 15_000)
        : undefined,
    docker: machineDocker,
    onChange: () => {
      autonomy.machineRead();
      void noteHotMemory().catch(() => undefined);
      void sweepOrphans().catch(() => undefined);
    },
  });
  const autonomy = new AutonomyService({
    skills: skillStore,
    machine: () => machine.get(),
    lanes,
    processWaiting: (task) => processes.waiting(task).length > 0,
    typing: (task) => events.typing.holds(task),
    protectedProjects: async () =>
      new Set((await projects.infos()).filter((p) => p.protected).map((p) => p.id)),
    upkeepBetween: (from, to) => captainRepo.actionsBetween(from, to),
    decisions: () => inbox.list(),
    store,
    config,
    tasks,
    runs,
    room,
    accounts,
    agents: agentStore,
    events,
    gitLogins,
    tell: (key, text) => notifier.captain(key, text),
    recommend: async (input, lane) => {
      await inbox.recommend(input, lane);
      events.emit(["tasks"]);
    },
    ceilingHeld: () => outcomesService?.ceilingHeld(),
    automationAction: (kind, id) =>
      kind === "schedule"
        ? scheduleRows.get(id)?.action.kind
        : opsEngine?.actionKind(id.startsWith("trg-") ? watchIdOf(id) : id),
    // Sizes a task for the pick rules, as Laya rates it for an `auto` model pick.
    rateSize: (t) =>
      decisions.rateTask({
        ...(t.id === undefined ? {} : { task: t.id }),
        title: t.title,
        brief: t.brief,
        kind: t.kind,
        repos: t.repos,
        role: "Builder",
        use: "task-size",
      }),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  autonomy.useDriver(
    new AutonomyDriver({
      autonomy,
      tasks,
      runs,
      room,
      quiet: (task) => idleWatch.quiet(task),
      explained: (task) => autonomy.stallExplained(task),
      findingLines: (org) => findingsStore?.digestLines(org) ?? [],
      incidentLines: (org) => incidentLines(opsWatch?.openIncidents() ?? [], org),
      projectLines: (org) => cards.digestLines(org),
      store,
      events,
      ...(options.runClock === undefined ? {} : { now: options.runClock }),
    }),
  );
  admin.useAutonomy(autonomy);
  const cleanup = new CleanupService({ store, room, events, projects });
  const folderSweep = new TaskFolderSweep({
    store,
    tasksDir: async () => {
      const loaded = await config.load();
      if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
      return loaded.state.config.tasksDir;
    },
  });
  const findings = new FindingsService({
    repo: new FindingsRepo(store.raw),
    projectOrg: async (id) => (await config.sections()).projects[id]?.org ?? PRIVATE,
    taskStatus: (id) => store.tasks.get(id)?.status,
    createTask: async (n) => {
      const task = await tasks.create({
        title: n.title,
        text: n.text,
        ...(n.project === undefined
          ? { org: n.org, kind: "ops" as const }
          : { repos: [{ project: n.project }], ...(n.code === true ? { kind: "code" as const } : {}) }),
        byOwner: n.byOwner,
        attachments: [],
        start: false,
      });
      return { id: task.id };
    },
    changed: () => events.emit(["findings"]),
    // Laya reads each new finding: likely real or noise, with the owner's dismiss and keep as its labels.
    triage: (f) => triageFinding(decisions, f, options.runClock),
    labelled: (f, label, note) => decisions.resolve("finding", String(f.id), label, note),
    // A new finding is news to its workspace's lane, where Start is You too (it files a proposal).
    appeared: (f) => {
      // An incident wakes the lane itself, with its evidence and what the captain may do (ops watch).
      if (f.source === "incident") return;
      if (f.severity !== "info") autonomy.news(`New finding #${f.id} (${f.severity}): ${f.title}`, f.org);
    },
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  findingsStore = findings;
  reportFinding = (input, actor) => findings.report(input, actor);
  const agendaOwner = { kind: "owner" } as const;
  const agenda = new AgendaService({
    repo: new AgendaRepo(store.raw),
    clock: async () => {
      const a = (await config.settings()).autonomy;
      return { at: a.summary_at, tz: a.tz };
    },
    decisions: (org) => inbox.list(org),
    findings: () => findings.list({ limit: 500 }, agendaOwner).findings,
    briefHidden: (f) => ruleSwitches.briefHidden(f.org, f.playbook),
    goals: () => goals.list({}, agendaOwner),
    running: () =>
      store.tasks
        .list(false)
        .filter((t) => t.status === "running" && t.chat !== true && t.lane !== true)
        .map((t) => ({
          id: t.id,
          title: t.title,
          ...(t.org === undefined ? {} : { org: t.org }),
          since: t.updatedAt,
        })),
    names: async () => {
      const orgs = (await config.sections()).orgs;
      return new Map<string, string>([
        [PRIVATE, "Private"],
        ...Object.entries(orgs).map(([id, o]) => [id, o.name] as [string, string]),
      ]);
    },
    overnight: (from, to) => autonomy.overnight(from, to),
    write: async (prompt) =>
      (
        await housekeeper.ask({ id: "morning-brief" }, prompt, (reply) =>
          reply.trim() === "" ? { ok: false, problem: "The reply was empty." } : { ok: true, value: reply },
        )
      ).value,
    next: (max) => autonomy.queueTitles(max),
    notify: (day, text) => notifier.brief(day, text),
    changed: () => events.emit(["agenda"]),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  const agendaSweep = setInterval(() => background.run(() => agenda.sweep()), AGENDA_SWEEP_MS);
  agendaSweep.unref();
  background.run(() => agenda.sweep());
  const handoff = createHandoff({
    db: store.raw,
    store,
    tasks,
    mrs,
    room,
    runs,
    projectCards: cards,
    housekeeper,
    spawner: sessionOptions.spawner ?? localSpawner,
    base: sessionOptions.base,
    repoMounts: (task) => repoMounts(task),
    packages: (task) => packageCache(env.majhiHome, task).catch(() => undefined),
    // A hand-off check that starts containers (a repo's own test of its deploy files) reaches the task's through majhi.
    dockerShim: (task) => {
      const shim = roomAccess.attachDocker({ task, agent: store.tasks.get(task)?.team[0] ?? "handoff" });
      return shim === undefined
        ? undefined
        : { env: shim.env, release: () => roomAccess.revoke([shim.entry]) };
    },
    environment: () => `${env.commit}|${env.runner.image}`,
    handoffCommands: async (project) => (await config.sections()).projects[project]?.handoff,
    limits: async (project) => {
      const c = (await config.settings()).containers;
      return {
        cpus: c.handoff_cpus ?? defaultHandoffCpus(),
        memory: c.handoff_memory ?? DEFAULT_HANDOFF_MEMORY,
        minutes: c.handoff_minutes?.[project],
      };
    },
    mergeDecides: async (org) => authorityOf((await config.settings()).autonomy, org).merge === "decide",
    autonomous: () => autonomy.mode() === "on",
    ruleOff: (org, rule) => ruleSwitches.off(org, rule),
    ceilingHeld: () => outcomesService?.ceilingHeld(),
    changed: (task) => {
      events.emitTask(task);
      // A verdict may have landed: a review card that waited for it can alert, a queued merge can run.
      notifier.recheck(task);
      void queuedMerges.evaluate(task).catch(() => undefined);
    },
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
    ...(options.handoff === undefined ? {} : options.handoff),
  });
  handoffService = handoff;
  // A merge queued before a restart keeps waiting for its checks.
  queuedMerges.start();
  /** Bound when the server made the dispatcher: the captain's chores run commands as the captain. */
  let captainDispatch: Dispatch | undefined;
  const captain = new CaptainService({
    store,
    config,
    events,
    autonomy,
    lanes,
    ownerCards: async (org) => (await inbox.list(org)).length,
    threadState: () => {
      const waiting = store.room.tasksWaitingOnOwner();
      const pausedOrgs = new Set(
        store.tasks.getMany([...store.room.tasksPausedOnOwner()]).map((t) => t.org ?? PRIVATE),
      );
      return (chat, org) =>
        waiting.has(chat) || pausedOrgs.has(org)
          ? "waiting"
          : runs.working(chat).length > 0
            ? "working"
            : "idle";
    },
    fresh: (chat, agent) => tasks.fresh(chat, agent),
    relay: {
      bossChat: async () => {
        const boss = await lanes.boss();
        const chat = boss === undefined ? undefined : findBossChat({ store, tasks }, boss);
        return boss === undefined || chat === undefined ? undefined : { chat: chat.id, agent: boss };
      },
      post: (task, id, payload) => room.post(task as TaskId, id, payload),
    },
    ports: captainWorld({
      machineBusy: () => busyReason(machine.get()?.host),
      store,
      accounts,
      config,
      tasks,
      mrs,
      room,
      admin,
      autonomy,
      decisions,
      memory,
      findings,
      map,
      curate: (fact, off) => curator.review(fact, off === undefined ? {} : { off }),
      scanner: new RepoScanner(),
      cleanup,
      folders: folderSweep,
      idle: idleWatch,
      runs,
      lanes,
      repo: captainRepo,
      typing: (task) => events.typing.holds(task),
      aliasesOf: (path, id) => suggestRepoAliases(path, id),
      protectedProjects: async () =>
        new Set((await projects.infos()).filter((p) => p.protected).map((p) => p.id)),
      dispatch: () => captainDispatch,
      handoff: () => handoffService,
    }),
    tell: (key, text) => notifier.captain(key, text),
    cancelTurn: async (chat) => {
      await tasks.cancel(chat, undefined);
    },
    identity: async (org) => (await config.sections()).orgs[org]?.identity ?? DEFAULT_IDENTITY,
    ownerCommand: async (command, input, meta) => {
      if (captainDispatch === undefined) throw new UserError("majhi's commands are not ready yet.", 409);
      const result = await captainDispatch(command, input, JSON.stringify(meta));
      if (!result.ok)
        throw new UserError([result.error.error, ...(result.error.details ?? [])].join(". "), 409);
    },
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  captainRef.current = captain;

  // The ops watch adds its runner below, once the connections it reads through exist.
  const rulesTable: Record<string, RulesRunner> = {
    ...RULES_RUNNERS,
    // The weekly check of Laya's decisions, and a few old findings read each run.
    "laya-eval": layaEvalRunner({ decisions, backlog: findings }),
  };
  const playbooks = new PlaybookService({
    catalog: playbookCatalog,
    clock: automation.schedules,
    rules: rulesTable,
    plan: async (org, text) => {
      try {
        // The cheapest model, one short question, a JSON answer checked and clamped by parsePlan.
        const ctx = {
          projects: (await projects.infos()).filter((p) => p.org === org).map((p) => p.id),
          tasks: store.tasks
            .list(true)
            .filter((t) => t.org === org && t.status !== "done")
            .map((t) => t.id)
            .slice(0, 40),
        };
        const { value } = await housekeeper.ask(
          { id: "playbook-plan", org },
          planPrompt(text, ctx),
          (reply: string) => parsePlan(reply, org),
        );
        return value;
      } catch (err) {
        if (err instanceof NoHousekeeper)
          throw new UserError("There is no captain to plan with yet. Set one up first.", 409);
        throw err;
      }
    },
    repo: new PlaybookRepo(store.raw),
    captain,
    findings,
    goals,
    orgs: async () => workspaceIds((await config.sections()).orgs),
    lane: { chat: (org) => lanes.chat(org), tell: (org, text, settled) => lanes.tell(org, text, settled) },
    laneTokens: (chat, since) => captainRepo.laneSpend(chat, since).tokens,
    cancelTurn: async (chat) => {
      await tasks.cancel(chat, undefined);
    },
    mode: () => autonomy.mode(),
    tellOwner: (key, text) => notifier.captain(key, text),
    changed: () => events.emit(["playbooks", "captain"]),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  ruleSwitches.off = (org, rule) => playbooks.ruleOff(org, rule);
  ruleSwitches.briefHidden = (org, playbook) => playbooks.briefOff(org, playbook);
  captain.usePlaybooks(playbooks, () => playbooks.sweep());
  playbooks.boot();
  const outcomes = new OutcomesService({
    db: store.raw,
    tz: async () => zoneOr((await config.settings()).autonomy.tz),
    orgs: async () => workspaceIds((await config.sections()).orgs),
    orgName: async (org) =>
      org === PRIVATE ? "Private" : ((await config.sections()).orgs[org]?.name ?? org),
    playbookOfChore: (chore) => playbooks.catalog.ofChore(chore)?.id,
    authority: async (org) => authorityOf((await config.settings()).autonomy, org),
    setAuthority: async (org, row, choice, reason) => {
      await autonomy.configure(
        { orgs: { [org]: { authority: { [row]: choice } } } },
        { command: "trust.ladder", meta: { actor: { kind: "owner" }, reason } },
      );
    },
    outbound: {
      mode: (org, channel) => outbound.mode(org, channel),
      applyLadder: (org, channel, mode) => outbound.applyLadder(org, channel, mode),
    },
    playbooks: {
      name: (id) => playbooks.catalog.get(id)?.name ?? id,
      state: (org, id) => playbooks.stateOf(org, id),
      setCadence: async (org, id, cadence) => {
        await playbooks.update({ org, id, cadence });
      },
    },
    changed: () => events.emit(["captain", "playbooks"]),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  outcomesService = outcomes;
  void outcomes.sweep().catch(() => undefined);
  const outcomeSweep = setInterval(() => void outcomes.sweep().catch(() => undefined), 5 * 60_000);
  outcomeSweep.unref();
  // Old rows of the growing tables go once a day, a small batch at a time. The first run waits, so a
  // restart is not also a prune.
  const pruneDb = () =>
    background.run(async () => {
      const done = await pruneOld(
        store.raw,
        options.runClock === undefined ? {} : { now: options.runClock() },
      );
      if (Object.keys(done.deleted).length > 0)
        console.log(`retention pruned ${JSON.stringify(done.deleted)} in ${done.batches} batches`);
    });
  const retentionSweep = setInterval(pruneDb, RETENTION_SWEEP_MS);
  retentionSweep.unref();
  const retentionFirst = setTimeout(pruneDb, RETENTION_FIRST_MS);
  retentionFirst.unref();
  // A backlog of waiting memories runs the memory chore of the workspace that reviews them.
  autonomy.useLaneGate(captain.laneGate);
  events.typing.onIdle((task) => captain.ownerIdle(task));
  memory.onWaiting((fact) => void captain.memoryWaiting(fact).catch(() => undefined));
  background.run(
    () => captain.boot(),
    (err) => console.error(`Could not pick up the captain: ${errorMessage(err)}`),
  );
  background.run(
    () => autonomy.boot(),
    (err) => console.error(`Could not pick up autonomous mode: ${errorMessage(err)}`),
  );
  const resilience = new Resilience({
    runs,
    tasks,
    store,
    room,
    config,
    probe: options.probe ?? probeFromSetting(env.netProbe),
    ...(env.netProbeMs === undefined ? {} : { probeMs: env.netProbeMs }),
    runners: runner.runner,
    resumeReady: async () => {
      if (busyReason(machine.get()?.host) !== undefined) return false;
      return (await runs.capacity()).agents.free > 0;
    },
    accountSignedIn: async (id) => signedIn((await accounts.health(id, true)).account.status),
    ...(options.runClock === undefined ? {} : { now: () => (options.runClock?.() ?? new Date()).getTime() }),
  });
  if (options.hostLink !== undefined) machine.start();
  options.hostLink?.onWake(() => background.run(() => resilience.wake()));
  background.run(
    async () => {
      // Effects a crash left in the lifecycle outbox run first, so the reconcile sees their result.
      await tasks.drainOutbox();
      await resilience.startup();
    },
    (err) => console.error(`Could not resume interrupted work: ${errorMessage(err)}`),
  );
  const secretService = new SecretService(secrets, config);
  const orgs = new OrgService(config, agentStore, (id, newId) => {
    store.tasks.renameOrg(id, newId);
    events.emit(["tasks"]);
  });
  orgs.onGitChange = (org) => captain.gitChanged(org);
  const gitConnect = createGitConnect({
    config,
    secrets,
    secretService,
    orgs,
    projects,
    store,
    events,
    hostLink: options.hostLink,
    hostHome: env.hostHome,
    tokens: gitTokens,
    fetch: options.gitFetch ?? fetch,
    checkHost: (host, o) =>
      assertHostAllowed(host, {
        allowPrivate: o.allowPrivate,
        ...(options.hostLookup === undefined ? {} : { lookup: options.hostLookup }),
      }),
    onSignedIn: (done) => gitLinkRef.signedIn?.(done),
  });
  // Where each connection stands (5.14). Its check is the connection tester, made below.
  const testerRef: { current?: ConnectionTester } = {};
  const reportAttention = (item: { org: string; key: string; title: string; detail: string }) => {
    void findings
      .report(
        {
          org: item.org,
          source: "setup",
          title: item.title,
          detail: item.detail,
          evidence: [],
          severity: "medium",
          dedupeKey: item.key,
        },
        { kind: "owner" },
      )
      .catch(() => undefined);
  };
  // A service on this computer that connects while agents work reaches them at once (5.14). Bound below.
  const liveHost: { current?: LiveHostServices } = {};
  const connectionHealth = new ConnectionHealthService({
    moved: (id, connected) => {
      if (connected) void liveHost.current?.connected(id);
      else void liveHost.current?.ended(id, "Its check no longer passes.");
    },
    repo: store.connectionHealth,
    list: async () =>
      Object.entries(connectionScopes(await config.sections())).flatMap(([org, entry]) =>
        Object.entries(entry.connections ?? {}).map(([id, c]) => ({ id, org, name: c.name })),
      ),
    check: async (id) => {
      if (testerRef.current === undefined) throw new Error("Connection checks are not ready.");
      return testerRef.current.test(id);
    },
    changed: () => events.emit(["connections"]),
    attention: reportAttention,
  });
  const connections = new ConnectionService({
    ownPorts,
    health: (id) => connectionHealth.get(id),
    config,
    secrets,
    secretService,
    uploads,
    agents: agentStore,
    majhiHome: env.majhiHome,
    agentsChanged: (list) => {
      for (const agent of list) runs.remountAgent(agent);
    },
    fieldsChanged: (id) => {
      // A service on this computer changed ports: its old forwarders end now and new ones start for live sessions.
      background.run(async () => {
        await liveHost.current?.changed(id, connectionHealth.get(id)?.state === "connected");
      });
      runs.remountConnection(id);
    },
  });
  liveHost.current = new LiveHostServices({
    connection: async (id) => {
      for (const [org, entry] of Object.entries(connectionScopes(await config.sections()))) {
        const c = entry.connections?.[id];
        if (c !== undefined) {
          return { org, type: c.type, ports: c.fields?.ports, agentsOff: c.agents_off ?? [] };
        }
      }
      return undefined;
    },
    sessions: () => runs.openSessions(),
    taskOrg: (task) => store.tasks.get(task as TaskId)?.org,
    agentScope: async (agent) => {
      const stored = await agentStore.get(agent);
      return stored?.ok === true ? stored.agent.frontmatter.scope : undefined;
    },
    forward: (task, services) => containers.hostForward(task, services),
    stop: (id) => containers.hostForwardStop(id),
    say: (task, text) =>
      room.post(task as TaskId, `host-service:${randomUUID()}`, { type: "system", level: "info", text }),
    tell: (task, agent, text) => runs.note(task, agent, text),
  });
  connections.onRemoved(async (id) => {
    await liveHost.current?.ended(id, "It was removed.");
  });
  const connect = new ConnectService({
    grants: new GrantStore(secrets),
    apps: new AppClientStore(secrets),
    builtInApps: BUILT_IN_CONNECT_APPS,
    githubClientId: async () => (await gitConnect.apps()).github?.clientId,
    ...(options.hostLink === undefined ? {} : { cli: hostCli(options.hostLink) }),
    orgName: async (org) => connectionScopes(await config.sections())[org]?.name,
    secretOf: async (connection, name) => {
      const orgs = connectionScopes(await config.sections());
      for (const entry of Object.values(orgs)) {
        const ref = entry.connections?.[connection]?.vars?.[name]?.value;
        if (ref !== undefined && ref.startsWith("secret:")) return secrets.get(ref.slice("secret:".length));
      }
      return undefined;
    },
    connections: {
      create: (input, command, meta) => connections.create(input, command, meta),
      remove: (id, command, meta) => connections.remove(id, command, meta),
      find: (id) => connections.find(id),
      setSecret: (input, command, meta) => connections.setSecret(input, command, meta),
    },
    connectionIds: async () =>
      Object.entries(connectionScopes(await config.sections())).flatMap(([org, entry]) =>
        Object.entries(entry.connections ?? {}).map(([id, connection]) => ({ org, id, connection })),
      ),
    orgExists: async (org) => org === GLOBAL_CONNECTIONS || (await config.sections()).orgs[org] !== undefined,
    redirect: `${env.origin}/oauth/callback`,
    openUrl: async (url) => {
      if (options.hostLink === undefined || !options.hostLink.isConnected()) return false;
      return (await options.hostLink.call("openUrl", { url }, 10_000)).opened;
    },
    helperConnected: () => options.hostLink?.isConnected() ?? false,
    ...(options.connectFetch === undefined ? {} : { fetch: options.connectFetch }),
    ...(options.connectCatalog === undefined ? {} : { catalog: options.connectCatalog }),
    changed: () => events.emit(["connections"]),
    health: connectionHealth,
    ...(options.hostLookup === undefined ? {} : { lookup: options.hostLookup }),
    listTools: (url, token) =>
      listTools(remoteTransport(url, { Authorization: `Bearer ${token}` }, "http"), 30_000),
    inUse: (id) => runs.holdsConnection(id),
    remount: (id) => runs.remountConnection(id),
    attention: reportAttention,
  });
  oauth.bearer = (id) => connect.bearer(id);
  connect.startSweeper();
  connections.onRemoved((id) => connect.removed(id));
  const skills = new SkillService({
    store: skillStore,
    cli: new SkillsCli({
      spawner: sessionOptions.spawner ?? localSpawner,
      base: sessionOptions.base,
      // In the tasks folder: runners can mount it, and it is never inside majhi's config folder.
      scratchRoot: async () => {
        const loaded = await config.load();
        if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
        return join(loaded.state.config.tasksDir, ".skills");
      },
      ...(options.skillsCommand === undefined ? {} : { command: options.skillsCommand }),
      gitEnv: async (org, source) => skillGitEnv(gitTokens, (await config.sections()).orgs, org, source),
    }),
    registry: new SkillRegistry(options.skillsFetch ?? fetch),
    agents: {
      skillLists: async () =>
        (await agents.list()).flatMap((e) =>
          e.status === "ok" ? [{ id: e.agent.frontmatter.id, scope: e.agent.frontmatter.scope }] : [],
        ),
    },
    uploads,
    usage: (since) => store.runs.skillUsage(since),
    runsOf: (task) => store.runs.skillRuns(task),
    changed: (ids) => {
      for (const id of ids) runs.remountAgent(id);
    },
    audit: (row) => store.permissions.log(row),
    roots: async () => {
      const loaded = await config.load();
      if (loaded.state.status !== "loaded") return [];
      return [...loaded.state.config.workspaces, loaded.state.config.tasksDir];
    },
    hostHome: env.hostHome,
  });
  // Agent files used to list their skills: move the lists into the skills lock once.
  background.run(() => migrateAgentSkills({ agents, store: skillStore }, { actor: { kind: "owner" } }));
  const connectionTests = new ConnectionTester({
    // From where the forwarders run: Docker's name for this computer when majhi is in Docker, else this machine.
    hostProbe: (port) => probePort(existsSync("/.dockerenv") ? "host.docker.internal" : "127.0.0.1", port),
    oauth: connect,
    gitCheck: async (org, provider, host, privateNetwork) => {
      const fetchFn = options.gitFetch ?? fetch;
      if (host !== DEFAULT_GIT_HOST[provider]) {
        try {
          await assertHostAllowed(host, {
            allowPrivate: privateNetwork,
            ...(options.hostLookup === undefined ? {} : { lookup: options.hostLookup }),
          });
        } catch (err) {
          const fix = err instanceof Error ? err.message : "majhi refuses this address.";
          return { ok: false, failure: { reason: "blocked-host", fix } };
        }
      }
      let last: Awaited<ReturnType<typeof checkGitToken>> | undefined;
      const used = await gitTokens
        .withToken(org, provider, host, async (token) => {
          last = await checkGitToken(fetchFn, provider, host, token);
          // A refused token of a sign-in that renews is tried once more with a fresh one.
          if (!last.ok && last.failure.reason === "rejected") throw new TokenRefused("refused");
          return last;
        })
        .catch((err: unknown) => ({ state: "error" as const, err }));
      if (used.state === "ok") return used.value;
      if (used.state === "signed-out") return { problem: "signed-out" as const };
      if (used.state === "refused") {
        return last !== undefined && !last.ok
          ? last
          : {
              ok: false,
              failure: {
                reason: "rejected",
                fix: `${host} refused the workspace's sign-in. Sign it in again.`,
              },
            };
      }
      return { ok: false, failure: { reason: failureFromError(used.err) } };
    },
    health: connectionHealth,
    connections,
    secrets,
    spawner: sessionOptions.spawner ?? localSpawner,
    base: sessionOptions.base,
    // In the tasks folder: runners can mount it, and it is never inside majhi's config folder.
    scratchRoot: async () => {
      const loaded = await config.load();
      if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
      return join(loaded.state.config.tasksDir, ".connections");
    },
    hostHome: env.hostHome,
    // The runner image has the browser servers, so a Test there downloads nothing.
    ...(env.runner.mode === "container"
      ? { browserCommand: (server: BrowserServer) => ({ command: server.command, args: [] }) }
      : {}),
  });
  testerRef.current = connectionTests;
  connections.onRemoved(async (id) => connectionHealth.remove(id));
  const gitLink = new GitLink({
    connections: {
      list: () => connections.list(),
      create: (input, command, meta) => connections.create(input as never, command, meta),
      update: (input, command, meta) => connections.update(input as never, command, meta),
    },
    orgs: async () => (await config.sections()).orgs,
    kindOf: (host) => {
      const kind = classifyHost(host);
      return kind === "other" ? undefined : mrKindOf(kind);
    },
    // A grant means the host's own page signed in (GitLab); a GitHub token that `gh` made starts with gho_.
    viaOf: async (_org, account) => {
      if (account.oauth !== undefined) return "browser";
      if (account.token === undefined) return undefined;
      const value = await secrets.get(account.token.replace(/^secret:/, ""));
      return value?.startsWith("gho_") === true ? "browser" : "token";
    },
    check: (id) => connectionTests.test(id),
    health: connectionHealth,
  });
  gitLinkRef.signedIn = (done) => void gitLink.signedIn(done).catch(() => undefined);
  const mcpUrl = new McpUrlService({
    fetch: options.connectFetch,
    lookup: options.hostLookup,
    connections: {
      create: (input, command, meta) => connections.create(input as never, command, meta),
      setSecret: (input, command, meta) => connections.setSecret(input, command, meta),
      remove: (id, command, meta) => connections.remove(id, command, meta),
    },
    connectionIds: async () =>
      Object.values(connectionScopes(await config.sections())).flatMap((entry) =>
        Object.keys(entry.connections ?? {}).map((id) => ({ id })),
      ),
    orgExists: async (org) => org === GLOBAL_CONNECTIONS || (await config.sections()).orgs[org] !== undefined,
    check: async (id) => {
      const result = await connectionTests.test(id);
      return { ok: result.ok, failure: result.failure };
    },
    health: connectionHealth,
    changed: () => events.emit(["connections"]),
  });
  const startConnectionChecks = () => {
    background.run(
      async () => {
        await gitLink.syncAll();
        connectionHealth.startSchedule();
      },
      (err) => console.error(`Could not start the connection checks: ${errorMessage(err)}`),
    );
  };
  const tools = new ToolInstaller({
    majhiHome: env.majhiHome,
    fetch: (url, init) => fetch(url, init),
    lookup: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  });
  /** Runs a read-only script in a throwaway runner with a workspace's connections. Watches and the captain's secret fetches use it. */
  const runScript = async ({
    org,
    script,
    connections: ids,
    network,
  }: {
    org: string;
    script: string;
    connections: readonly string[];
    network?: "on" | "off" | undefined;
  }): Promise<string> => {
    // The named connections of this workspace (or Global), as a run of an agent there would get them.
    const sections = await config.sections();
    const own = sections.orgs[org]?.connections ?? {};
    const shared = sections.connections ?? {};
    const held = ids.flatMap((id) =>
      own[id] !== undefined
        ? [{ id, org, connection: own[id] }]
        : shared[id] !== undefined
          ? [{ id, org: GLOBAL_CONNECTIONS, connection: shared[id] }]
          : [],
    );
    const plan = await planConnections(held, "/tmp/majhi-script", {
      secrets,
      connectionDir: connectionFiles.connectionDir,
      oauth: connectionFiles.oauth,
      gitToken: connectionFiles.gitToken,
    });
    const vars: Record<string, string> = { ...plan.env };
    // A signed-in connection's token for its own API, as <ID>_TOKEN.
    for (const h of held) {
      if (textValue(h.connection, "auth") !== "oauth") continue;
      const bearer = await connectionFiles.oauth(h.id);
      if ("token" in bearer) vars[`${h.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`] = bearer.token;
    }
    try {
      return await runImageCheck(
        containerDocker,
        { majhiHome: env.majhiHome, hostHome: env.hostHome, protectedPaths: [env.secretsKeyFile] },
        {
          // The workspace's checked programs (doctl, kubectl, whatever was installed) come first on PATH.
          image: env.runner.image,
          command: ["sh", "-c", `PATH="${TOOLS_TARGET}:$PATH"; export PATH\n${script}`],
          env: vars,
          toolsOrg: org,
          offline: network === "off",
        },
        60_000,
      );
    } catch (err) {
      throw err instanceof ImageCheckFailed ? new Unavailable(err.message) : err;
    }
  };
  const ops = createOps({
    db: store.raw,
    findings,
    secrets,
    notifier,
    wake: (org, text) => autonomy.news(text, org),
    ruleOff: (org, rule) => ruleSwitches.off(org, rule),
    orgName: async (org) =>
      org === PRIVATE ? "Private" : ((await config.sections()).orgs[org]?.name ?? org),
    projectOrg: async (id) => (await config.sections()).projects[id]?.org,
    projectCheckout: async (id) => {
      const info = (await projects.infos()).find((p) => p.id === id);
      return info === undefined ? undefined : { org: info.org, path: info.path };
    },
    action: {
      validate: (org, action) => automation.runner.validate(org, action),
      run: (source, action, overlap) => automation.runner.run(source, action, overlap),
      runs: (id, limit) => automation.runner.history.list("watch", id, limit),
      forget: (id) => automation.runner.history.deleteFor("watch", id),
    },
    connections: {
      list: async (org) =>
        (await connections.list(org)).map((c) => ({ id: c.id, name: c.name, type: c.type })),
      orgOf: async (id) => (await connections.find(id))?.org,
    },
    host: watchHost,
    imageRun: async (input, timeoutMs) => {
      try {
        return await runImageCheck(
          containerDocker,
          { majhiHome: env.majhiHome, hostHome: env.hostHome, protectedPaths: [env.secretsKeyFile] },
          input,
          timeoutMs,
        );
      } catch (err) {
        throw err instanceof ImageCheckFailed ? new Unavailable(err.message) : err;
      }
    },
    scriptRun: runScript,
    tester: connectionTests,
    orgs: async () => Object.entries((await config.sections()).orgs).map(([id, o]) => ({ id, name: o.name })),
    askModel: async (task, prompt, parse) => {
      try {
        return (await housekeeper.ask(task, prompt, parse)).value;
      } catch (err) {
        if (err instanceof NoHousekeeper) return undefined;
        throw err;
      }
    },
    inbox: { list: () => inbox.list(), answer: (input) => inbox.answer(input) },
    drafts: (org) => outbound.list(org, 200),
    notifications: async () => {
      try {
        return (await config.settings()).notifications;
      } catch {
        return NotificationsSettingsSchema.parse({});
      }
    },
    online: options.probe ?? probeFromSetting(env.netProbe),
    changed: () => events.emit(["ops", "playbooks", "findings"]),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
    ...(options.opsProbes === undefined ? {} : { probes: options.opsProbes }),
    ...(options.ntfyFetch === undefined ? {} : { ntfyFetch: options.ntfyFetch }),
    ...(options.opsRetryMs === undefined ? {} : { retryMs: options.opsRetryMs }),
  });
  admin.useScript({
    run: runScript,
    holds: async (org, id) => {
      const sections = await config.sections();
      return sections.orgs[org]?.connections?.[id] !== undefined || sections.connections?.[id] !== undefined;
    },
  });
  admin.useClipboard({
    roots: async (org) => {
      const { projects } = await config.sections();
      return Object.values(projects ?? {})
        .filter((project) => project.org === org)
        .map((project) => resolvePath(project.path, config.paths.hostHome));
    },
    available: () => options.hostLink?.isConnected() ?? false,
    copy: async (text) => {
      if (options.hostLink === undefined) return false;
      return (await options.hostLink.call("clipboard.copy", { text }, 10_000)).copied;
    },
  });
  opsWatch = ops.watch;
  opsEngine = ops.engine;
  Object.assign(rulesTable, opsRunners(ops.watch));
  ops.start();
  const mcpServers = new McpService({
    connections,
    tester: connectionTests,
    registry: new McpRegistry(options.mcpFetch ?? fetch),
    agents: {
      scopes: async () =>
        (await agents.list()).flatMap((e) =>
          e.status === "ok" ? [{ id: e.agent.frontmatter.id, scope: e.agent.frontmatter.scope }] : [],
        ),
    },
    orgs: async () => Object.keys((await config.sections()).orgs),
    audit: (row) => store.permissions.log(row),
  });
  const installRequests = new InstallRequests({
    tasks,
    room,
    runs,
    admin,
    mcp: mcpServers,
    skills,
    scopeOf: async (agent) => {
      const found = (await agents.list()).find((e) => e.status === "ok" && e.agent.frontmatter.id === agent);
      return found?.status === "ok" ? found.agent.frontmatter.scope : undefined;
    },
  });
  // A new majhi version brings new instructions and tools for the captain; a resumed session keeps the
  // old ones. So after an update each captain thread starts fresh (with its handoff note) once.
  background.run(async () => {
    const refreshed = await freshCaptainAfterUpdate({
      commit: env.commit,
      file: join(env.majhiHome, "captain-version"),
      chats: () => autonomy.laneChats(),
      fresh: async (chat) => {
        const agent = store.tasks.get(chat)?.team[0];
        if (agent !== undefined) await tasks.fresh(chat, agent);
      },
    });
    // The same update may unblock waiting work: look at it now, not at the next hourly check.
    if (refreshed.length > 0) {
      const sections = await config.sections();
      const orgs = [PRIVATE, ...Object.keys(sections.orgs)];
      captain.afterUpdate(orgs);
      // Each lane retries what a majhi problem stopped: a fixed tool only helps if someone tries again.
      for (const org of orgs) {
        autonomy.news(
          `majhi was updated (${env.commit.slice(0, 8)}). Retry anything that failed because of a majhi problem, and go through what waits for the owner in this workspace: settle what a connection or a tool can settle, and say in one line why each of the rest needs the owner.`,
          org,
        );
      }
    }
  });
  return {
    config,
    runtime,
    secrets,
    keyExports: new KeyExports(env.majhiHome, secrets),
    secretService,
    connections,
    connect,
    connectionHealth,
    gitLink,
    mcpUrl,
    startConnectionChecks,
    skills: skills,
    skillStore,
    tools,
    mcpServers,
    installRequests,
    connectionTests,
    adminTokens,
    admin,
    agents,
    agentStore,
    decisions,
    decideTokens,
    roomAccess,
    coordinator,
    store,
    backup,
    uploads,
    projects,
    room,
    runs,
    tasks,
    mrs,
    gitLogins,
    gitConnect,
    cardActions,
    pendingShips,
    queuedMerges,
    cleanup,
    folderSweep,
    machine,
    notifier,
    mrPoller: new MrPoller(() => mrs.poll(), options.mrPollMs),
    processes,
    containers,
    autonomy,
    inbox,
    conversations,
    captain,
    findings,
    playbooks,
    goals,
    ops,
    outbound,
    outcomes,
    handoff,
    homeChecks: new HomeChecks({
      ids: () => store.tasks.idsWithStatus("review"),
      mergeChecks: (id) => tasks.mergeChecks(id),
      state: (id) => handoff.state(id),
      lastMessage: (id) => {
        room.flush(id);
        for (const item of store.room.page(id, 60).items) {
          if (item.type === "agent" && item.text.trim() !== "") return item.text;
        }
        return undefined;
      },
    }),
    agenda,
    map,
    codeGraph,
    captainTell: new CaptainTell({
      tasks,
      lanes,
      store,
      keys: captainRepo,
      lastTurn: (task, agent) => usageRepo.lastTurnId(task, agent),
      ...(options.runClock === undefined ? {} : { now: options.runClock }),
    }),
    lanes,
    bindCaptain: (dispatch) => {
      captainDispatch = dispatch;
    },
    automation,
    cards,
    memory,
    extraction,
    promotion,
    memoryScopes,
    resilience,
    usage: usageService,
    usageRecorder,
    budgets,
    runner: runner.runner,
    close: async () => {
      // No new hook work from here on (closing runs and processes fires hooks too).
      const settled = background.stop();
      resilience.stop();
      connect.stop();
      machine.close();
      autonomy.close();
      captain.close();
      playbooks.close();
      ops.close();
      idleWatch.stop();
      clearInterval(outcomeSweep);
      clearInterval(retentionSweep);
      clearTimeout(retentionFirst);
      clearInterval(chatSweep);
      conversations.stop();
      clearInterval(limitSweep);
      clearInterval(agendaSweep);
      clearInterval(pruneSweep);
      clearInterval(updateWatch);
      backup.stop();
      notifier.close();
      queuedMerges.stop();
      automation.scheduler.stop();
      cards.close();
      layaDocker?.close();
      await runs.closeAll();
      // Hooks already running (rewriting TASK.md at review, a restack) end before the stores close.
      // After the runs: a hook can wait on a lock a turn holds.
      await settled;
      // Titles and records of closed tasks run after their turn and write into the home: let them
      // end (the Housekeeper's sessions are cut short) before usage is flushed and the stores close.
      await housekeeper.close();
      await Promise.all([extraction.idle(), chatMemory?.idle()]);
      await processes.stopAll();
      await usageRecorder.flush();
      await memory.close();
      await backup.settle();
      store.close();
    },
    orgs,
    accounts,
    terminals,
    events,
    watcher: new HomeWatcher(env.majhiHome, events),
    usageSweeper: new UsageSweeper({ reader: usage, candidates: () => accounts.usageCandidates() }),
    openTaskTerminal: async (task) => ({
      terminalId: (
        await openTaskTerminal(
          {
            terminals,
            task: (id) => tasks.get(id),
            tasksDir: async () => {
              const loaded = await config.load();
              if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
              return loaded.state.config.tasksDir;
            },
            base: sessionOptions.base,
            repoMounts,
            packages: (t) => packageCache(env.majhiHome, t).catch(() => undefined),
            tty: runner.runner === undefined ? undefined : dockerTty(runner.runner.config),
          },
          task,
        )
      ).id,
    }),
    startLogin: (id) =>
      startLogin(
        {
          majhiHome: env.majhiHome,
          accounts,
          terminals,
          runtime,
          options: env.runtime,
          onFinished: () => events.emit(["accounts"]),
        },
        id,
      ),
  };
}

const UPDATE_WATCH_MS = 30_000;
/** A failed update older than this belongs to an earlier run of majhi, and is not news. */
const UPDATE_NEWS_MS = 10 * 60_000;

/** Tells the owner once when the helper's update failed, from the status file it writes. */
async function watchUpdate(majhiHome: string, notifier: Notifier): Promise<void> {
  try {
    const parsed = UpdateStatusSchema.safeParse(
      JSON.parse(await readFile(join(majhiHome, UPDATE_STATUS_FILE), "utf8")),
    );
    if (!parsed.success || parsed.data.state !== "failed") return;
    const started = Date.parse(parsed.data.startedAt);
    if (!(Date.now() - started < UPDATE_NEWS_MS)) return;
    notifier.updateFailed(parsed.data.startedAt, parsed.data.error ?? "see Health for the reason");
  } catch {
    // No status file yet, or an unreadable one: nothing to tell.
  }
}
