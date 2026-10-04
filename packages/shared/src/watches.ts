import { z } from "zod";
import { IdSchema } from "./ids.ts";
import { OpsIncidentSchema } from "./ops.ts";

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
  custom: "In words",
};

const Url = z.string().trim().min(1).max(500);
const Conn = IdSchema;

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
    engine: z.enum(["postgres", "mysql"]),
    /** One read-only statement (SELECT, SHOW or EXPLAIN) whose first value is a number. */
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
    tool: z.string().trim().min(1).max(120),
    args: z.string().max(2000).default("{}"),
    path: z.string().trim().min(1).max(200),
    label: z.string().trim().max(60).optional(),
    unit: z.string().trim().max(12).optional(),
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
export const WatchPauseInputSchema = z.object({ id: WatchIdSchema, paused: z.boolean() });
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
