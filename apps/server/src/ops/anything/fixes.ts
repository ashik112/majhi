import type { WatchDef, WatchFire, WatchFixId, WatchFixView, WatchSort } from "@majhi/shared";
import { runAllowed, Unavailable, type WatchPorts } from "./checks.ts";

/**
 * What a watch may do when it fires (SPEC 5.18). Every fix is one of a fixed list. majhi's own code runs
 * only the fixed statements and commands below (each checked again at the port); the rest are done by
 * the captain after the owner's yes, through the connections it already has. Nothing here drops,
 * deletes or truncates data: the one deletion is old `.log` files in a folder under /var/log that the
 * owner names.
 */

export interface FixConnection {
  id: string;
  name: string;
  type: string;
}

export interface FixContext {
  /** The workspace's connections. */
  connections: readonly FixConnection[];
}

interface FixMeta {
  label: string;
  /** Short, for a button: "kill queries". */
  short: string;
  kinds: readonly WatchSort[];
  /** code: majhi runs it. captain: the captain does it once approved, and a task ships by the Merge rule. */
  by: "code" | "captain";
}

export const FIX_META: Record<WatchFixId, FixMeta> = {
  kill_queries: {
    label: "Kill queries running over {sec} s",
    short: "kill queries",
    kinds: ["database"],
    by: "code",
  },
  index_task: {
    label: "Add the missing index",
    short: "start the index task",
    kinds: ["database"],
    by: "captain",
  },
  scale_db: { label: "Scale the database", short: "scale the database", kinds: ["database"], by: "captain" },
  rollback: {
    label: "Roll back the last deploy",
    short: "roll back",
    kinds: ["website", "metric"],
    by: "captain",
  },
  restart_service: {
    label: "Restart the service",
    short: "restart the service",
    kinds: ["server"],
    by: "code",
  },
  clear_logs: { label: "Clear old logs", short: "clear old logs", kinds: ["server"], by: "code" },
  scale_workers: { label: "Scale the workers", short: "scale the workers", kinds: ["queue"], by: "captain" },
};

const DEPLOY = /vercel|netlify|render|fly\.?io|heroku|railway|deploy|github|gitlab|argo|cloudflare/i;
const CLOUD =
  /digitalocean|digital ocean|aws|amazon|gcp|google cloud|azure|rds|cloud|linode|hetzner|kube|k8s/i;

/** Where a fix goes and why it may be missing: access the workspace lacks is named, with where to get it. */
export function fixViews(def: WatchDef, ctx: FixContext): WatchFixView[] {
  const fix = def.fire.fix;
  const spec = def.spec;
  const out: WatchFixView[] = [];
  const conn = "connection" in spec ? ctx.connections.find((c) => c.id === spec.connection) : undefined;
  const state = (id: WatchFixId, possible: boolean): "on" | "off" | "needs" =>
    !possible ? "needs" : fix.allowed.includes(id) ? "on" : "off";
  for (const id of Object.keys(FIX_META) as WatchFixId[]) {
    const meta = FIX_META[id];
    if (!meta.kinds.includes(spec.kind)) continue;
    const label = meta.label.replace("{sec}", String(fix.killOverSec));
    switch (id) {
      case "kill_queries":
        out.push({
          id,
          label,
          detail:
            conn === undefined ? "needs a database connection" : `${conn.name}, the connection's own user`,
          state: state(id, conn !== undefined),
          ...(conn === undefined ? { need: "database" } : {}),
        });
        break;
      case "index_task":
        out.push({
          id,
          label,
          detail: "as a task, ships by your Merge setting",
          state: state(id, def.project !== undefined),
          ...(def.project === undefined ? { need: "project" } : {}),
        });
        break;
      case "scale_db": {
        const cloud = ctx.connections.find((c) => CLOUD.test(c.name));
        out.push({
          id,
          label,
          detail: cloud === undefined ? "needs cloud access" : cloud.name,
          state: state(id, cloud !== undefined),
          ...(cloud === undefined ? { need: "cloud" } : {}),
        });
        break;
      }
      case "rollback": {
        const deploy = ctx.connections.find(
          (c) => (c.type === "mcp" || c.type === "api" || c.type === "cli") && DEPLOY.test(c.name),
        );
        out.push({
          id,
          label,
          detail: deploy === undefined ? "needs deploy access" : deploy.name,
          state: state(id, deploy !== undefined),
          ...(deploy === undefined ? { need: "deploy" } : {}),
        });
        break;
      }
      case "restart_service":
        out.push({
          id,
          label: fix.service === undefined ? label : `Restart ${fix.service}`,
          detail:
            conn === undefined
              ? "needs an SSH connection"
              : fix.service === undefined
                ? "name the service"
                : `${conn.name}, systemctl restart`,
          state: state(id, conn !== undefined && fix.service !== undefined),
          ...(conn === undefined
            ? { need: "ssh" }
            : fix.service === undefined
              ? { need: "service name" }
              : {}),
        });
        break;
      case "clear_logs":
        out.push({
          id,
          label: fix.logDir === undefined ? label : `Clear old logs in ${fix.logDir}`,
          detail:
            conn === undefined
              ? "needs an SSH connection"
              : fix.logDir === undefined
                ? "name the folder under /var/log"
                : `${conn.name}, .log files older than 7 days`,
          state: state(
            id,
            conn !== undefined && fix.logDir !== undefined && logDirProblem(fix.logDir) === undefined,
          ),
          ...(conn === undefined ? { need: "ssh" } : fix.logDir === undefined ? { need: "log folder" } : {}),
        });
        break;
      case "scale_workers":
        out.push({
          id,
          label,
          detail: fix.runbook === undefined ? "needs a runbook" : "follows your runbook",
          state: state(id, fix.runbook !== undefined && fix.runbook.trim() !== ""),
          ...(fix.runbook === undefined ? { need: "runbook" } : {}),
        });
        break;
    }
  }
  return out;
}

