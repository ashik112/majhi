import { z } from "zod";
import { AutomationActionSchema, AutomationRunSchema, OverlapPolicySchema } from "./automation.ts";
import { ImageRefSchema } from "./containers.ts";
import { IdSchema } from "./ids.ts";
import { OpsIncidentSchema } from "./ops.ts";
import { TaskIdSchema } from "./tasks.ts";
import {
  formulaProblem,
  MetricAggSchema,
  MetricReadSchema,
  MetricReadsSchema,
  scriptProblem,
} from "./watch-formula.ts";

/**
 * Watch anything (SPEC 5.18, Ops watch): one watch is one thing the owner wants to know about, with a
 * cheap code check, an alert condition, how often to look and what to do when it fires. Nothing here
 * carries a secret: a watch names a workspace connection and majhi reads the secret from secrets.age
 * only while it looks.
 */

export const WatchIdSchema = z.string().regex(/^wch-[a-z0-9]{4,12}$/);
export type WatchId = z.infer<typeof WatchIdSchema>;

export const WATCH_KINDS = [
  "website",
  "database",
  "redis",
  "server",
  "queue",
  "price",
  "metric",
  "path",
  "task",
  "mr",
  "branch",
  "process",
  "usage",
  "command",
  "script",
  "custom",
] as const;
export const WatchSortSchema = z.enum(WATCH_KINDS);
export type WatchSort = z.infer<typeof WatchSortSchema>;

export const WATCH_KIND_LABEL: Record<WatchSort, string> = {
  website: "Websites",
  database: "Databases",
  redis: "Redis",
  server: "Servers",
  queue: "Queues",
  price: "Prices and pages",
  metric: "Metrics",
  path: "Files",
  task: "Tasks",
  mr: "Merge requests",
  branch: "Branches",
  process: "Processes",
  usage: "Usage",
  command: "Commands",
  script: "Scripts",
  custom: "Custom",
};

export const WATCH_KIND_ONE: Record<WatchSort, string> = {
  website: "Website or API",
  database: "Database",
  redis: "Redis",
  server: "Server",
  queue: "Queue",
  price: "Price or page",
  metric: "Metric",
  path: "File or folder",
  task: "Task status",
  mr: "Merge request",
  branch: "Branch",
  process: "Background process",
  usage: "Usage or cost",
  command: "Command output",
  script: "Script",
  custom: "In words",
};

const Url = z.string().trim().min(1).max(500);
const Conn = IdSchema;

