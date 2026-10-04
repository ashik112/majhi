import { z } from "zod";
import type { RulesContext, RulesResult } from "../playbooks/rules.ts";
import { fresh } from "./cache.ts";
import { Unavailable } from "./net.ts";
import {
  closeUnseen,
  file,
  type Reporter,
  reporterOf,
  type SensorPorts,
  type SensorProject,
} from "./ports.ts";

/**
 * The end-of-life sensor (SPEC 5.18, sensors). The runtimes and databases on a project's card are
 * checked against endoflife.date (https://endoflife.date/docs/api/). A product's answer is cached for
 * a week. A runtime past its end of life, or within 90 days of it, is a finding. Only the product name
 * leaves the machine.
 */

export const EOL_URL = "https://endoflife.date";
const TTL_MS = 7 * 86_400_000;
export const SOON_DAYS = 90;
const DAY = 86_400_000;

/** Card stack line patterns to endoflife.date products. The first capture is the version. */
const PRODUCTS: { product: string; label: string; re: RegExp; cycleParts: number }[] = [
  { product: "nodejs", label: "Node.js", re: /^node(?:\.js)?\s+v?(\d[\d.]*)/i, cycleParts: 1 },
  { product: "python", label: "Python", re: /^python\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "go", label: "Go", re: /^go\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "ruby", label: "Ruby", re: /^ruby\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "php", label: "PHP", re: /^php\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "postgresql", label: "PostgreSQL", re: /^postgres(?:ql)?\s+v?(\d[\d.]*)/i, cycleParts: 1 },
  { product: "mysql", label: "MySQL", re: /^mysql\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "redis", label: "Redis", re: /^redis\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "java", label: "Java", re: /^(?:java|jdk)\s+v?(\d[\d.]*)/i, cycleParts: 1 },
  { product: "rails", label: "Rails", re: /^(?:ruby on )?rails\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "django", label: "Django", re: /^django\s+v?(\d[\d.]*)/i, cycleParts: 2 },
  { product: "laravel", label: "Laravel", re: /^laravel\s+v?(\d[\d.]*)/i, cycleParts: 1 },
];

export interface Runtime {
  product: string;
  label: string;
  /** The cycle to look up, like "22" or "3.11". */
  cycle: string;
}

/** The runtimes a card's stack lines name. A line without a version says nothing and is skipped. */
export function runtimesOf(stack: readonly string[]): Runtime[] {
  const out = new Map<string, Runtime>();
  for (const line of stack) {
    for (const p of PRODUCTS) {
      const v = p.re.exec(line.trim())?.[1];
      if (v === undefined) continue;
      const cycle = v
        .split(".")
        .filter((s) => s !== "")
        .slice(0, p.cycleParts)
        .join(".");
      if (cycle !== "") out.set(`${p.product}:${cycle}`, { product: p.product, label: p.label, cycle });
    }
  }
  return [...out.values()];
}

const CyclesSchema = z
  .array(
    z
      .object({
        cycle: z.union([z.string(), z.number()]).transform(String),
        eol: z.union([z.string(), z.boolean()]).optional(),
        latest: z.string().optional(),
      })
      .passthrough(),
  )
  .max(500);
type Cycles = z.infer<typeof CyclesSchema>;

async function cyclesOf(ports: SensorPorts, product: string, base: string): Promise<Cycles | undefined> {
  const key = `eol:${product}`;
  const cached = ports.cache.json(key, (raw) => {
    const r = CyclesSchema.safeParse(raw);
    return r.success ? r.data : undefined;
  });
  if (cached !== undefined && fresh(cached.row, TTL_MS, ports.now())) return cached.value;
  try {
    const res = await ports.net.json(`${base}/api/${encodeURIComponent(product)}.json`);
    const parsed = CyclesSchema.safeParse(res.body);
    if (res.status !== 200 || !parsed.success) return cached?.value;
    // Only what is read is kept.
    const slim = parsed.data.map((c) => ({
      cycle: c.cycle,
      ...(c.eol === undefined ? {} : { eol: c.eol }),
      ...(c.latest === undefined ? {} : { latest: c.latest }),
    }));
    ports.cache.put({ key, body: JSON.stringify(slim), at: ports.now().toISOString() });
    return slim;
  } catch (err) {
    if (err instanceof Unavailable) return cached?.value;
    throw err;
  }
}

/** The end-of-life date of a cycle. `false` means no date is set; `true` means already unsupported. */
export function eolOf(cycles: Cycles, cycle: string): Date | "past" | undefined {
  const c = cycles.find((x) => x.cycle === cycle);
  if (c === undefined || c.eol === undefined || c.eol === false) return undefined;
  if (c.eol === true) return "past";
  const d = new Date(`${c.eol}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function eolWatch(ports: SensorPorts, base: string = EOL_URL) {
  return {
    async run(ctx: RulesContext): Promise<RulesResult> {
      const r = reporterOf(ctx);
      const projects = await ports.projects(ctx.org);
      if (projects.length === 0) return { findings: 0, note: "No project is registered" };
      let filed = 0;
      let checked = 0;
      let down = 0;
      for (const project of projects) {
        const runtimes = runtimesOf(project.stack);
        if (runtimes.length === 0) continue;
        checked += 1;
        const seen = new Set<string>();
        let complete = true;
        for (const rt of runtimes) {
          const cycles = await cyclesOf(ports, rt.product, base).catch(() => undefined);
          if (cycles === undefined) {
            complete = false;
            down += 1;
            continue;
          }
          const eol = eolOf(cycles, rt.cycle);
          if (eol === undefined) continue;
          const n = ports.now();
          const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
          const left = eol === "past" ? -1 : Math.round((eol.getTime() - today) / DAY);
          if (left > SOON_DAYS) continue;
          const key = `eol:${project.id}:${rt.product}:${rt.cycle}`;
          seen.add(key);
          await fileEol(r, project, rt, key, eol, left);
          filed += 1;
        }
        if (complete) filed += closeUnseen(r, project.id, "dependency", `eol:${project.id}:`, seen);
      }
      if (checked > 0 && down > 0 && filed === 0) throw new Error("endoflife.date could not be asked");
      return {
        findings: filed,
        note: checked === 0 ? "No runtime with a version on a project card" : `${checked} checked`,
      };
    },
  };
}

async function fileEol(
  r: Reporter,
  project: SensorProject,
  rt: Runtime,
  key: string,
  eol: Date | "past",
  left: number,
): Promise<void> {
  const past = left < 0;
  const when =
    eol === "past"
      ? "has reached"
      : past
        ? `reached on ${eol.toISOString().slice(0, 10)}`
        : `ends on ${eol.toISOString().slice(0, 10)}`;
  await file(r, {
    project: project.id,
    source: "dependency",
    key,
    title: past
      ? `${rt.label} ${rt.cycle} is past its end of life`
      : `${rt.label} ${rt.cycle} reaches end of life in ${left} days`,
    detail: past
      ? `${rt.label} ${rt.cycle} ${when === "has reached" ? "has reached" : when} its end of life, so it gets no security fixes. Plan the move to a supported version.`
      : `Support for ${rt.label} ${rt.cycle} ${when}. Plan the move to a supported version before then.`,
    evidence: [`${rt.label} ${rt.cycle} (from the project card)`, `${EOL_URL}/${rt.product}`],
    severity: past ? "high" : left <= 30 ? "medium" : "low",
  });
}
