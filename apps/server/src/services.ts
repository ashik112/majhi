import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Command, dockerTty, localSpawner } from "@majhi/acp";
import {
  type CaptainChore,
  isOwnerChat,
  NotificationsSettingsSchema,
  PRIVATE,
  UPDATE_STATUS_FILE,
  UpdateStatusSchema,
} from "@majhi/shared";
import { AccountCache } from "./accounts/cache.ts";
import { AccountProbes } from "./accounts/health.ts";
import { startLogin } from "./accounts/login.ts";
import { AccountService } from "./accounts/service.ts";
import { AccountUsageReader, UsageSweeper } from "./accounts/usage.ts";
import { AdminAccess } from "./admin/access.ts";
import { isBossChat } from "./admin/boss.ts";
import { AdminService } from "./admin/service.ts";
import { AdminTokens } from "./admin/tokens.ts";
import { AgentService } from "./agents/service.ts";
import { AgentStore } from "./agents/store.ts";
import { createActionHost } from "./automation/host.ts";
import { type Automation, createAutomation } from "./automation/index.ts";
import { ScheduleRepo } from "./automation/schedules.ts";
import { createWatchHost } from "./automation/triggers/host.ts";
import { TriggerRepo } from "./automation/triggers/repo.ts";
import { AutonomyDriver } from "./autonomy/driver.ts";
import { AutonomyService } from "./autonomy/service.ts";
import { Background } from "./background.ts";
import { BackupService } from "./backup/service.ts";
import { alertLine } from "./budgets/alert-line.ts";
import { atLimit, liftLimits } from "./budgets/limit-action.ts";
import { BudgetMonitor } from "./budgets/monitor.ts";
import { BudgetAlertRepo } from "./budgets/repo.ts";
import { Lanes } from "./captain/lanes.ts";
import { authorityOf } from "./captain/levels.ts";
import { CaptainRepo } from "./captain/repo.ts";
import { CaptainService } from "./captain/service.ts";
import { captainWorld } from "./captain/world.ts";
import type { Dispatch } from "./commands/dispatch.ts";
import { resolvePath } from "./config/load.ts";
import { ConfigService } from "./config/service.ts";
import { type BrowserServer, RUNNER_BROWSERS_PATH } from "./connections/browser.ts";
import { redactSecrets } from "./connections/redact.ts";
import type { RemoteRunFn } from "./connections/remote.ts";
import { sweepRunFiles } from "./connections/run-files.ts";
import { ConnectionService, connectionDir } from "./connections/service.ts";
import { ConnectionTester } from "./connections/tester.ts";
import { DockerCli } from "./containers/docker.ts";
import { type ContainerDocker, ContainerService } from "./containers/service.ts";
import { AcpProvider } from "./decisions/acp.ts";
import { dockerCli, LayaDocker } from "./decisions/layaDocker.ts";
import { LayaProvider } from "./decisions/layaProvider.ts";
import { DecisionLog } from "./decisions/log.ts";
import { rulesProvider } from "./decisions/rules.ts";
import { DecisionService } from "./decisions/service.ts";
import { DecideTokens } from "./decisions/tokens.ts";
import type { E2eService } from "./e2e/service.ts";
import { createE2e } from "./e2e/wire.ts";
import type { ServerEnv } from "./env.ts";
import { errorMessage, UserError } from "./errors.ts";
import { EventHub } from "./events/hub.ts";
import { HomeWatcher } from "./events/watcher.ts";
import { GitLoginService } from "./git/logins.ts";
import type { Fetch } from "./gitConnect/http.ts";
import { createGitConnect, createGitTokens, type GitConnect, pushAuthFor } from "./gitConnect/wire.ts";
import type { HostLink } from "./host/link.ts";
import { RecommendationRepo } from "./inbox/recommendations.ts";
import { InboxService } from "./inbox/service.ts";
import { InstallRequests } from "./installs/service.ts";
import { McpRegistry } from "./mcp-servers/registry.ts";
import { McpService } from "./mcp-servers/service.ts";
import { ChatMemory } from "./memory/chats.ts";
import { cleanupRepoDocFacts } from "./memory/cleanup.ts";
import { Curator } from "./memory/curator.ts";
import type { Embedder } from "./memory/embedder.ts";
import { curationTask, Extraction } from "./memory/extraction.ts";
import { Housekeeper } from "./memory/housekeeper.ts";
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
import { Notifier } from "./notify/service.ts";
import { mrKindOf } from "./orgs/gitAccount.ts";
import { OrgService } from "./orgs/service.ts";
import { ProcessManager } from "./processes/manager.ts";
import { ProjectService } from "./projects/service.ts";
import { RoomService } from "./room/service.ts";
import { RoomAccess } from "./rooms/access.ts";
import { RoomCoordinator } from "./rooms/coordinator.ts";
import { IdleWatch } from "./rooms/idle-watch.ts";
import type { Inspect } from "./runner/network.ts";
import { type Runner, runnerSetup } from "./runner/setup.ts";
import { DEFAULT_IDENTITY } from "./runs/checkpoint.ts";
import { processLaunch, repoMounts } from "./runs/launch.ts";
import { RunManager } from "./runs/manager.ts";
import { type Probe, probeFromSetting } from "./runs/network.ts";
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
import { SkillRegistry } from "./skills/registry.ts";
import { SkillService } from "./skills/service.ts";
import { SkillStore } from "./skills/store.ts";
import { DB_FILE_NAME, Store } from "./store/index.ts";
import { CardActions } from "./tasks/card-actions.ts";
import { CleanupService } from "./tasks/cleanup.ts";
import type { LinkOptions } from "./tasks/links.ts";
import { PendingShips } from "./tasks/pending-ship.ts";
import { TaskService } from "./tasks/service.ts";
import { TerminalManager, type TerminalTimers } from "./terminal/manager.ts";
import { openTaskTerminal } from "./terminal/task-terminal.ts";
import { createAdapter } from "./trackers/index.ts";
import { TrackerService } from "./trackers/service.ts";
import type { TrackerAdapter, TrackerAdapterInit } from "./trackers/types.ts";
import { UploadStore } from "./uploads/store.ts";
import { readPrices } from "./usage/prices.ts";
import { UsageRecorder } from "./usage/recorder.ts";
import { UsageRepo } from "./usage/repo.ts";
import { UsageService } from "./usage/service.ts";

