import type {
  AutomationAction,
  AutomationRun,
  Draft,
  NotificationsSettings,
  OwnerDecision,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import type { ConnectionTester } from "../connections/tester.ts";
import { errorMessage } from "../errors.ts";
import type { FindingsService } from "../findings/service.ts";
import { inQuietHours } from "../notify/attention.ts";
import type { Notifier } from "../notify/service.ts";
import { type ConnInfo, Unavailable, type WatchPorts } from "./anything/checks.ts";
import { WatchEngine } from "./anything/engine.ts";
import type { WatchHost } from "./anything/host.ts";
import type { Core } from "./anything/plan.ts";
import { pathPrint } from "./anything/probe.ts";
import { realWatchPorts } from "./anything/real-ports.ts";
import { WatchRepo } from "./anything/repo.ts";
import { PhoneChannel, SECRET_KEY, type SecretsPort } from "./phone.ts";
import { numberAt, type ProbePorts, systemPorts } from "./probes.ts";
import { OpsRepo } from "./repo.ts";
import { PhoneTokens } from "./tokens.ts";
import { type OpsDeps, OpsWatch } from "./watch.ts";

/** The pieces the ops watch needs from the rest of majhi, as small ports. */
export interface OpsWiring {
  db: Database.Database;
  findings: FindingsService;
  secrets: SecretsPort;
  notifier: Notifier;
  /** News for a workspace's captain lane. */
  wake: (org: string, text: string) => void;
  /** The owner switched an outcome rule off in a workspace. */
  ruleOff?: ((org: string, rule: string) => boolean) | undefined;
  orgName: (org: string) => Promise<string>;
  projectOrg: (project: string) => Promise<string | undefined>;
  /** The workspace and checkout folder of a project, for the file and folder watches. */
  projectCheckout?: ((project: string) => Promise<{ org: string; path: string } | undefined>) | undefined;
  /** What the task, process, usage, branch and command watches look at. */
  host?: WatchHost | undefined;
  /** Runs a database client image for the `image` database checks. Absent without Docker. */
  imageRun?: WatchPorts["image"] | undefined;
  /** Runs a script watch's script in a throwaway runner container. Absent without Docker. */
  scriptRun?: WatchPorts["script"] | undefined;
  /** What a watch's action does when it fires (the schedules' action runner). */
  action?: {
    validate(org: string, action: AutomationAction): Promise<void>;
    run(
      source: { kind: "watch"; id: string; org: string; name: string },
      action: AutomationAction,
      overlap: "skip" | "allow",
    ): Promise<AutomationRun>;
    runs(id: string, limit: number): AutomationRun[];
    forget(id: string): void;
  };
  connections: {
    /** The workspace's connections: id, name, type. */
    list: (org: string) => Promise<{ id: string; name: string; type: string }[]>;
    /** The workspace a connection belongs to. */
    orgOf: (id: string) => Promise<string | undefined>;
  };
  tester: Pick<ConnectionTester, "callRemoteTool"> & Partial<Pick<ConnectionTester, "valuesForWatch">>;
  /** The smallest model for turning a sentence into a watch. Absent: the rules read it. */
  askModel?: (
    task: { id: string; org: string },
    prompt: string,
    parse: (reply: string) => { ok: true; value: Core } | { ok: false; problem: string },
  ) => Promise<Core | undefined>;
  /** For tests: the databases, Redis and servers behind the watches. */
  watchPorts?: Partial<WatchPorts>;
  orgs?: () => Promise<{ id: string; name: string }[]>;
  scheduleRecheck?: (run: () => Promise<void>, ms: number) => void;
  inbox: {
    list(): Promise<OwnerDecision[]>;
    answer(input: { id: string; option: string }): Promise<unknown>;
  };
  drafts: (org: string) => Draft[];
  notifications: () => Promise<NotificationsSettings>;
  /** False when this machine has no network. */
  online: () => Promise<boolean>;
  /** An incident opened or fired again: the incident engine's task for it (see `OpsDeps.incidentTask`). */
  incidentTask?: OpsDeps["incidentTask"];
  changed: () => void;
  now?: () => Date;
  /** For tests: the network behind the checks, the ntfy server, and the wait between two looks. */
  probes?: Partial<ProbePorts>;
  ntfyFetch?: typeof fetch;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Ops {
  watch: OpsWatch;
  engine: WatchEngine;
  phone: PhoneChannel;
  repo: OpsRepo;
  tokens: PhoneTokens;
  /** Starts the half-minute tick. */
  start(): void;
  close(): void;
}

export const TICK_MS = 30_000;

export function createOps(w: OpsWiring): Ops {
  const repo = new OpsRepo(w.db);
  const now = w.now ?? (() => new Date());
  const tokens = new PhoneTokens(
    repo,
    async () => {
      const key = await w.secrets.get(SECRET_KEY);
      return key === undefined ? undefined : Buffer.from(key, "base64");
    },
    now,
  );
  const phone = new PhoneChannel({
    repo,
    secrets: w.secrets,
    tokens,
    fetch: w.ntfyFetch ?? fetch,
    now,
    orgName: async (org) => (org === undefined ? "majhi" : w.orgName(org)),
    inQuiet: async () => {
      const n = await w.notifications();
      return inQuietHours(now().getTime(), { from: n.quiet_from, to: n.quiet_to, tz: n.quiet_tz });
    },
    decisions: w.inbox,
    // The watch is built below; an acknowledgement only comes from a later request.
    ack: (id) => watch.ack(id),
    changed: w.changed,
  });
  const ports: ProbePorts = {
    ...systemPorts({
      fetch: w.probes?.fetch ?? fetch,
      now,
      monitor: async (org, m) => {
        if ((await w.connections.orgOf(m.connection)) !== org) {
          return { state: "unavailable", why: "the connection is not in this workspace" };
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(m.args) as Record<string, unknown>;
        } catch {
          return { state: "unavailable", why: "the arguments are not JSON" };
        }
        try {
          const answer = await w.tester.callRemoteTool(m.connection, m.tool, args);
          const value = numberAt(answer, m.path);
          return value === undefined
            ? { state: "unavailable", why: "no number at that path" }
            : { state: "ok", value };
        } catch {
          return { state: "unavailable", why: "the connection did not answer" };
        }
      },
    }),
    ...w.probes,
  };
  let engine: WatchEngine | undefined;
  const watch: OpsWatch = new OpsWatch({
    repo,
    findings: w.findings,
    ports,
    phone,
    notify: async (n) => {
      if (n.severity === "low") return;
      await w.notifier.incident({ id: n.id, text: n.text, severity: n.severity, repeat: n.repeat });
    },
    wake: w.wake,
    ...(w.ruleOff === undefined ? {} : { ruleOff: w.ruleOff }),
    orgName: w.orgName,
    projectOrg: w.projectOrg,
    connections: async (org) =>
      (await w.connections.list(org)).filter((c) => c.type === "mcp").map((c) => c.name),
    actionLines: async (finding) => {
      const f = w.findings.get(finding);
      const lines: string[] = [];
      if (f.task !== undefined) {
        lines.push(`${f.status === "proposed" ? "Fix task proposed" : "Fix task started"}: ${f.task}`);
      }
      for (const d of w.drafts(f.org)) {
        if (d.finding === finding) lines.push(`Status update drafted for ${d.channel}`);
      }
      return lines;
    },
    online: w.online,
    ...(w.sleep === undefined ? {} : { sleep: w.sleep }),
    ...(w.retryMs === undefined ? {} : { retryMs: w.retryMs }),
    now,
    changed: w.changed,
    ...(w.incidentTask === undefined ? {} : { incidentTask: w.incidentTask }),
    onAcked: (inc) => engine?.onAcked(inc),
    onResolved: (inc) => engine?.onResolved(inc),
    question: (inc) => engine?.question(inc),
  });
  const watchPorts: WatchPorts = {
    ...realWatchPorts({
      fetch: ports.fetch,
      lookup: ports.lookup,
      now,
      connection: async (id): Promise<ConnInfo | undefined> => w.tester.valuesForWatch?.(id),
      monitor: (id, tool, args) => w.tester.callRemoteTool(id, tool, args),
      checkout: async (org, project) => {
        const found = await w.projectCheckout?.(project);
        if (found === undefined) throw new Unavailable("the project is gone");
        if (found.org !== org) throw new Unavailable("the project belongs to another workspace");
        return found.path;
      },
      ...(w.host === undefined ? {} : { host: w.host }),
      pathPrint: async (org, project, path) => {
        const found = await w.projectCheckout?.(project);
        if (found === undefined) throw new Unavailable("the project is gone");
        if (found.org !== org) throw new Unavailable("the project belongs to another workspace");
        try {
          return await pathPrint(found.path, path);
        } catch (err) {
          // A path that leaves the checkout is refused with a fixed phrase; the rest is a read error.
          throw new Unavailable(
            /outside the project|leads outside/.test(errorMessage(err))
              ? "the path leaves the project"
              : "the path could not be read",
          );
        }
      },
    }),
    ...(w.imageRun === undefined ? {} : { image: w.imageRun }),
    ...(w.scriptRun === undefined ? {} : { script: w.scriptRun }),
    ...w.watchPorts,
  };
  const watchRepo = new WatchRepo(w.db);
  engine = new WatchEngine({
    repo: watchRepo,
    ops: watch,
    ports: watchPorts,
    connections: async (org) =>
      (await w.connections.list(org)).map((c) => ({ id: c.id, name: c.name, type: c.type })),
    projectOrg: w.projectOrg,
    orgName: w.orgName,
    orgs: w.orgs ?? (async () => []),
    wake: w.wake,
    ...(w.askModel === undefined ? {} : { ask: w.askModel }),
    tell: async (_org, incident, text) => {
      await w.notifier.incident({ id: -incident, text, severity: "medium", repeat: true });
    },
    changed: w.changed,
    now,
    ...(w.scheduleRecheck === undefined ? {} : { schedule: w.scheduleRecheck }),
    ...(w.action === undefined ? {} : { action: w.action }),
  });
  const looks = engine;
  let timer: NodeJS.Timeout | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  return {
    watch,
    engine: looks,
    phone,
    repo,
    tokens,
    start() {
      timer ??= setInterval(() => void watch.tick().catch(() => undefined), TICK_MS);
      timer.unref();
      watchTimer ??= setInterval(() => void looks.tick().catch(() => undefined), 60_000);
      watchTimer.unref();
    },
    close() {
      clearInterval(timer);
      clearInterval(watchTimer);
      timer = undefined;
      watchTimer = undefined;
    },
  };
}
