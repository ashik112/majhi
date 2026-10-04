import { z } from "zod";
import { fresh, type SensorCache } from "./cache.ts";
import type { Pkg } from "./lockfiles.ts";
import type { Net } from "./net.ts";
import { Unavailable } from "./net.ts";

/**
 * The OSV.dev client (https://google.github.io/osv.dev/post-v1-querybatch/). A batch answers up to 1000
 * packages at once, so a lockfile of 10,000 packages is ten requests. Only a package name, its ecosystem
 * and its version leave the machine. Answers are untrusted text: they are parsed against a schema and
 * the summary is cut and cleaned before it reaches a finding.
 */

export const OSV_URL = "https://api.osv.dev";
/** OSV refuses more queries than this in one batch. */
export const OSV_BATCH = 1000;
/** Pages of one batch that were cut off by OSV's own limit are followed this many times. */
const MAX_PAGES = 3;
/** Advisory details are fetched at most this many per run; the rest keep their id and wait. */
export const MAX_DETAILS = 150;
const DETAIL_TTL_MS = 7 * 86_400_000;

export const pkgKey = (p: Pick<Pkg, "ecosystem" | "name" | "version">): string =>
  `${p.ecosystem}\u0000${p.name}\u0000${p.version}`;

const BatchSchema = z.object({
  results: z.array(
    z
      .object({
        vulns: z.array(z.object({ id: z.string().max(100) })).optional(),
        next_page_token: z.string().max(2000).optional(),
      })
      .passthrough(),
  ),
});

const VulnSchema = z
  .object({
    id: z.string().max(100),
    aliases: z.array(z.string().max(100)).max(50).optional(),
    summary: z.string().max(100_000).optional(),
    withdrawn: z.string().optional(),
    database_specific: z
      .object({ severity: z.string().max(40).optional() })
      .passthrough()
      .optional(),
    affected: z
      .array(
        z
          .object({
            package: z.object({ name: z.string().optional(), ecosystem: z.string().optional() }).optional(),
            ranges: z
              .array(
                z.object({
                  events: z
                    .array(z.object({ fixed: z.string().max(100).optional() }).passthrough())
                    .optional(),
                }),
              )
              .optional(),
          })
          .passthrough(),
      )
      .max(500)
      .optional(),
  })
  .passthrough();

export type Severity = "low" | "medium" | "high";

/** What a finding needs of an advisory. Small: it is also what is cached. */
export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  /** Fixed versions by `ecosystem\0name`. */
  fixed: Record<string, string[]>;
  withdrawn: boolean;
}

const AdvisorySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()),
  summary: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  fixed: z.record(z.string(), z.array(z.string())),
  withdrawn: z.boolean(),
});

/** One line of plain text from an advisory's summary: no control characters, no markup, at most 200 characters. */
export function plainSummary(text: string | undefined): string {
  const one = [...(text ?? "")]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
}

function severityOf(raw: string | undefined): Severity {
  switch (raw?.toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return "high";
    case "LOW":
      return "low";
    default:
      return "medium";
  }
}

export class Osv {
  constructor(
    private readonly net: Net,
    private readonly cache: SensorCache,
    private readonly now: () => Date,
    private readonly base: string = OSV_URL,
  ) {}