export const USAGE_SOURCES = [
  "spend",
  "account5h",
  "accountWeek",
  "budget",
  "autopilotDay",
  "monthlyCeiling",
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const WatchCheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("website"),
    url: Url,
    expectStatus: z.number().int().min(100).max(599).optional(),
    keyword: z.string().max(200).optional(),
    /** A number inside a JSON answer, like `data.queue.depth`. Absent: the status and the time to first byte. */
    jsonPath: z.string().trim().max(200).optional(),
  }),
  z.object({
    kind: z.literal("database"),
    /** An env connection that holds the database URL. */
    connection: Conn,
    engine: z.enum(["postgres", "mysql", "mongodb", "image"]),
    /** One read-only statement (SELECT, SHOW or EXPLAIN) whose first value is a number. For MongoDB, a JSON read command (see `parseMongoCommand`). */
    query: z.string().trim().min(1).max(1000),
    /** What the number is, for the screen: "p95". */
    label: z.string().trim().max(40).optional(),
    unit: z.string().trim().max(12).optional(),
  }),
  z.object({
    kind: z.literal("redis"),
    connection: Conn,
    metric: z.enum(["memory_ratio", "clients", "keys", "info"]),
    /** The INFO field of the `info` metric, like `evicted_keys`. */
    infoField: z
      .string()
      .regex(/^[a-z_0-9]{1,60}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal("server"),
    /** An ssh connection. */
    connection: Conn,
    metric: z.enum(["disk", "cpu", "memory"]),
    /** The mount of the disk check. */
    path: z.string().max(100).default("/"),
  }),
  z.object({
    kind: z.literal("queue"),
    connection: Conn,
    source: z.enum(["redis_list", "sql"]),
    key: z.string().max(200).optional(),
    engine: z.enum(["postgres", "mysql"]).optional(),
    /** For `sql`: a SELECT count. */
    query: z.string().trim().max(1000).optional(),
  }),
  z.object({
    kind: z.literal("price"),
    /** A public page: no cookies, no sign-in. */
    url: Url,
    mode: z.enum(["value", "text"]),
    /** A CSS selector like `.price` or `meta[itemprop=price]`. */
    selector: z.string().trim().max(200).optional(),
    /** Or text around the number, like `Price: (\d+)`. */
    pattern: z.string().trim().max(200).optional(),
    /** Other stores the captain compares when it fires. */
    compare: z.array(Url).max(5).default([]),
  }),
  z.object({
    kind: z.literal("metric"),
    /** A remote MCP connection of a monitoring service, one read tool and where the number sits in its answer. */
    connection: Conn,
    tool: z.string().trim().min(1).max(300),
    args: z.string().max(2000).default("{}"),
    path: z.string().trim().min(1).max(200),
    /** How a series at `path` becomes one number, and which items under `*` count. */
    agg: MetricAggSchema.optional(),
    where: MetricReadSchema.shape.where,
    /** More reads, `b` to `e`, for a formula. */
    reads: MetricReadsSchema.optional(),
    /** Combines the reads, like `100*(1-a/b)`. Absent: the value is `a`. */
    formula: z
      .string()
      .trim()
      .max(200)
      .refine((f) => formulaProblem(f) === undefined, {
        message: "Use numbers, a to e, + - * / and parentheses",
      })
      .optional(),
    label: z.string().trim().max(60).optional(),
    unit: z.string().trim().max(12).optional(),
  }),
  z.object({
    kind: z.literal("path"),
    project: IdSchema,
    /** A file or folder inside the project's checkout, relative to it. A folder counts everything in it. */
    path: z.string().trim().min(1).max(500),
  }),
  z.object({
    kind: z.literal("task"),
    /** One task, or every task of the workspace. It fires when a task gets to the status. */
    task: TaskIdSchema.optional(),
    /** `failed`: paused on an error. `needs-you`: in review, an MR is open, or paused. */
    to: z.enum(["done", "failed", "needs-you"]),
  }),
  z.object({
    kind: z.literal("mr"),
    /** One task, or every task of the workspace. */
    task: TaskIdSchema.optional(),
    /**
     * `opened`, `merged`, `failed` (its checks fail), `approved`, `changesRequested`,
     * `reviewRequested` (a reviewer was asked) or `any` change of state, checks or review.
     */
    on: z.enum(["opened", "merged", "failed", "approved", "changesRequested", "reviewRequested", "any"]),
  }),
  z.object({
    kind: z.literal("branch"),
    project: IdSchema,
    /** A local branch of the project's checkout. It fires when it gets new commits. */
    branch: z.string().trim().min(1).max(200),
  }),
  z.object({
    kind: z.literal("process"),
    task: TaskIdSchema,
    /** A process id or name, or any process of the task. */
    process: z.string().trim().min(1).max(80).optional(),
    on: z.enum(["any", "failure"]),
  }),
  z.object({
    kind: z.literal("usage"),
    /**
     * `spend`: what the workspace used (metric and period). The others read a percent of a limit:
     * an account's 5-hour or weekly window, a workspace's or account's weekly budget, the Auto-pilot
     * daily budget or the monthly ceiling.
     */
    source: z.enum(USAGE_SOURCES).default("spend"),
    metric: z.enum(["costUsd", "totalTokens"]).default("costUsd"),
    period: z.enum(["today", "week", "month"]).default("today"),
    /** The account of `account5h` and `accountWeek`, or of `budget` when it is an account's. Absent on `budget`: the workspace's. */
    account: IdSchema.optional(),
  }),
  z.object({
    kind: z.literal("command"),
    /** The command runs as a process of this task, in the task's sandbox, never in majhi's own environment. */
    task: TaskIdSchema,
    command: z.string().trim().min(1).max(4_000),
    cwd: z.string().trim().min(1).max(1_000).optional(),
  }),
  z
    .object({
      kind: z.literal("script"),
      /**
       * A read-only shell script that prints the value: a number, a word, or JSON read at `path`. It runs
       * on majhi's clock in a throwaway runner container, with the named connections of the workspace.
       */
      script: z.string().trim().min(1).max(4_000),
      /**
       * `off`: the script runs with no network, for one that only builds a value (a URL, a connection
       * string) from what the connections give it. `on` (the default): it may call the connections' services,
       * and the script is checked to only read.
       */
      network: z.enum(["on", "off"]).default("on"),
      /** The workspace's connections it may use, by id: their variables, and `<ID>_TOKEN` for a sign-in. */
      connections: z.array(Conn).max(8).default([]),
      path: z.string().trim().max(200).optional(),
      agg: MetricAggSchema.optional(),
      where: MetricReadSchema.shape.where,
      label: z.string().trim().max(60).optional(),
      unit: z.string().trim().max(12).optional(),
    })
    .superRefine((v, ctx) => {
      const problem = scriptProblem(v.script, v.network);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem, path: ["script"] });
    }),
  z.object({
    kind: z.literal("custom"),
    /** What to check, in words. The captain looks on the schedule and reports a value or a state. */
    instruction: z.string().trim().min(3).max(600),
  }),
]);
export type WatchCheck = z.infer<typeof WatchCheckSchema>;

