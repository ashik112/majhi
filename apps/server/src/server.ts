import { totalmem } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { WAITING_TEXT } from "./admin/service.ts";
import { destinationOf } from "./backup/state.ts";
import { createDispatcher } from "./commands/dispatch.ts";
import { createHandlers, requestRemount } from "./commands/handlers.ts";
import type { ServerEnv } from "./env.ts";
import { UserError } from "./errors.ts";
import { topicsFor } from "./events/hub.ts";
import { HealthService } from "./health/service.ts";
import { HostLink } from "./host/link.ts";
import { createApp } from "./http/app.ts";
import { eventLoopLag, LIMITS, SelfChecks, startSelfWatch } from "./ops/self.ts";
import { RepoScanner } from "./scan/scanner.ts";
import { createServices, type ServiceOptions, type Services } from "./services.ts";
import { attachSockets, type UpgradeSource } from "./sockets.ts";
import { SshHostProbe, sshTargets } from "./ssh/hosts.ts";
import { DB_FILE_NAME } from "./store/index.ts";
import { SystemService } from "./system/service.ts";

/** Unused uploads are looked for this often. */
const UPLOAD_SWEEP_MS = 60 * 60 * 1000;

export interface MajhiAppOptions extends ServiceOptions {
  /** Passed in by `main.ts` so shutdown can end the helper's poll, and by tests to shorten timeouts. */
  hostLink?: HostLink;
}

export interface Majhi {
  app: Hono;
  services: Services;
  /** Starts the file watcher and serves the WebSocket channels on `server`. */
  attach(server: UpgradeSource): void;
  /** Kills login terminals, stops the watcher and sockets, ends every agent process and closes the database. */
  close(): Promise<void>;
}

/** Loading keys runs ssh-add a few times on the host; allow for a slow Keychain or keyring. */
const SSH_RELOAD_TIMEOUT_MS = 40_000;