  /** The advisory ids that hit each package, by `pkgKey`. Throws `Unavailable` when OSV cannot answer. */
  async hits(pkgs: readonly Pkg[]): Promise<Map<string, string[]>> {
    const found = new Map<string, Set<string>>();
    for (let i = 0; i < pkgs.length; i += OSV_BATCH) {
      const chunk = pkgs.slice(i, i + OSV_BATCH);
      let pending = chunk.map((p) => ({ p, token: undefined as string | undefined }));
      for (let page = 0; page < MAX_PAGES && pending.length > 0; page += 1) {
        const answer = await this.net.json(`${this.base}/v1/querybatch`, {
          body: {
            queries: pending.map(({ p, token }) => ({
              package: { name: p.name, ecosystem: p.ecosystem },
              version: p.version,
              ...(token === undefined ? {} : { page_token: token }),
            })),
          },
        });
        if (answer.status !== 200) throw new Unavailable(`OSV answered ${answer.status}.`);
        const parsed = BatchSchema.safeParse(answer.body);
        if (!parsed.success || parsed.data.results.length !== pending.length) {
          throw new Unavailable("OSV gave an answer majhi does not understand.");
        }
        const next: typeof pending = [];
        parsed.data.results.forEach((r, n) => {
          const item = pending[n];
          if (item === undefined) return;
          const set = found.get(pkgKey(item.p)) ?? new Set<string>();
          for (const v of r.vulns ?? []) set.add(v.id);
          if (set.size > 0) found.set(pkgKey(item.p), set);
          if (r.next_page_token !== undefined) next.push({ p: item.p, token: r.next_page_token });
        });
        pending = next;
      }
    }
    return new Map([...found].map(([k, v]) => [k, [...v].sort()]));
  }

  /** One advisory, from the cache for a week. Undefined when it cannot be had now: the id still counts. */
  async advisory(id: string, budget: { left: number }): Promise<Advisory | undefined> {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)) return undefined;
    const key = `osv:vuln:${id}`;
    const cached = this.cache.json(key, (raw) => {
      const r = AdvisorySchema.safeParse(raw);
      return r.success ? r.data : undefined;
    });
    if (cached !== undefined && fresh(cached.row, DETAIL_TTL_MS, this.now())) return cached.value;
    if (budget.left <= 0) return cached?.value;
    budget.left -= 1;
    try {
      const answer = await this.net.json(`${this.base}/v1/vulns/${encodeURIComponent(id)}`);
      if (answer.status !== 200) return cached?.value;
      const v = VulnSchema.safeParse(answer.body);
      if (!v.success) return cached?.value;
      const fixed: Record<string, string[]> = {};
      for (const a of v.data.affected ?? []) {
        if (a.package?.name === undefined || a.package.ecosystem === undefined) continue;
        const list = (a.ranges ?? []).flatMap((r) =>
          (r.events ?? []).flatMap((e) => (e.fixed ? [e.fixed] : [])),
        );
        if (list.length > 0) fixed[`${a.package.ecosystem}\u0000${a.package.name}`] = [...new Set(list)];
      }
      const adv: Advisory = {
        id: v.data.id,
        aliases: v.data.aliases ?? [],
        summary: plainSummary(v.data.summary),
        severity: severityOf(v.data.database_specific?.severity),
        fixed,
        withdrawn: v.data.withdrawn !== undefined,
      };
      this.cache.put({ key, body: JSON.stringify(adv), at: this.now().toISOString() });
      return adv;
    } catch (err) {
      if (err instanceof Unavailable) return cached?.value;
      throw err;
    }
  }
}

/** Compares dotted numeric versions; letters after a number are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(/[.+-]/)
    .map((s) => Number.parseInt(s, 10));
  const pb = b
    .replace(/^v/, "")
    .split(/[.+-]/)
    .map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = Number.isNaN(pa[i] ?? 0) ? 0 : (pa[i] ?? 0);
    const y = Number.isNaN(pb[i] ?? 0) ? 0 : (pb[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The fixed version to name for an installed one: the lowest fix above it, else any fix. */
export function fixFor(
  adv: Advisory | undefined,
  p: Pick<Pkg, "ecosystem" | "name" | "version">,
): string | undefined {
  const list = adv?.fixed[`${p.ecosystem}\u0000${p.name}`];
  if (list === undefined || list.length === 0) return undefined;
  const above = list.filter((v) => compareVersions(v, p.version) > 0).sort(compareVersions);
  return above[0] ?? list.sort(compareVersions).at(-1);
}