export const WatchConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("above"),
    value: z.number().finite(),
    forMin: z.number().int().min(0).max(1440).default(0),
  }),
  z.object({
    type: z.literal("below"),
    value: z.number().finite(),
    forMin: z.number().int().min(0).max(1440).default(0),
  }),
  z.object({ type: z.literal("changed") }),
  /** A percent at its limit (100 or more). */
  z.object({ type: z.literal("atLimit") }),
  /** A window or budget that was at its limit has reset. Fires once per reset. */
  z.object({ type: z.literal("resets") }),
  z.object({ type: z.literal("contains"), text: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("notContains"), text: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("down") }),
]);
export type WatchCondition = z.infer<typeof WatchConditionSchema>;

/** The fixes majhi knows. Never one that drops, deletes or truncates data. */
export const WATCH_FIXES = [
  "kill_queries",
  "index_task",
  "scale_db",
  "rollback",
  "restart_service",
  "clear_logs",
  "scale_workers",
] as const;
export const WatchFixIdSchema = z.enum(WATCH_FIXES);
export type WatchFixId = z.infer<typeof WatchFixIdSchema>;

export const WatchFireSchema = z.object({
  alert: z
    .object({ on: z.boolean().default(true), phone: z.boolean().default(false) })
    .default({ on: true, phone: false }),
  /** The captain looks into it, read only, and writes what it found on the incident. */
  investigate: z.boolean().default(false),
  fix: z
    .object({
      mode: z.enum(["off", "ask", "auto"]).default("off"),
      allowed: z.array(WatchFixIdSchema).max(8).default([]),
      /** Queries running longer than this are cancelled. */
      killOverSec: z.number().int().min(5).max(3600).default(30),
      /** A systemd unit the restart may name. */
      service: z
        .string()
        .regex(/^[a-z0-9@._-]{1,64}$/)
        .optional(),
      /** A folder under /var/log whose old .log files may be cleared. */
      logDir: z.string().max(100).optional(),
      /** Steps for the queue's workers, which the captain follows. */
      runbook: z.string().max(1000).optional(),
      /** Not fixed in this long, or worse: undo what can be undone and page the owner. */
      rerunMin: z.number().int().min(1).max(240).default(15),
    })
    .default({ mode: "off", allowed: [], killOverSec: 30, rerunMin: 15 }),
  /** Draft a status note, through the outbound gate. */
  statusNote: z.boolean().default(false),
  /** Free text the captain follows. */
  orDo: z.string().max(500).optional(),
  /**
   * An action majhi's own code runs when it fires, no model: start a task, post to a room or run a
   * process. `{{event}}` in a message or a task's text becomes a line about what fired. These were
   * the actions of Automations' triggers.
   */
  run: AutomationActionSchema.optional(),
  runOverlap: OverlapPolicySchema.default("skip"),
  /** A change must hold this long before it fires (the old trigger's settle time). */
  settleMin: z.number().int().min(0).max(1440).default(0),
  /** After it fires it waits this long before it fires again, the change kept for then. */
  cooldownMin: z.number().int().min(0).max(1440).default(0),
  tellOnRecover: z.boolean().default(true),
});
export type WatchFire = z.infer<typeof WatchFireSchema>;

