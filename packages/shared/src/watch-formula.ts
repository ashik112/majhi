import { z } from "zod";

/**
 * Metric watches that combine reads (SPEC watch checks): each read picks values from a tool's answer
 * and folds them to one number, and a formula like `100*(1-a/b)` combines the reads. Pure; no eval.
 */

export const MetricAggSchema = z.enum(["last", "first", "max", "min", "avg", "sum", "rate", "delta"]);
export type MetricAgg = z.infer<typeof MetricAggSchema>;

export const MetricReadSchema = z.object({
  tool: z.string().trim().min(1).max(300),
  args: z.string().max(2000).default("{}"),
  /** Where the value sits. `*` walks every item of an array, `-1` is an array's last item. */
  path: z.string().trim().min(1).max(200),
  /** How a series (`[[time, value], ...]` or a list of numbers) becomes one number. Default: last. */
  agg: MetricAggSchema.optional(),
  /** Keep only the items under `*` where a field has a value, like `metric.mode=idle`. */
  where: z
    .string()
    .trim()
    .max(120)
    .regex(/^[\w.-]+=[^=]*$/)
    .optional(),
});
export type MetricRead = z.infer<typeof MetricReadSchema>;

/** The extra reads of a formula, `b` to `e`; the metric's own tool, args and path are `a`. */
export const MetricReadsSchema = z.record(z.string().regex(/^[b-e]$/), MetricReadSchema);

/** The value at a dotted path; `-1` indexes from the end. Own properties only. */
function at(value: unknown, parts: readonly string[]): unknown {
  let cur: unknown = value;
  for (const part of parts) {
    if (Array.isArray(cur) && /^-?\d+$/.test(part)) {
      const i = Number(part);
      cur = cur[i < 0 ? cur.length + i : i];
      continue;
    }
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, part))
      return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The values a path picks; `*` fans out over an array, `where` keeps the matching items there. */