/** Wires the config, accounts, agents, live channels, the host helper link and the commands together. */
export function createMajhi(env: ServerEnv, options: MajhiAppOptions = {}): Majhi {
  const hostLink = options.hostLink ?? new HostLink();
  const services = createServices(env, {
    ...options,
    hostLink,
    reloadKeys: async () => {
      if (!hostLink.status().connected) return false;
      hostLink.noteSsh(await hostLink.call("ssh.reload", {}, SSH_RELOAD_TIMEOUT_MS));
      return true;
    },
  });
  const config = services.config;
  const sshHosts = new SshHostProbe(async () => sshTargets((await config.load()).projectPaths));
  const health = new HealthService({
    env,
    services,
    config,
    hostLink,
    sshHosts,
    remount: (unmounted) => requestRemount(hostLink, unmounted),
    // `system` is made below; the fix only runs later, from a request.
    rebuild: () => system.update("idle"),
  });
  const system = new SystemService({
    hostLink,
    commit: env.commit,
    majhiHome: env.majhiHome,
    working: () => services.runs.turnsInFlight(),
    beforeUpdate: () => services.backup.before("before-update"),
  });
  // An "Update when they finish" from before a restart goes on waiting.
  void system.restore().catch(() => undefined);
  const dispatch = createDispatcher(
    createHandlers({
      config,
      scanner: new RepoScanner(),
      hostLink,
      services,
      sshHosts,
      health,
      ...(services.e2e === undefined ? {} : { e2e: services.e2e }),
      system,
    }),
    (name) => services.events.emit(topicsFor(name)),
  );
  services.admin.bind(dispatch);
  services.bindCaptain(dispatch);
  const app = createApp({
    version: env.version,
    commit: env.commit,
    webDist: env.webDist,
    dispatch,
    host: { link: hostLink, majhiHome: env.majhiHome },
    uploads: services.uploads,
    phone: services.ops.phone,
    connect: services.connect,
    taskFiles: {
      folderOf: (id) => services.store.tasks.get(id)?.folder,
      reposOf: (id) => services.store.tasks.get(id)?.repos,
    },
    mcp: { tokens: services.adminTokens, admin: services.admin },
    decideMcp: { tokens: services.decideTokens, decisions: services.decisions },
    roomMcp: {
      tasks: services.tasks,
      access: services.roomAccess,
      coordinator: services.coordinator,
      admin: services.admin,
      config,
      room: services.room,
      store: services.store,
      agents: services.agentStore,
      projects: services.projects,
      processes: services.processes,
      ...(services.containers.available()
        ? {
            containers: {
              containers: services.containers,
              askImage: async (caller: { task: string; agent: string }, image: string) => {
                const result = await services.admin.request(
                  caller,
                  "containers.images.allow",
                  { image },
                  `A service container needs the image ${image}.`,
                );
                if (result.isError) throw new UserError(result.text);
                return result.text === WAITING_TEXT ? ("pending" as const) : ("allowed" as const);
              },
            },
          }
        : {}),
      memory: {
        memory: services.memory,
        scopeOf: (task) => services.memoryScopes.agent(task),
        receipts: services.store.usageEvents,
      },
      connections: {
        runs: services.runs,
        config,
        store: services.store,
        room: services.room,
        agents: services.agentStore,
        refreshBriefs: (task) => services.tasks.refreshBriefs([task]),
        hostHome: config.paths.hostHome,
        ...(options.connectionsRemote === undefined ? {} : { remote: options.connectionsRemote }),
      },
    },
    ...(services.runner === undefined
      ? {}
      : { isRunner: (address: string | undefined) => services.runner?.network.isRunner(address) ?? false }),
  });
  // majhi watches itself: Health's checks and a few measurements of its own become incidents in Private.
  const selfChecks = new SelfChecks({
    health: async () =>
      (await health.checks()).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        detail: c.detail,
        fix: c.fix,
      })),
    disks: async () => [
      { label: "majhi data", path: env.majhiHome },
      { label: "backups", path: (await destinationOf(env.majhiHome)).path },
    ],
    dbPath: () => join(env.majhiHome, DB_FILE_NAME),
    trees: async () => {
      const loaded = await config.load();
      return [
        ...(loaded.state.status === "loaded"
          ? [
              {
                id: "self-tasks-size",
                label: "Task worktrees",
                path: loaded.state.config.tasksDir,
                failBytes: LIMITS.worktreesFailBytes,
              },
            ]
          : []),
        {
          id: "self-e2e-size",
          label: "e2e traces",
          path: join(env.majhiHome, "e2e"),
          failBytes: LIMITS.e2eFailBytes,
        },
      ];
    },
    queueStall: () => services.autonomy.queueStall(),
    laya: async () => {
      const laya = hostLink.status().info?.laya;
      return laya === undefined ? undefined : { state: laya.state, detail: laya.detail ?? "Laya" };
    },
    lagMs: eventLoopLag(),
    memory: () => ({ rss: process.memoryUsage.rss(), total: totalmem() }),
    recall: {
      get: (key) => services.ops.repo.setting(key),
      set: (key, value) => services.ops.repo.setSetting(key, value),
    },
    now: () => new Date(),
  });
  let stopSelfWatch: (() => void) | undefined;
  let sockets: { close: () => void } | undefined;
  let sweeper: NodeJS.Timeout | undefined;
  return {
    app,
    services,
    attach(server) {
      services.watcher.start();
      services.usageSweeper.start();
      services.mrPoller.start();
      services.trackers.start();
      services.e2e?.start();
      services.cards.start();
      services.resilience.start();
      services.automation.scheduler.start();
      services.automation.triggerEngine.start();
      services.autonomy.startSweep();
      services.captain.startSweep();
      stopSelfWatch = startSelfWatch(services.ops.watch, selfChecks);
      sockets = attachSockets(server, {
        events: services.events,
        terminals: services.terminals,
        rooms: {
          snapshot: (id) => services.tasks.snapshot(id),
          subscribe: (id, fn) => services.room.subscribe(id, fn),
        },
      });
      void services.uploads.sweep().catch(() => undefined);
      sweeper = setInterval(() => void services.uploads.sweep().catch(() => undefined), UPLOAD_SWEEP_MS);
      sweeper.unref();
    },
    close() {
      services.watcher.stop();
      services.usageSweeper.stop();
      services.mrPoller.stop();
      system.close();
      services.terminals.closeAll();
      stopSelfWatch?.();
      sockets?.close();
      if (sweeper !== undefined) clearInterval(sweeper);
      return services.close().catch(() => undefined);
    },
  };
}

/** The HTTP app alone, for tests that do not need sockets. */
export function createMajhiApp(env: ServerEnv, options: MajhiAppOptions = {}): Hono {
  return createMajhi(env, options).app;
}