export const WatchDefSchema = z.object({
  name: z.string().trim().min(1).max(100),
  spec: WatchCheckSchema,
  condition: WatchConditionSchema,
  /** Minutes between looks. */
  everyMin: z.number().int().min(1).max(10_080).default(5),
  fire: WatchFireSchema.default(() => WatchFireSchema.parse({})),
  /** The project a fix task opens in. */
  project: IdSchema.optional(),
});
export type WatchDef = z.infer<typeof WatchDefSchema>;

export const WatchStatusSchema = z.enum(["ok", "alerting", "changed", "paused", "unknown", "new"]);
export type WatchStatus = z.infer<typeof WatchStatusSchema>;

export const WatchSampleSchema = z.object({
  at: z.string(),
  /** The number, absent for a text-only look. */
  v: z.number().nullable(),
  ok: z.boolean(),
});
export type WatchSample = z.infer<typeof WatchSampleSchema>;

export const WatchFixViewSchema = z.object({
  id: WatchFixIdSchema,
  label: z.string(),
  /** Where and how: "hoo-prod, admin user", "as a task, ships by your Merge setting". */
  detail: z.string(),
  /** on: allowed and possible. off: possible, not allowed. needs: missing access. */
  state: z.enum(["on", "off", "needs"]),
  need: z.string().optional(),
});
export type WatchFixView = z.infer<typeof WatchFixViewSchema>;

export const WatchQuestionSchema = z.object({
  text: z.string(),
  /** The Needs you decision these buttons answer. */
  decision: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), primary: z.boolean().optional() })),
});

/** Who paused a watch. `unrecorded`: paused before majhi kept a reason. */
export const WatchPausedBySchema = z.enum(["owner", "agent", "unrecorded"]);
export type WatchPausedBy = z.infer<typeof WatchPausedBySchema>;

export const WatchViewSchema = z.object({
  id: WatchIdSchema,
  org: IdSchema,
  def: WatchDefSchema,
  status: WatchStatusSchema,
  /** The state in one word: Slow, High, Down, Changed, Low. */
  word: z.string(),
  /** The current value as the row shows it: "p95 2.4 s", "$1,999 → $1,799". */
  value: z.string(),
  number: z.number().optional(),
  lastAt: z.string().optional(),
  /** When the alert started. */
  since: z.string().optional(),
  quietUntil: z.string().optional(),
  quietKind: z.enum(["snooze", "maintenance"]).optional(),
  /** Why the last look could not tell. */
  unavailable: z.string().optional(),
  /** Set while the watch is paused: who did it and why, in one sentence. */
  paused: z.object({ by: WatchPausedBySchema, why: z.string() }).optional(),
  samples24: z.array(WatchSampleSchema),
  samples90: z.array(WatchSampleSchema),
  /** The price before it changed. */
  previous: z.string().optional(),
  stat: z.string().optional(),
  incident: z.number().int().positive().optional(),
  found: z.string().optional(),
  link: z.object({ label: z.string(), url: z.string() }).optional(),
  question: WatchQuestionSchema.optional(),
  fixes: z.array(WatchFixViewSchema),
  /** "How it checks", in one line. */
  how: z.string(),
  /** The last runs of its action, newest first. */
  runs: z.array(AutomationRunSchema).default([]),
});
export type WatchView = z.infer<typeof WatchViewSchema>;

