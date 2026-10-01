import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerTty, localSpawner } from "@majhi/acp";
import {
  isOwnerChat,
  NotificationsSettingsSchema,
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
import { createWatchHost } from "./automation/triggers/host.ts";
import { resolvePath } from "./config/load.ts";
import { ConfigService } from "./config/service.ts";
import { DockerCli } from "./containers/docker.ts";
import { type ContainerDocker, ContainerService } from "./containers/service.ts";
import { AcpProvider } from "./decisions/acp.ts";
import { dockerCli, LayaDocker } from "./decisions/layaDocker.ts";
import { LayaProvider } from "./decisions/layaProvider.ts";
import { DecisionLog } from "./decisions/log.ts";
import { rulesProvider } from "./decisions/rules.ts";
import { DecisionService } from "./decisions/service.ts";
import { DecideTokens } from "./decisions/tokens.ts";
import type { ServerEnv } from "./env.ts";
import { errorMessage, UserError } from "./errors.ts";
import { EventHub } from "./events/hub.ts";
import { HomeWatcher } from "./events/watcher.ts";
import { GitLoginService } from "./git/logins.ts";
import type { HostLink } from "./host/link.ts";
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
import { Notifier } from "./notify/service.ts";
import { OrgService } from "./orgs/service.ts";
import { ProcessManager } from "./processes/manager.ts";
import { ProjectService } from "./projects/service.ts";
import { RoomService } from "./room/service.ts";
import { RoomAccess } from "./rooms/access.ts";
import { RoomCoordinator } from "./rooms/coordinator.ts";
import type { Inspect } from "./runner/network.ts";
import { type Runner, runnerSetup } from "./runner/setup.ts";
import { processLaunch, repoMounts } from "./runs/launch.ts";
import { RunManager } from "./runs/manager.ts";
import { type Probe, probeFromSetting } from "./runs/network.ts";
import { Resilience } from "./runs/resilience.ts";
import { type AcpRuntime, realRuntime } from "./runtime.ts";
import { SecretService } from "./secrets/service.ts";
import { SecretStore } from "./secrets/store.ts";
import { Store } from "./store/index.ts";
import { CardActions } from "./tasks/card-actions.ts";
import { CleanupService } from "./tasks/cleanup.ts";
import type { LinkOptions } from "./tasks/links.ts";
import { PendingShips } from "./tasks/pending-ship.ts";
import { TaskService } from "./tasks/service.ts";
import { TerminalManager, type TerminalTimers } from "./terminal/manager.ts";
import { openTaskTerminal } from "./terminal/task-terminal.ts";
import { UploadStore } from "./uploads/store.ts";
import { readPrices } from "./usage/prices.ts";
import { UsageRecorder } from "./usage/recorder.ts";
import { UsageRepo } from "./usage/repo.ts";
import { UsageService } from "./usage/service.ts";

/** How often chats are checked for memory. */
const CHAT_SWEEP_MS = 60_000;

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
}

