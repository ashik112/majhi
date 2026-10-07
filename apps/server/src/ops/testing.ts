import { type OwnerDecision, PRIVATE } from "@majhi/shared";
import type Database from "better-sqlite3";
import { vi } from "vitest";
import { FindingsRepo } from "../findings/repo.ts";
import { FindingsService } from "../findings/service.ts";
import type { Notifier } from "../notify/service.ts";
import { Store } from "../store/index.ts";
import type { ConnInfo } from "./anything/checks.ts";
import type { SecretsPort } from "./phone.ts";
import type { ProbePorts } from "./probes.ts";
import { createOps, type Ops, type OpsWiring } from "./wire.ts";

/** A world for the ops watch: in-memory database, a clock, fake network, fake ntfy, recorded alerts. */

export const T0 = new Date("2026-10-04T10:00:00.000Z");
export const MIN = 60_000;

export class MemorySecrets implements SecretsPort {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | undefined> {
    return this.values.get(name);
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

export interface Net {
  /** Answers per address, consumed in order; the last one repeats. A function decides per call. */
  answers: Map<string, (() => Response | Promise<Response> | never)[]>;
  calls: string[];
  online: boolean;
  cert: { validTo: Date; authorized: boolean } | Error;
  dns: string[] | Error;
  monitor: ProbePorts["monitor"] | undefined;
}

export function up(status = 200, body = "ok"): () => Response {
  return () => new Response(body, { status });
}

export function down(): () => never {
  return () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
    });
  };
}

export interface OpsWorld {
  ops: Ops;
  db: Database.Database;
  findings: FindingsService;
  secrets: MemorySecrets;
  clock: { at: Date };
  advance(ms: number): void;
  net: Net;
  /** Alerts the notifier was asked for. */
  alerts: { id: number; severity: string; text: string; repeat: boolean }[];
  /** News sent to a workspace's captain lane. */
  wakes: { org: string; text: string }[];
  /** The incident task the engine would open: each call, with whether it was a re-fire. */
  tasks: { incident: number; again: boolean }[];
  /** Requests the ntfy server got. */
  ntfy: { url: string; body: Record<string, unknown> }[];
  ntfyDown: boolean;
  decisions: OwnerDecision[];
  answered: { id: string; option: string }[];
  quiet: boolean;
  drafts: { finding?: number; channel: string }[];
  /** Connections the watches read through, by id. */
  conns: Map<string, ConnInfo>;
  /** What the databases, Redis and servers behind the watches say, and what they were asked. */
  backend: {
    sql: { engine: string; query: string }[];
    redis: string[][];
    ssh: string[];
    sqlAnswer: (query: string) => string | Error;
    redisAnswer: (command: string[]) => string;
    sshAnswer: (command: string) => { code: number; output: string };
  };
  /** Rechecks a fix scheduled, to run by hand. */
  rechecks: (() => Promise<void>)[];
  /** Same database, a fresh service: a restart. */
  restart(): OpsWorld;
}