export const WatchOverviewInputSchema = z.object({ org: IdSchema.optional() });
export const WatchOverviewSchema = z.object({
  watches: z.array(WatchViewSchema),
  /** Incidents of watches, open first, for the detail's history. */
  incidents: z.array(OpsIncidentSchema),
});
export type WatchOverview = z.infer<typeof WatchOverviewSchema>;

export const WatchTestResultSchema = z.object({
  ok: z.boolean(),
  /** The value as the row would show it, or why it could not be read. */
  value: z.string(),
  number: z.number().optional(),
});
export type WatchTestResult = z.infer<typeof WatchTestResultSchema>;

export const WatchTestInputSchema = z.object({ org: IdSchema, def: WatchDefSchema });

export const WatchPlanInputSchema = z.object({
  text: z.string().trim().min(3).max(500),
  org: IdSchema.optional(),
});
export const WatchPlanSchema = z.object({
  org: IdSchema,
  def: WatchDefSchema,
  /** One sentence, with **bold** around what the owner should check. */
  line: z.string(),
  test: WatchTestResultSchema,
  by: z.enum(["model", "rules"]),
});
export type WatchPlan = z.infer<typeof WatchPlanSchema>;

export const WatchSaveInputSchema = z.object({
  /** Absent to add one. */
  id: WatchIdSchema.optional(),
  org: IdSchema,
  def: WatchDefSchema,
});
export const WatchIdInputSchema = z.object({ id: WatchIdSchema });
export const WatchPauseInputSchema = z.object({
  id: WatchIdSchema,
  paused: z.boolean(),
  /** Why, in a line. An agent must say; a watch an agent paused resumes by itself once it reads fine. */
  note: z.string().trim().max(200).optional(),
});
export const WatchSnoozeInputSchema = z.object({
  id: WatchIdSchema,
  /** 0 clears it. */
  minutes: z.number().int().min(0).max(43_200),
  kind: z.enum(["snooze", "maintenance"]).default("snooze"),
});
/** What the captain reports: the value of a custom watch, what it found, a link worth opening. */
export const WatchReportInputSchema = z.object({
  id: WatchIdSchema,
  value: z.number().finite().optional(),
  text: z.string().trim().max(200).optional(),
  /** For a custom watch: whether the thing is fine. */
  ok: z.boolean().optional(),
  found: z.string().trim().max(1200).optional(),
  link: z.object({ label: z.string().trim().min(1).max(60), url: z.string().trim().max(500) }).optional(),
});

/** The statements a database or queue watch may run. Pure, shared so the form can say why not. */
const SQL_BLOCKED =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|call|do|merge|vacuum|reindex|lock|set|into|execute|prepare|rename|handler|load|analyze|attach|detach|pragma|begin|commit|rollback|savepoint|kill|reset|flush|optimize|repair|import|install|uninstall)\b/;
const SQL_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_reload_conf|pg_rotate_logfile|lo_import|lo_export|dblink|set_config|nextval|setval|load_file|sleep|benchmark|get_lock|sys_exec)\b/;

