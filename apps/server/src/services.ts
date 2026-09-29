import { join } from "node:path";
import { AccountCache } from "./accounts/cache.ts";
import { AccountProbes } from "./accounts/health.ts";
import { startLogin } from "./accounts/login.ts";
import { AccountService } from "./accounts/service.ts";
import { AccountUsageReader, UsageSweeper } from "./accounts/usage.ts";
import { AdminAccess } from "./admin/access.ts";
import { AdminService } from "./admin/service.ts";
import { AdminTokens } from "./admin/tokens.ts";
import { AgentService } from "./agents/service.ts";
import { AgentStore } from "./agents/store.ts";
import { ConfigService } from "./config/service.ts";
import { AcpProvider } from "./decisions/acp.ts";
import { LayaProvider } from "./decisions/layaProvider.ts";
import { DecisionLog } from "./decisions/log.ts";
import { rulesProvider } from "./decisions/rules.ts";
import { DecisionService } from "./decisions/service.ts";
import { DecideTokens } from "./decisions/tokens.ts";
import type { ServerEnv } from "./env.ts";
import { errorMessage } from "./errors.ts";
import { EventHub } from "./events/hub.ts";
import { HomeWatcher } from "./events/watcher.ts";
import type { HostLink } from "./host/link.ts";
import { OrgService } from "./orgs/service.ts";
import { ProjectService } from "./projects/service.ts";
import { RoomService } from "./room/service.ts";
import type { Inspect } from "./runner/network.ts";
import { type Runner, runnerSetup } from "./runner/setup.ts";
import { RunManager } from "./runs/manager.ts";
import { type Probe, probeFromSetting } from "./runs/network.ts";
import { Resilience } from "./runs/resilience.ts";
import { type AcpRuntime, realRuntime } from "./runtime.ts";
import { SecretService } from "./secrets/service.ts";
import { SecretStore } from "./secrets/store.ts";
import { Store } from "./store/index.ts";
import type { LinkOptions } from "./tasks/links.ts";
import { TaskService } from "./tasks/service.ts";
import { TerminalManager, type TerminalTimers } from "./terminal/manager.ts";
import { UploadStore } from "./uploads/store.ts";
import { readPrices } from "./usage/prices.ts";
import { UsageRecorder } from "./usage/recorder.ts";
import { UsageRepo } from "./usage/repo.ts";
import { UsageService } from "./usage/service.ts";

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
  /** Replaces `docker network inspect` for the runner network. */
  runnerInspect?: Inspect;
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
  const runner = runnerSetup(env, options.runnerInspect);
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
  const decideTokens = new DecideTokens();
  const decisions = new DecisionService({
    config,
    log: new DecisionLog(store.raw),
    tokens: decideTokens,
    laya: new LayaProvider(options.hostLink),
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
  const runs = new RunManager({
    store,
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
    onPaused: (task, reason) => void tasks.pausedByRuns(task, reason).catch(() => undefined),
    onResumed: (task) => void tasks.resumedByRuns(task).catch(() => undefined),
    onNetworkError: () => void resilience.networkError().catch(() => undefined),
  });
  runs.recover();
  const uploads = new UploadStore(env.majhiHome);
  const projects = new ProjectService(config, store.tasks);
  const tasks = new TaskService({
    store,
    config,
    projects,
    agents: agentStore,
    accounts,
    uploads,
    runs,
    room,
    events,
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.reloadKeys === undefined ? {} : { reloadKeys: options.reloadKeys }),
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
    store,
    uploads,
    projects,
    room,
    runs,
    tasks,
    resilience,
    usage: usageService,
    usageRecorder,
    runner: runner.runner,
    close: async () => {
      resilience.stop();
      await runs.closeAll();
      await usageRecorder.flush();
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
