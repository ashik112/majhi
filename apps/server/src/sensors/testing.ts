import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Finding, PlaybookSchema } from "@majhi/shared";
import { FindingsRepo } from "../findings/repo.ts";
import { FindingsService } from "../findings/service.ts";
import { ENGINEERING_PLAYBOOKS } from "../playbooks/builtin/engineering.ts";
import type { RulesContext } from "../playbooks/rules.ts";
import { Store } from "../store/index.ts";
import { SensorCache } from "./cache.ts";
import { Net } from "./net.ts";
import type { SensorPorts, SensorProject, TokenResult } from "./ports.ts";

/** Test pieces for the sensors: a local HTTP server standing in for every upstream, and in-memory ports. */

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** The public hosts, mapped onto one local server by path prefix. */
const PREFIX: Record<string, string> = {
  "api.osv.dev": "/osv",
  "endoflife.date": "/eol",
  "api.github.com": "/gh",
  "registry.npmjs.org": "/npm",
  "gitlab.acme.example": "/gl",
};

export class FakeUpstream {
  readonly seen: Seen[] = [];
  private server: Server | undefined;
  port = 0;
  handler: (req: Seen) => Reply | Promise<Reply> = () => ({ status: 404 });

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const seen: Seen = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.seen.push(seen);
        void Promise.resolve(this.handler(seen)).then((r) => {
          res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers });
          res.end(r.status === 304 || r.body === undefined ? "" : JSON.stringify(r.body));
        });
      });
    });
    const server = this.server;
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((ok) => (this.server === undefined ? ok() : this.server.close(() => ok())));
  }

  /** Requests whose path starts with a prefix like `/osv`. */
  to(prefix: string): Seen[] {
    return this.seen.filter((s) => s.path.startsWith(prefix));
  }

  /** A `Net` whose public hosts all land on this server. Hosts not in the map are never reached. */
  net(extra: { allow?: string[] } = {}): Net {
    const base = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const prefix = PREFIX[u.host];
      if (prefix === undefined) throw new Error(`the test network has no route for ${u.host}`);
      return fetch(`http://127.0.0.1:${this.port}${prefix}${u.pathname}${u.search}`, init);
    }) as typeof fetch;
    return new Net({
      base,
      sleep: async () => undefined,
      ...(extra.allow === undefined ? {} : { allow: extra.allow }),
    });
  }
}

export const T0 = new Date("2026-10-04T08:00:00.000Z");

export function findingsOf(db = new Store(":memory:")) {
  const findings = new FindingsService({
    repo: new FindingsRepo(db.raw),
    now: () => clock.at,
    projectOrg: async (id) =>
      id.startsWith("acme") ? "acme" : id.startsWith("globex") ? "globex" : undefined,
    taskStatus: () => undefined,
    createTask: async () => ({ id: "ACM-1" }),
  });
  const clock = { at: new Date(T0) };
  return { db, findings, clock };
}

export interface Fixture {
  project: Omit<SensorProject, "path"> & { path?: string };
  /** Tracked files by path. */
  files: Record<string, string>;
}

export function makePorts(opts: {
  net: Net;
  fixtures: Fixture[];
  db?: Store;
  clock?: { at: Date };
  token?: TokenResult<unknown>;
  taskBranches?: Record<string, string[]>;
  summarize?: SensorPorts["summarize"];
  logs?: string[];
}): { ports: SensorPorts; cache: SensorCache } {
  const db = opts.db ?? new Store(":memory:");
  const cache = new SensorCache(db.raw);
  const clock = opts.clock ?? { at: new Date(T0) };
  const byPath = new Map(opts.fixtures.map((f) => [f.project.path ?? `/repo/${f.project.id}`, f]));
  const ports: SensorPorts = {
    net: opts.net,
    cache,
    now: () => clock.at,
    log: (m) => opts.logs?.push(m),
    projects: async (org) =>
      opts.fixtures
        .filter((f) => f.project.org === org)
        .map((f) => ({ ...f.project, path: f.project.path ?? `/repo/${f.project.id}` })),
    tracked: async (path) => Object.keys(byPath.get(path)?.files ?? {}),
    read: async (path, rel, max) => {
      const text = byPath.get(path)?.files[rel];
      return text === undefined || text.length > max ? undefined : text;
    },
    fingerprint: async (path) =>
      JSON.stringify(byPath.get(path)?.files ?? {}).length.toString() +
      Object.keys(byPath.get(path)?.files ?? {}).join(),
    taskBranches: async (_org, project) => opts.taskBranches?.[project] ?? [],
    withToken: async (_org, _kind, _host, use) => {
      const t = opts.token ?? { state: "ok" as const, value: undefined };
      if (t.state !== "ok") return t;
      return { state: "ok", value: await use("test-token-value") };
    },
    ...(opts.summarize === undefined ? {} : { summarize: opts.summarize }),
  };
  return { ports, cache };
}

export const playbookOf = (id: string) => {
  const def = ENGINEERING_PLAYBOOKS.find((p) => p.id === id);
  if (def === undefined) throw new Error(`no playbook ${id}`);
  return PlaybookSchema.parse(def);
};

export function ctxOf(
  id: string,
  findings: FindingsService,
  clock: { at: Date },
  org = "acme",
): RulesContext {
  return {
    org,
    playbook: playbookOf(id),
    settings: {},
    findings,
    now: () => clock.at,
    fetch: (async () => {
      throw new Error("sensors use their own network");
    }) as typeof fetch,
  };
}

export const live = (f: FindingsService, org = "acme"): Finding[] =>
  f.list({ org, limit: 500 }, { kind: "owner" }).findings;

export const GITHUB_PROJECT: SensorProject = {
  id: "acme-api",
  org: "acme",
  path: "/repo/acme-api",
  base: "main",
  remote: { kind: "github", host: "github.com", slug: "acme/api" },
  stack: [],
};