/** Why a statement is not allowed, or undefined. Only a single SELECT, SHOW or EXPLAIN (never ANALYZE) passes. */
export function readOnlySqlProblem(query: string): string | undefined {
  // Comments and quoted text are removed first, so a keyword inside a string is not a statement.
  const bare = query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .trim()
    .toLowerCase();
  if (bare === "") return "Write a query.";
  const body = bare.replace(/;+\s*$/, "");
  if (body.includes(";")) return "One statement only.";
  const first = /^[a-z]+/.exec(body)?.[0];
  if (first !== "select" && first !== "show" && first !== "explain") {
    return "Only SELECT, SHOW or EXPLAIN may run.";
  }
  if (first === "explain" && /\banalyze\b/.test(body))
    return "EXPLAIN ANALYZE runs the query. Use EXPLAIN alone.";
  if (first === "select" && /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(body)) {
    return "A locking read is not read only.";
  }
  const blocked = SQL_BLOCKED.exec(first === "explain" ? body.replace(/^explain\b/, "") : body);
  if (blocked !== null) {
    return `"${blocked[1]}" is not allowed. Only reads run.`;
  }
  const fn = SQL_FUNCTIONS.exec(body);
  if (fn !== null) return `${fn[1]} is not allowed in a read-only query.`;
  return undefined;
}

/** The MongoDB read commands a watch may run. */
export const MONGO_COMMANDS = ["count", "dbStats", "collStats", "serverStatus"] as const;
export type MongoCommandName = (typeof MONGO_COMMANDS)[number];

export type MongoCommand = {
  command: MongoCommandName;
  /** `count` and `collStats`. */
  collection?: string;
  /** `count`: the filter of documents to count. */
  query?: Record<string, unknown>;
  /** The dotted path to the number in the answer of dbStats, collStats and serverStatus, like `connections.current`. */
  path?: string;
};

// Operators that run code on the server or write; refused anywhere inside a filter.
const MONGO_BLOCKED_OPERATORS = new Set([
  "$where",
  "$function",
  "$accumulator",
  "$out",
  "$merge",
  "$expr",
  "$jsonSchema",
]);
const MONGO_NAME = /^[A-Za-z0-9_.-]{1,120}$/;
const MONGO_PATH = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,6}$/;

function blockedOperator(value: unknown, depth: number): string | undefined {
  if (depth > 8) return "a filter this deep";
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = blockedOperator(v, depth + 1);
      if (bad !== undefined) return bad;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (MONGO_BLOCKED_OPERATORS.has(k)) return k;
      const bad = blockedOperator(v, depth + 1);
      if (bad !== undefined) return bad;
    }
  }
  return undefined;
}

/** Parses a MongoDB watch command, or says why it is not allowed. Only the allow list of read commands passes. */
export function parseMongoCommand(
  text: string,
): { ok: true; command: MongoCommand } | { ok: false; problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'Write a JSON command like {"command":"count","collection":"orders"}.' };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: "The command must be one JSON object." };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["command", "collection", "query", "path"].includes(k)) {
      return { ok: false, problem: `"${k}" is not a field of a MongoDB check.` };
    }
  }
  const name = o.command;
  if (typeof name !== "string" || !(MONGO_COMMANDS as readonly string[]).includes(name)) {
    return { ok: false, problem: `Only ${MONGO_COMMANDS.join(", ")} may run on MongoDB.` };
  }
  const command = name as MongoCommandName;
  const collection = o.collection;
  if (collection !== undefined && (typeof collection !== "string" || !MONGO_NAME.test(collection))) {
    return { ok: false, problem: "The collection name is not valid." };
  }
  if ((command === "count" || command === "collStats") && collection === undefined) {
    return { ok: false, problem: `${command} needs a collection.` };
  }
  const query = o.query;
  if (query !== undefined) {
    if (command !== "count") return { ok: false, problem: "Only count takes a query." };
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      return { ok: false, problem: "The query must be a JSON object." };
    }
    const bad = blockedOperator(query, 0);
    if (bad !== undefined) return { ok: false, problem: `${bad} is not allowed. Only reads run.` };
  }
  const path = o.path;
  if (path !== undefined && (typeof path !== "string" || !MONGO_PATH.test(path))) {
    return { ok: false, problem: "The path must be dotted names like connections.current." };
  }
  if (command !== "count" && path === undefined) {
    return { ok: false, problem: `${command} needs a path to the number, like objects.` };
  }
  return {
    ok: true,
    command: {
      command,
      ...(collection === undefined ? {} : { collection }),
      ...(query === undefined ? {} : { query: query as Record<string, unknown> }),
      ...(path === undefined ? {} : { path }),
    },
  };
}