export function pick(value: unknown, path: string, where?: string): unknown[] {
  const parts = path.split(".");
  const star = parts.indexOf("*");
  if (star === -1) {
    const v = at(value, parts);
    return v === undefined ? [] : [v];
  }
  const list = at(value, parts.slice(0, star));
  if (!Array.isArray(list)) return [];
  const eq = where?.indexOf("=") ?? -1;
  const kept =
    where === undefined || eq === -1
      ? list
      : list.filter((item) => String(at(item, where.slice(0, eq).split("."))) === where.slice(eq + 1));
  const rest = parts.slice(star + 1).join(".");
  return rest === "" ? kept : kept.flatMap((item) => pick(item, rest));
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** One value as a number: a number itself, or a series folded by `agg`. Undefined when it holds none. */
export function fold(value: unknown, agg: MetricAgg = "last"): number | undefined {
  const scalar = num(value);
  if (scalar !== undefined) return scalar;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const points = value.flatMap((p): { t: number | undefined; v: number }[] => {
    if (Array.isArray(p) && p.length >= 2) {
      const v = num(p[1]);
      return v === undefined ? [] : [{ t: num(p[0]), v }];
    }
    const v = num(p);
    return v === undefined ? [] : [{ t: undefined, v }];
  });
  if (points.length === 0) return undefined;
  const vs = points.map((p) => p.v);
  const first = points[0] as { t: number | undefined; v: number };
  const last = points[points.length - 1] as { t: number | undefined; v: number };
  switch (agg) {
    case "last":
      return last.v;
    case "first":
      return first.v;
    case "max":
      return Math.max(...vs);
    case "min":
      return Math.min(...vs);
    case "sum":
      return vs.reduce((s, v) => s + v, 0);
    case "avg":
      return vs.reduce((s, v) => s + v, 0) / vs.length;
    case "delta":
      return last.v - first.v;
    case "rate": {
      if (first.t === undefined || last.t === undefined || last.t === first.t) return undefined;
      return (last.v - first.v) / (last.t - first.t);
    }
  }
}

/** A read's number: every picked value folded, then added up (several series of one metric). */
export function readNumber(
  answer: unknown,
  read: Pick<MetricRead, "path" | "agg" | "where">,
): number | undefined {
  const values = pick(answer, read.path, read.where)
    .map((v) => fold(v, read.agg))
    .filter((n): n is number => n !== undefined);
  return values.length === 0 ? undefined : values.reduce((s, v) => s + v, 0);
}

/** Why a formula is not one we compute, or undefined. Numbers, a to e, + - * / and parentheses. */
export function formulaProblem(formula: string): string | undefined {
  try {
    evaluate(formula, { a: 1, b: 1, c: 1, d: 1, e: 1 });
    return undefined;
  } catch (err) {
    return err instanceof FormulaError ? err.message : "the formula is not valid";
  }
}

export class FormulaError extends Error {}

/** Evaluates `100*(1-a/b)` with the reads' numbers. Throws FormulaError on bad input or a division by zero. */
export function evaluate(formula: string, vars: Readonly<Record<string, number>>): number {
  const tokens = formula.match(/\d+(?:\.\d+)?|[a-e]|[-+*/()]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): number => {
    const t = next();
    if (t === undefined) throw new FormulaError("the formula ends too early");
    if (t === "(") {
      const v = sum();
      if (next() !== ")") throw new FormulaError("a parenthesis is not closed");
      return v;
    }
    if (t === "-") return -primary();
    if (/^\d/.test(t)) return Number(t);
    if (/^[a-e]$/.test(t)) {
      const v = vars[t];
      if (v === undefined) throw new FormulaError(`the formula uses ${t}, which is not read`);
      return v;
    }
    throw new FormulaError(`the formula has ${t}: use numbers, a to e, + - * / and parentheses`);
  };
  const product = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = primary();
      if (op === "/" && r === 0) throw new FormulaError("the formula divides by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + product() : v - product();
    return v;
  };
  if (formula.length > 200) throw new FormulaError("the formula is too long");
  const v = sum();
  if (i !== tokens.length) throw new FormulaError("the formula has something left over");
  return v;
}

/**
 * Why a script watch's script may change something, or undefined. A watch only reads: HTTP methods
 * other than GET, sent data, and the change verbs of kubectl, glab, gh, git and docker are refused,
 * as are deletes and writes to files outside /tmp. A guard on the text, not a sandbox: the script also
 * runs in a read-only throwaway container.
 */
export function scriptProblem(script: string): string | undefined {
  const checks: [RegExp, string][] = [
    [
      /(?:-X|--request)\s*['"]?(?:POST|PUT|PATCH|DELETE)\b/i,
      "it sends a request that changes something (only GET reads)",
    ],
    [/\s(?:-d|--data(?:-\w+)?|--json|-F|--form|-T|--upload-file)\b/, "it sends data"],
    [
      /\b(?:requests|httpx|axios|session)\.(?:post|put|patch|delete)\b/i,
      "it sends a request that changes something",
    ],
    [/\bmethod\s*[:=]\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i, "it sends a request that changes something"],
    [
      /\bfetch\([^)]*method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)/i,
      "it sends a request that changes something",
    ],
    [
      /\bkubectl\s+(?:[^|;&\n]*\s)?(?:delete|apply|patch|edit|create|replace|scale|rollout|drain|cordon|label|annotate|set|exec)\b/,
      "it changes the cluster",
    ],
    [
      /\b(?:glab|gh)\s+\S+\s+(?:create|merge|delete|close|approve|edit|reopen|comment|note|run|cancel|retry)\b/,
      "it changes the repository",
    ],
    [/\bgit\s+(?:push|commit|reset|rebase|merge|tag|branch\s+-[dD])\b/, "it changes a repository"],
    [/\bdocker\s+(?:rm|rmi|run|stop|kill|exec|system|volume|network)\b/, "it changes containers"],
    [/\b(?:rm|rmdir|shred|truncate|dd|mkfs)\s/, "it deletes or overwrites files"],
    [
      /\b(?:DROP|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|DATABASE))\b/i,
      "it changes a database",
    ],
    [/>{1,2}\s*(?!\/tmp\/|\/dev\/null|&)[^\s|;&]+/, "it writes a file outside /tmp"],
  ];
  for (const [re, why] of checks) if (re.test(script)) return `A watch only reads: ${why}.`;
  return undefined;
}

/** A script's output as a value: JSON read at `path`, else a number, else its first line as a word. */
export function scriptValue(
  out: string,
  read: { path?: string | undefined; agg?: MetricAgg | undefined; where?: string | undefined },
): { number: number } | { text: string } | undefined {
  const trimmed = out.trim();
  if (trimmed === "") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    json = undefined;
  }
  if (json !== undefined && read.path !== undefined && read.path !== "") {
    const n = readNumber(json, { path: read.path, agg: read.agg, where: read.where });
    if (n !== undefined) return { number: n };
    const v = pick(json, read.path)[0];
    if (typeof v === "string" && v.trim() !== "") return { text: v.trim().slice(0, 80) };
    if (typeof v === "boolean") return { text: String(v) };
    return undefined;
  }
  const n = fold(json ?? trimmed, read.agg);
  if (n !== undefined) return { number: n };
  const first = trimmed.split("\n")[0]?.trim() ?? "";
  return first === "" ? undefined : { text: first.slice(0, 80) };
}