/** How often chats are checked for memory. */
const CHAT_SWEEP_MS = 60_000;
/** How often paused budget runs are checked against the week. */
const LIMIT_SWEEP_MS = 60_000;
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
  /** Replaces `fetch` for Jira, ClickUp and GitHub Issues, so tests never reach a tracker. */
  trackerFetch?: typeof fetch;
  /** Replaces the tracker adapters, so tests can play a tracker without its API. */
  trackerAdapter?: (init: TrackerAdapterInit) => TrackerAdapter;
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
  /** The Test of each connection, for connections.test and the Health page. */
  connectionTests: ConnectionTester;
  /** Installed skills and the per-agent switches (5.2). */
  skills: SkillService;
  /** The skills store, for runs to copy from. */
  skillStore: SkillStore;
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
  /** Worktrees, merged branches and room logs of tasks done for a while. */
  cleanup: CleanupService;
  mrPoller: MrPoller;
  /** Jira, ClickUp and GitHub Issues per org: pull into Up next, push, write MR links and status back (5.11). */
  trackers: TrackerService;
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
  /** The captain per workspace (5.18): the choice, the upkeep chores, the lanes, the log and the stop switch. */
  captain: CaptainService;
  /** The captain's chat per workspace (5.18). */
  lanes: Lanes;
  /** The captain's chores run commands through the dispatcher, made after the services. */
  bindCaptain(dispatch: Dispatch): void;
  /** Schedules and the action runner they share with watch triggers (PRV-63). */
  automation: Automation;
  /** Background e2e after a merge into main (PRV-72). Without a host helper link there is none. */
  e2e: E2eService | undefined;
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
  });
  const store = Store.open(env.majhiHome);
  const backup = new BackupService({
    majhiHome: env.majhiHome,
    sqlite: () => store.raw,
    dbFile: DB_FILE_NAME,
  });
  backup.start();
  const memory = createMemory(env.majhiHome, options.embedder);
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
  const runner = runnerSetup(env, options.runnerInspect, (task) => containers.taskNetworks(task));
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
    lift: () =>
      liftLimits({
        runs,
        // A run autonomous mode holds stays held when no budget does.
        limited: async (task, agent) => (await limitedRun(task, agent)) ?? autonomy.holdFor(task)?.why,
        pausedTasks: () =>
          store.tasks.list(false).filter((t) => t.status === "paused" && t.pausedReason === "limit"),
        start: (id) => tasks.start(id, "majhi"),
      }),
  });
  /** Whether a budget holds this agent's task: its org's budget, or its account's. */
  const limitedRun = async (task: string, agent: string): Promise<string | undefined> => {
    const found = store.tasks.get(task);
    // The captain is how the owner raises a budget (SPEC 5.17): its chat is never held.
    if (found !== undefined && isBossChat(found)) return undefined;
    const org = found?.org ?? null;
    const stored = await agentStore.get(agent);
    const account =
      stored === undefined ? undefined : stored.ok ? stored.agent.frontmatter.account : stored.account;
    return budgets.limitedFor({ org, account, task });
  };
  const usageRecorder = new UsageRecorder({
    repo: usageRepo,
    store,
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
  const connectionFiles = {
    connectionDir: (id: string) => connectionDir(env.majhiHome, id),
    browsersPath:
      sessionOptions.base.PLAYWRIGHT_BROWSERS_PATH ??
      (env.runner.mode === "container" ? RUNNER_BROWSERS_PATH : undefined),
  };
  // No run is alive yet: every connection folder left from before goes.
  background.run(() => sweepRunFiles(env.majhiHome));
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
  const runs = new RunManager({
    store,
    limited: limitedRun,
    // Bound below: autonomous mode is built after the task service.
    held: (task) => autonomy.held(task),
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
    ...(env.runner.mode === "container" ? { serena: { command: SERENA_COMMAND } } : {}),
    onTasksChanged: () => events.emit(["tasks"]),
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
    inDocs: async (t, text) => {
      if (t === undefined) return undefined;
      const paths = (await projectList()).filter((p) => t.projects.includes(p.id)).map((p) => p.path);
      const match = await repoDocs.match(text, await repoDocs.chunks(paths), LESSON_DOC_COSINE);
      return match?.chunk.file;
    },
  });
  memory.useCurator((fact) => curator.curate(fact));
  const housekeeper = new Housekeeper({
    config,
    agents: agentStore,
    secrets,
    runtime,
    options: sessionOptions,
    majhiHome: env.majhiHome,
    usage: usageRecorder,
  });
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
  // Bound below: background e2e is built after the task service, which it creates tasks with.
  let e2e: E2eService | undefined;
  const tasks = new TaskService({
    protectedPaths: [env.secretsKeyFile],
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
    onRemoving: (task) => promotion.release(task),
    // Bound below: autonomous mode keeps its chat while the mode is not off.
    guardRemoval: (task, action) => autonomy.guardChat(task, action),
    // Bound below: the merge requests service is built after the task service.
    onReview: (id) => {
      captain.reviewReached(id);
      return pendingShips.reviewReached(id);
    },
    onMerged: (merge) => e2e?.onMerged(merge),
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
  /** The task an item belongs to, as notifications and the Decisions inbox name it. */
  const subjectOf = (id: string): Subject | undefined => {
    const task = store.tasks.get(id);
    return task === undefined
      ? undefined
      : {
          id: task.id,
          title: task.title,
          chat: isOwnerChat(task),
          ...(task.org === undefined ? {} : { org: task.org }),
          repos: task.repos.length,
        };
  };
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
    settings: async () => {
      try {
        return (await config.settings()).notifications;
      } catch {
        return NotificationsSettingsSchema.parse({});
      }
    },
    events,
    ...(options.hostLink === undefined
      ? {}
      : {
          desktop: async (notice) => {
            await options.hostLink?.call("notify", notice);
          },
        }),
  });
  room.onWrite((task, item) => notifier.observe(task, item));
  room.onWrite((task, item) => captain.roomWrote(task, item));
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
  e2e =
    options.hostLink === undefined
      ? undefined
      : createE2e({
          store,
          config,
          projects,
          hostLink: options.hostLink,
          room,
          tasks,
          uploads,
          majhiHome: env.majhiHome,
          log: (message) => console.error(message),
        });
  const pendingShips = new PendingShips({ store, tasks, mrs, room, events, now: () => new Date() });
  const actionHost = createActionHost({ store, tasks, processes, projects, agents: agentStore });
  const automation = createAutomation({
    db: store.raw,
    host: actionHost,
    watch: createWatchHost({ store, processes, projects, usage: usageService, actions: actionHost }),
    orgIds: async () => new Set(Object.keys((await config.sections()).orgs)),
    changed: () => events.emit(["schedules"]),
    triggersChanged: () => events.emit(["triggers"]),
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
  const triggerRows = new TriggerRepo(store.raw);
  const captainRepo = new CaptainRepo(store.raw);
  const cardActions = new CardActions({ tasks, mrs, room });
  const inbox = new InboxService({
    items: () => store.room.waitingDecisions(),
    subject: (id) => {
      const task = store.tasks.get(id);
      return task === undefined || task.status === "done" ? undefined : subjectOf(id);
    },
    caps: async () => (await captain.asks()).asks,
    budgets: () => autonomy.budgetAsks(),
    signedOut: async () =>
      (await accounts.list())
        .filter((a) => a.status === "needs-login" || a.status === "unreachable")
        .map((a) => ({ id: a.id, at: a.lastHealth?.checkedAt ?? new Date().toISOString() })),
    recommendations: new RecommendationRepo(store.raw),
    actions: {
      answerAsk: (task, item, answers) => tasks.answerAsk(task, item, answers),
      answerQuestion: (task, item, choice) => tasks.answerQuestion(task, item, choice),
      answerChoice: (task, item, option) => tasks.answerChoice(task, item, option),
      answerPermission: (task, item, option) => tasks.answerPermission(task, item, option),
      decideApproval: (task, item, decision) => admin.decide(task, item, decision, undefined),
      cardAction: (task, item, action) => cardActions.act({ task, item, action, by: "owner", agent: false }),
      answerCap: (org, chore, answer) => captain.answerCap(org, chore as CaptainChore, answer),
      answerBudget: (scope, answer) => autonomy.answerBudget(scope, answer),
    },
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
  const autonomy = new AutonomyService({
    lanes,
    typing: (task) => events.typing.holds(task),
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
    automationAction: (kind, id) =>
      (kind === "schedule" ? scheduleRows.get(id) : triggerRows.get(id))?.action.kind,
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
      store,
      events,
      ...(options.runClock === undefined ? {} : { now: options.runClock }),
    }),
  );
  admin.useAutonomy(autonomy);
  const cleanup = new CleanupService({ store, room, events, projects });
  /** Bound when the server made the dispatcher: the captain's chores run commands as the captain. */
  let captainDispatch: Dispatch | undefined;
  const captain = new CaptainService({
    store,
    config,
    events,
    autonomy,
    lanes,
    threadState: (chat, org) =>
      store.room.tasksWaitingOnOwner().has(chat) ||
      [...store.room.tasksPausedOnOwner()].some((id) => (store.tasks.get(id)?.org ?? PRIVATE) === org)
        ? "waiting"
        : runs.working(chat).length > 0
          ? "working"
          : "idle",
    fresh: (chat, agent) => tasks.fresh(chat, agent),
    ports: captainWorld({
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
      curate: (fact) => curator.curate(fact, { upkeep: true }),
      scanner: new RepoScanner(),
      cleanup,
      idle: idleWatch,
      runs,
      lanes,
      repo: captainRepo,
      typing: (task) => events.typing.holds(task),
      dispatch: () => captainDispatch,
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
  // A backlog of waiting memories runs the memory chore of the workspace that reviews them.
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
    accountSignedIn: async (id) => signedIn((await accounts.health(id, true)).account.status),
    ...(options.runClock === undefined ? {} : { now: () => (options.runClock?.() ?? new Date()).getTime() }),
  });
  options.hostLink?.onWake(() => background.run(() => resilience.wake()));
  background.run(
    () => resilience.startup(),
    (err) => console.error(`Could not resume interrupted work: ${errorMessage(err)}`),
  );
  const secretService = new SecretService(secrets, config);
  const orgs = new OrgService(config, agentStore, (id, newId) => {
    store.tasks.renameOrg(id, newId);
    events.emit(["tasks"]);
  });
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
  });
  const connections = new ConnectionService({
    config,
    secrets,
    secretService,
    uploads,
    agents: agentStore,
    majhiHome: env.majhiHome,
    agentsChanged: (list) => {
      for (const agent of list) runs.remountAgent(agent);
    },
  });
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
          e.status === "ok" ? [{ id: e.agent.frontmatter.id, skills: e.agent.frontmatter.skills }] : [],
        ),
      setSkills: async (agent, list, command, meta) => {
        await agents.edit(agent, { set: { skills: list } }, command, meta);
      },
    },
    uploads,
    audit: (row) => store.permissions.log(row),
    roots: async () => {
      const loaded = await config.load();
      if (loaded.state.status !== "loaded") return [];
      return [...loaded.state.config.workspaces, loaded.state.config.tasksDir];
    },
    hostHome: env.hostHome,
  });
  const connectionTests = new ConnectionTester({
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
  const mcpServers = new McpService({
    connections,
    tester: connectionTests,
    registry: new McpRegistry(options.mcpFetch ?? fetch),
    agents: {
      connectionLists: async () =>
        (await agents.list()).flatMap((e) =>
          e.status === "ok"
            ? [
                {
                  id: e.agent.frontmatter.id,
                  scope: e.agent.frontmatter.scope,
                  connections: e.agent.frontmatter.connections,
                },
              ]
            : [],
        ),
      setConnections: async (agent, list, command, meta) => {
        await agents.edit(agent, { set: { connections: list } }, command, meta);
      },
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
  const trackers = new TrackerService({
    store,
    config,
    secrets,
    room,
    events,
    projects,
    tasks,
    decisions,
    adapter: options.trackerAdapter ?? createAdapter,
    ...(options.trackerFetch === undefined ? {} : { fetch: options.trackerFetch }),
  });
  return {
    config,
    runtime,
    secrets,
    keyExports: new KeyExports(env.majhiHome, secrets),
    secretService,
    connections,
    skills: skills,
    skillStore,
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
    cleanup,
    notifier,
    mrPoller: new MrPoller(() => mrs.poll(), options.mrPollMs),
    trackers,
    processes,
    containers,
    autonomy,
    inbox,
    captain,
    lanes,
    bindCaptain: (dispatch) => {
      captainDispatch = dispatch;
    },
    automation,
    e2e,
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
      autonomy.close();
      captain.close();
      idleWatch.stop();
      clearInterval(chatSweep);
      clearInterval(limitSweep);
      clearInterval(pruneSweep);
      clearInterval(updateWatch);
      backup.stop();
      notifier.close();
      automation.scheduler.stop();
      automation.triggerEngine.stop();
      e2e?.close();
      layaDocker?.close();
      await runs.closeAll();
      await trackers.stop();
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