/** Why a MongoDB command is not allowed, or undefined. */
export function mongoCommandProblem(text: string): string | undefined {
  const r = parseMongoCommand(text);
  return r.ok ? undefined : r.problem;
}

/** The number at a dotted path of a MongoDB answer. The driver's Int32, Long and Double values all convert. */
export function numberAtPath(doc: unknown, path: string): number | undefined {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  const n =
    typeof cur === "object" && cur !== null && "valueOf" in cur
      ? Number((cur as { valueOf(): unknown }).valueOf())
      : cur;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** A database reached through its official image's own client. */
export type ImageCommand = {
  image: string;
  /** The client and its arguments, one word each. Run with no shell. */
  command: string[];
  /** A dotted path to the number when the client prints JSON. Absent: the first number printed. */
  path?: string;
};

const IMAGE_WRITE_WORDS =
  /\b(drop|delete|insert|update|truncate|alter|create|grant|revoke|replace|merge|rename|attach|detach|optimize|kill|system)\b/i;
const IMAGE_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "env", "eval", "exec", "xargs"]);

/**
 * Parses the JSON of an `image` database check, or says why it is not allowed. The only read-only
 * guarantee here is the owner's connection being a read-only login; the command must also hold none of
 * the obvious write words. A shell as the program is refused, so a word cannot start a second command.
 */
export function parseImageCommand(
  text: string,
): { ok: true; value: ImageCommand } | { ok: false; problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problem: 'Write JSON like {"image":"clickhouse/clickhouse-server:24","command":[...]}.',
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: "The check must be one JSON object." };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["image", "command", "path"].includes(k)) {
      return { ok: false, problem: `"${k}" is not a field of an image check.` };
    }
  }
  const image = ImageRefSchema.safeParse(o.image);
  if (!image.success) return { ok: false, problem: "Name the image, like clickhouse/clickhouse-server:24." };
  const command = o.command;
  if (
    !Array.isArray(command) ||
    command.length < 1 ||
    command.length > 32 ||
    command.some((a) => typeof a !== "string" || a === "" || a.length > 1000 || a.includes("\u0000"))
  ) {
    return { ok: false, problem: "The command is a list of words: the client, then its arguments." };
  }
  const words = command as string[];
  const program = (words[0] ?? "").split("/").pop() ?? "";
  if (IMAGE_SHELLS.has(program) || words[0]?.startsWith("-")) {
    return { ok: false, problem: "Run the database's own client, not a shell." };
  }
  const bad = IMAGE_WRITE_WORDS.exec(words.slice(1).join(" "));
  if (bad !== null) return { ok: false, problem: `"${bad[1]}" is not allowed. Only reads run.` };
  const path = o.path;
  if (
    path !== undefined &&
    (typeof path !== "string" || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,6}$/.test(path))
  ) {
    return { ok: false, problem: "The path must be dotted names like data.count." };
  }
  return {
    ok: true,
    value: { image: image.data, command: words, ...(path === undefined ? {} : { path }) },
  };
}

/** Why an image check is not allowed, or undefined. */
export function imageCommandProblem(text: string): string | undefined {
  const r = parseImageCommand(text);
  return r.ok ? undefined : r.problem;
}

/** Why a database check's query is not allowed for its engine, or undefined. */
export function databaseQueryProblem(
  engine: "postgres" | "mysql" | "mongodb" | "image",
  query: string,
): string | undefined {
  if (engine === "mongodb") return mongoCommandProblem(query);
  if (engine === "image") return imageCommandProblem(query);
  return readOnlySqlProblem(query);
}