/** Everything the commands, the sockets and the CLI share, wired once. */
export interface Services {
  config: ConfigService;
  runtime: AcpRuntime;
  secrets: SecretStore;
  secretService: SecretService;
  /** Bearer tokens of the majhi-admin MCP server, and the URL agents reach it at. */
  adminTokens: AdminTokens;
  /** The boss's tool calls, approvals and secret requests. */
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
  uploads: UploadStore;
  projects: ProjectService;
  room: RoomService;
  runs: RunManager;
  tasks: TaskService;
  /** Push, open, watch and merge the merge requests of a task (5.5). */
  mrs: MrService;
  gitLogins: GitLoginService;
  /** The buttons on review and paused cards. */
  cardActions: CardActions;
  pendingShips: PendingShips;
  /** Worktrees, merged branches and room logs of tasks done for a while. */
  cleanup: CleanupService;
  mrPoller: MrPoller;
  /** One notification for each thing that needs the owner: a Mac banner and a browser notice. */
  notifier: Notifier;
  /** Background processes agents start through majhi-processes (5.15). */
  processes: ProcessManager;
  /** Previews and service containers majhi runs for agents (PRV-53). */
  containers: ContainerService;
  /** Schedules and the action runner they share with watch triggers (PRV-63). */
  automation: Automation;
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
  // The built-in org used to be `personal`. Old files read as `private` meanwhile, so this can run late.
  void config
    .migrateLegacyOrg()
    .catch((err: unknown) => console.error(`Could not rename the Personal org: ${errorMessage(err)}`));
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
  });
  const store = Store.open(env.majhiHome);
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
  });
  const runner = runnerSetup(env, options.runnerInspect, (task) => containers.taskNetworks(task));
  const sessionOptions = runner.sessionOptions;
  const usageRepo = new UsageRepo(store.raw);
  const usageRecorder = new UsageRecorder({
    repo: usageRepo,
    store,
    prices: () => readPrices(config.file),
    onRecorded: () => events.emit(["usage"]),
  });
  const usageService = new UsageService({ repo: usageRepo, config });
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
  const processes = new ProcessManager({
    spawner: sessionOptions.spawner ?? localSpawner,
    launch: (task, agent) =>
      processLaunch(
        { store, options: sessionOptions, secrets, majhiHome: env.majhiHome, agents: agentStore, config },
        task,
        agent,
      ),
    onChange: (task, list) => {
      room.setProcesses(task, list);
      if (list.some((p) => p.container !== undefined)) events.emit(["containers"]);
    },
    // Bound below, like the run manager's callbacks.
    onEnded: (p, wakes) => void tasks.processEnded(p, wakes).catch(() => undefined),
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
  void containers
    .startup()
    .catch((err: unknown) => console.error(`Could not clean up containers: ${errorMessage(err)}`));
  const runs = new RunManager({
    store,
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
    onTasksChanged: () => events.emit(["tasks"]),
    // Bound below: the task service and the resume coordinator are built after the run manager.
    onIdle: (task) => void tasks.agentsIdle(task).catch(() => undefined),
    beforePrompt: (turn) => tasks.beforePrompt(turn),
    onPaused: (task, reason) => void tasks.pausedByRuns(task, reason).catch(() => undefined),
    onResumed: (task) => void tasks.resumedByRuns(task).catch(() => undefined),
    onTurnEnd: (turn) => coordinator.turnEnded(turn),
    onCheckpoint: (task) => void tasks.restackOnto(task).catch(() => undefined),
    onNetworkError: () => void resilience.networkError().catch(() => undefined),
    ...(options.runClock === undefined ? {} : { now: options.runClock }),
  });
  runs.recover();
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
  const tasks = new TaskService({
    protectedPaths: [env.secretsKeyFile],
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
    // Bound below: the merge requests service is built after the task service.
    onReview: (id) => pendingShips.reviewReached(id),
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
  const notifier = new Notifier({
    subject: (id) => {
      const task = store.tasks.get(id);
      return task === undefined ? undefined : { id: task.id, title: task.title, chat: isOwnerChat(task) };
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
          mac: async (notice) => {
            await options.hostLink?.call("notify", notice);
          },
        }),
  });
  room.onWrite((task, item) => notifier.observe(task, item));
  const updateWatch = setInterval(() => void watchUpdate(env.majhiHome, notifier), UPDATE_WATCH_MS);
  updateWatch.unref();
  const chatSweep = setInterval(() => void chatMemory?.sweep().catch(() => undefined), CHAT_SWEEP_MS);
  chatSweep.unref();
  const promotion = new Promotion({ memory, tasks, projects, config });
  // Once: old pending facts that only repeat the repo docs are rejected (logged, undoable).
  void cleanupRepoDocFacts({ memory, repoDocs, projects: projectList }).catch((err: unknown) =>
    console.error(`Memory cleanup failed: ${errorMessage(err)}`),
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
  const mrs = new MrService({
    gitLogins,
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
  });
  const admin = new AdminService({ config, room, store, secrets, tasks });
  const resilience = new Resilience({
    runs,
    tasks,
    store,
    room,
    config,
    probe: options.probe ?? probeFromSetting(env.netProbe),
    ...(env.netProbeMs === undefined ? {} : { probeMs: env.netProbeMs }),
    runners: runner.runner,
    ...(options.runClock === undefined ? {} : { now: () => (options.runClock?.() ?? new Date()).getTime() }),
  });
  options.hostLink?.onWake(() => void resilience.wake().catch(() => undefined));
  void resilience
    .startup()
    .catch((err: unknown) => console.error(`Could not resume interrupted work: ${errorMessage(err)}`));
  return {
    config,
    runtime,
    secrets,
    secretService: new SecretService(secrets, config),
    adminTokens,
    admin,
    agents,
    agentStore,
    decisions,
    decideTokens,
    roomAccess,
    coordinator,
    store,
    uploads,
    projects,
    room,
    runs,
    tasks,
    mrs,
    gitLogins,
    cardActions: new CardActions({ tasks, mrs, room }),
    pendingShips,
    cleanup: new CleanupService({ store, room, events, projects }),
    notifier,
    mrPoller: new MrPoller(() => mrs.poll(), options.mrPollMs),
    processes,
    containers,
    automation,
    memory,
    extraction,
    promotion,
    memoryScopes,
    resilience,
    usage: usageService,
    usageRecorder,
    runner: runner.runner,
    close: async () => {
      resilience.stop();
      clearInterval(chatSweep);
      clearInterval(updateWatch);
      notifier.close();
      automation.scheduler.stop();
      automation.triggerEngine.stop();
      layaDocker?.close();
      await runs.closeAll();
      await processes.stopAll();
      await usageRecorder.flush();
      await memory.close();
      store.close();
    },
    orgs: new OrgService(config, agentStore, (id, newId) => {
      store.tasks.renameOrg(id, newId);
      events.emit(["tasks"]);
    }),
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