export function logDirProblem(dir: string): string | undefined {
  if (!/^\/var\/log\/[A-Za-z0-9_./-]{1,100}$/.test(dir) || dir.includes("..")) {
    return "Use a folder under /var/log, like /var/log/app.";
  }
  return undefined;
}

/** The fixes the owner allowed that can run. */
export function executableFixes(def: WatchDef, ctx: FixContext): WatchFixId[] {
  return fixViews(def, ctx)
    .filter((v) => v.state === "on")
    .map((v) => v.id);
}

/** A starting "when it fires" for a kind: what the planner offers, with fixes only for what the workspace has. */
export function defaultFire(def: Pick<WatchDef, "spec" | "project">, ctx: FixContext): WatchFire {
  const base: WatchFire = {
    alert: {
      on: true,
      phone: def.spec.kind === "database" || def.spec.kind === "server" || def.spec.kind === "website",
    },
    investigate: def.spec.kind !== "price" && def.spec.kind !== "path",
    fix: { mode: "off", allowed: [], killOverSec: 30, rerunMin: 15 },
    statusNote: false,
    runOverlap: "skip",
    tellOnRecover: true,
  };
  if (def.spec.kind === "price") return { ...base, alert: { on: true, phone: false }, investigate: true };
  if (def.spec.kind === "database") {
    const probe = fixViews(
      {
        name: "x",
        spec: def.spec,
        condition: { type: "down" },
        everyMin: 5,
        fire: base,
        project: def.project,
      },
      ctx,
    );
    const allowed = probe
      .filter((v) => v.state !== "needs" && (v.id === "kill_queries" || v.id === "index_task"))
      .map((v) => v.id);
    return { ...base, fix: { ...base.fix, mode: allowed.length > 0 ? "ask" : "off", allowed } };
  }
  return base;
}

/** The buttons of a fix question: all of them together, then each alone. */
export function fixOptions(
  ids: readonly WatchFixId[],
  killOverSec: number,
): { id: string; label: string; fixes: WatchFixId[] }[] {
  const cap = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);
  const list = ids.slice(0, 4);
  if (list.length === 0) return [];
  const first = list[0];
  if (list.length === 1 && first !== undefined) {
    return [{ id: "fix:all", label: cap(FIX_META[first].short), fixes: [first] }];
  }
  return [
    { id: "fix:all", label: list.length === 2 ? "Do both" : "Do all", fixes: [...list] },
    ...list.map((id) => ({ id: `fix:${id}`, label: `Only ${FIX_META[id].short}`, fixes: [id] })),
  ].map((o) => ({ ...o, label: o.label.replace("{sec}", String(killOverSec)) }));
}