export function opsWorld(
  over: {
    db?: Database.Database;
    clock?: { at: Date };
    keep?: Partial<OpsWorld>;
    /** Extra wiring, like the action runner of a watch. */
    wiring?: Partial<OpsWiring>;
  } = {},
): OpsWorld {
  const db = over.db ?? new Store(":memory:").raw;
  const clock = over.clock ?? { at: new Date(T0) };
  const secrets = over.keep?.secrets ?? new MemorySecrets();
  const net: Net = over.keep?.net ?? {
    answers: new Map(),
    calls: [],
    online: true,
    cert: { validTo: new Date(T0.getTime() + 90 * 86_400_000), authorized: true },
    dns: ["203.0.113.7"],
    monitor: undefined,
  };
  const world: OpsWorld = {
    db,
    clock,
    secrets,
    net,
    alerts: over.keep?.alerts ?? [],
    wakes: over.keep?.wakes ?? [],
    tasks: over.keep?.tasks ?? [],
    ntfy: over.keep?.ntfy ?? [],
    ntfyDown: over.keep?.ntfyDown ?? false,
    decisions: over.keep?.decisions ?? [],
    answered: over.keep?.answered ?? [],
    quiet: false,
    conns: over.keep?.conns ?? new Map(),
    backend: over.keep?.backend ?? {
      sql: [],
      redis: [],
      ssh: [],
      sqlAnswer: () => "0",
      redisAnswer: () => "0",
      sshAnswer: () => ({ code: 0, output: "" }),
    },
    rechecks: over.keep?.rechecks ?? [],
    drafts: over.keep?.drafts ?? [],
    advance: (ms) => {
      clock.at = new Date(clock.at.getTime() + ms);
    },
    findings: undefined as unknown as FindingsService,
    ops: undefined as unknown as Ops,
    restart: () => opsWorld({ db, clock, keep: world }),
  };
  const findings = new FindingsService({
    repo: new FindingsRepo(db),
    now: () => clock.at,
    projectOrg: async (id) => (id === "acme-api" ? "acme" : undefined),
    taskStatus: () => undefined,
    createTask: async () => ({ id: "ACM-1" }),
  });
  world.findings = findings;
  const fetchFake: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    net.calls.push(url);
    const list = net.answers.get(url);
    if (list === undefined || list.length === 0)
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const next =
      list.length > 1
        ? (list.shift() as () => Response | Promise<Response>)
        : (list[0] as () => Response | Promise<Response>);
    return next();
  };
  const wiring: OpsWiring = {
    db,
    findings,
    secrets,
    notifier: {
      incident: vi.fn(async (n: { id: number; severity: string; text: string; repeat: boolean }) => {
        world.alerts.push({ id: n.id, severity: n.severity, text: n.text, repeat: n.repeat });
      }),
    } as unknown as Notifier,
    wake: (org, text) => world.wakes.push({ org, text }),
    incidentTask: async (inc, _subject, _evidence, again) => {
      world.tasks.push({ incident: inc.id, again });
      return { task: "ACM-1", started: false, readOnly: false };
    },
    orgName: async (org) => (org === PRIVATE ? "Private" : org === "acme" ? "Acme" : org),
    projectOrg: async (id) => (id === "acme-api" ? "acme" : undefined),
    connections: {
      list: async (org) => [
        ...(org === "acme" ? [{ id: "bf-acme", name: "Better Stack", type: "mcp" }] : []),
        ...[...world.conns]
          .filter(([, c]) => c.org === org)
          .map(([id, c]) => ({ id, name: c.name, type: c.type })),
      ],
      orgOf: async (id) => (id === "bf-acme" ? "acme" : world.conns.get(id)?.org),
    },
    tester: { callRemoteTool: async () => ({}), valuesForWatch: async (id) => world.conns.get(id) },
    watchPorts: {
      sql: async (engine, _url, query) => {
        world.backend.sql.push({ engine, query });
        const a = world.backend.sqlAnswer(query);
        if (a instanceof Error) throw a;
        return a;
      },
      redis: async (_url, commands) => {
        for (const c of commands) world.backend.redis.push([...c]);
        return commands.map((c) => world.backend.redisAnswer([...c]));
      },
      ssh: async (_alias, command) => {
        world.backend.ssh.push(command);
        return world.backend.sshAnswer(command);
      },
    },
    scheduleRecheck: (run) => world.rechecks.push(run),
    inbox: {
      list: async () => world.decisions,
      answer: async (input) => {
        world.answered.push(input);
        world.decisions = world.decisions.filter((d) => d.id !== input.id);
      },
    },
    drafts: () =>
      world.drafts.map(
        (d, i) =>
          ({
            id: i + 1,
            org: "acme",
            target: "x",
            body: "x",
            status: "pending",
            mode: "draft",
            by: "captain",
            createdAt: "",
            ...d,
          }) as never,
      ),
    notifications: async () => ({
      mac: true,
      browser: true,
      sound: false,
      muted: [],
      ...(world.quiet ? { quiet_from: "00:00", quiet_to: "23:59", quiet_tz: "UTC" } : {}),
    }),
    online: async () => net.online,
    changed: () => undefined,
    now: () => clock.at,
    probes: {
      fetch: fetchFake,
      tls: async () => {
        if (net.cert instanceof Error) throw net.cert;
        return net.cert;
      },
      lookup: async () => {
        if (net.dns instanceof Error) throw net.dns;
        return net.dns;
      },
      ...(net.monitor === undefined ? {} : { monitor: net.monitor }),
    },
    ntfyFetch: (async (_url: string, init?: RequestInit) => {
      if (world.ntfyDown) throw new Error("ntfy is down");
      world.ntfy.push({
        url: String(_url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    retryMs: 0,
    sleep: async () => undefined,
  };
  world.ops = createOps({
    ...wiring,
    ...over.wiring,
    watchPorts: { ...wiring.watchPorts, ...over.wiring?.watchPorts },
  });
  return world;
}

export const SERVICE = {
  org: "acme",
  name: "Acme API",
  url: "https://api.acme.example/health",
  tls: false,
  dns: false,
  impact: "high" as const,
};

export function answers(
  world: OpsWorld,
  url: string,
  ...list: (() => Response | Promise<Response> | never)[]
): void {
  world.net.answers.set(url, list);
}