// Statements and commands -------------------------------------------------------------

/**
 * The statements a fix runs. `kill_queries` cancels (never terminates) statements that run too long. The
 * port accepts a statement only if it is a read or exactly one of these.
 */
export function cancelQueriesSql(engine: "postgres" | "mysql", seconds: number): string {
  const n = Math.max(5, Math.min(3600, Math.trunc(seconds)));
  return engine === "postgres"
    ? `SELECT count(*) FROM (SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND now() - query_start > interval '${n} seconds') AS cancelled`
    : `SELECT id FROM information_schema.processlist WHERE command = 'Query' AND time > ${n} AND id <> CONNECTION_ID()`;
}

const FIX_STATEMENTS: readonly RegExp[] = [
  /^SELECT count\(\*\) FROM \(SELECT pg_cancel_backend\(pid\) FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid\(\) AND now\(\) - query_start > interval '\d{1,4} seconds'\) AS cancelled$/,
  /^SELECT id FROM information_schema\.processlist WHERE command = 'Query' AND time > \d{1,4} AND id <> CONNECTION_ID\(\)$/,
  /^KILL QUERY \d{1,20}$/,
];

/** True for the fixed statements of a fix. The real database port allows these and reads, nothing else. */
export function isFixStatement(sql: string): boolean {
  return FIX_STATEMENTS.some((re) => re.test(sql));
}

/** Runs one fix that majhi's own code does. Returns one plain line for the timeline. */
export async function runCodeFix(
  id: WatchFixId,
  def: WatchDef,
  org: string,
  ports: WatchPorts,
  urlOf: (engine: "postgres" | "mysql") => Promise<string>,
): Promise<string> {
  const fix = def.fire.fix;
  const spec = def.spec;
  if (id === "kill_queries" && spec.kind === "database") {
    const conn = await ports.connection(spec.connection);
    if (conn === undefined || conn.org !== org) throw new Unavailable("the database connection is gone");
    const url = await urlOf(spec.engine);
    const out = await ports.sql(spec.engine, url, cancelQueriesSql(spec.engine, fix.killOverSec), 20_000);
    if (spec.engine === "postgres") {
      const n = Number(/\d+/.exec(out)?.[0] ?? "0");
      return `Cancelled ${n} ${n === 1 ? "query" : "queries"} running over ${fix.killOverSec} s`;
    }
    const ids = [...out.matchAll(/^\d{1,20}$/gm)].map((m) => m[0]).slice(0, 50);
    for (const pid of ids) await ports.sql("mysql", url, `KILL QUERY ${pid}`, 10_000);
    return `Cancelled ${ids.length} ${ids.length === 1 ? "query" : "queries"} running over ${fix.killOverSec} s`;
  }
  if ((id === "restart_service" || id === "clear_logs") && spec.kind === "server") {
    const conn = await ports.connection(spec.connection);
    if (conn === undefined || conn.org !== org || conn.type !== "ssh")
      throw new Unavailable("the SSH connection is gone");
    const alias = conn.fields.alias ?? "";
    if (id === "restart_service") {
      if (fix.service === undefined) throw new Unavailable("no service is named");
      const res = await runAllowed(ports, alias, `sudo -n systemctl restart ${fix.service}`);
      if (res.code !== 0) throw new Unavailable(`restarting ${fix.service} did not work`);
      return `Restarted ${fix.service}`;
    }
    if (fix.logDir === undefined || logDirProblem(fix.logDir) !== undefined)
      throw new Unavailable("no safe log folder is named");
    const res = await runAllowed(ports, alias, `find ${fix.logDir} -type f -name '*.log' -mtime +7 -delete`);
    if (res.code !== 0) throw new Unavailable(`clearing logs in ${fix.logDir} did not work`);
    return `Cleared .log files older than 7 days in ${fix.logDir}`;
  }
  throw new Unavailable("that fix is not one majhi runs itself");
}

export function fixBy(id: WatchFixId): "code" | "captain" {
  return FIX_META[id].by;
}
