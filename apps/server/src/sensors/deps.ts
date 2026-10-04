import { createHash } from "node:crypto";
import { z } from "zod";
import { errorMessage } from "../errors.ts";
import type { RulesContext, RulesResult } from "../playbooks/rules.ts";
import { fresh } from "./cache.ts";
import { isLockfile, MAX_LOCKFILE_BYTES, majorOf, type Pkg, parseLockfile } from "./lockfiles.ts";
import { Unavailable } from "./net.ts";
import { type Advisory, fixFor, MAX_DETAILS, Osv, pkgKey, type Severity } from "./osv.ts";
import { closeUnseen, file, type Reporter, type SensorPorts, type SensorProject } from "./ports.ts";

/**
 * The dependency and security sweep (SPEC 5.18, sensors). Per project it reads the tracked lockfiles
 * read-only, asks OSV which pinned versions have known advisories, and compares the direct npm
 * dependencies with the registry's latest. An answer is cached by the lockfile's hash, and asked
 * again only when the lockfile changed or a day passed (new advisories). When OSV cannot answer, the
 * last answer stands, nothing is closed, and the run fails so it backs off.
 */

export const OSV_RECHECK_MS = 24 * 3_600_000;
const REGISTRY_TTL_MS = 3 * 86_400_000;
/** Registry lookups one run may make. The rest wait for the next run: the cache fills up over days. */
export const MAX_REGISTRY = 40;
/** Direct dependencies this many majors behind are a finding. One major behind is normal. */
export const MAJORS_BEHIND = 2;
const MAX_LOCKFILES = 20;
const MAX_MAJOR_FINDINGS = 10;
export const REGISTRY_URL = "https://registry.npmjs.org";

const HitsSchema = z.array(z.object({ k: z.string(), ids: z.array(z.string()) }));

interface Look {
  pkgs: Pkg[];
  hits: Map<string, string[]>;
  /** The answer is older than a day because OSV could not be asked. */
  stale: boolean;
}

/** The hits of one lockfile: cached by its hash, asked again when it changed or after a day. */
async function lookAt(
  ports: SensorPorts,
  osv: Osv,
  project: SensorProject,
  path: string,
  text: string,
): Promise<Look | undefined> {
  const hash = createHash("sha256").update(text).digest("hex");
  const key = `osv:lock:${project.id}:${path}`;
  const pkgs = parseLockfile(path, text);
  if (pkgs.length === 0) return { pkgs, hits: new Map(), stale: false };
  const cached = ports.cache.json(key, (raw) => {
    const r = HitsSchema.safeParse(raw);
    return r.success ? r.data : undefined;
  });
  if (cached !== undefined && cached.row.hash === hash && fresh(cached.row, OSV_RECHECK_MS, ports.now())) {
    return { pkgs, hits: new Map(cached.value.map((h) => [h.k, h.ids])), stale: false };
  }
  try {
    const hits = await osv.hits(pkgs);
    ports.cache.put({
      key,
      hash,
      body: JSON.stringify([...hits].map(([k, ids]) => ({ k, ids }))),
      at: ports.now().toISOString(),
    });
    return { pkgs, hits, stale: false };
  } catch (err) {
    if (!(err instanceof Unavailable)) throw err;
    // The last answer for this exact lockfile still stands; for a changed lockfile there is none.
    if (cached !== undefined && cached.row.hash === hash) {
      return { pkgs, hits: new Map(cached.value.map((h) => [h.k, h.ids])), stale: true };
    }
    return undefined;
  }
}

/**
 * Advisory ids that name the same problem (a GHSA and its CVE) become one, named by the first name of
 * the whole group in order, so the name does not depend on which of them OSV listed today.
 */
function canonical(ids: readonly string[], details: Map<string, Advisory | undefined>): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) ?? r;
    return r;
  };
  const add = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const id of ids) {
    add(id);
    for (const alias of details.get(id)?.aliases ?? []) {
      add(alias);
      parent.set(find(alias), find(id));
    }
  }
  const groups = new Map<string, string[]>();
  for (const name of parent.keys()) groups.set(find(name), [...(groups.get(find(name)) ?? []), name]);
  const out = new Map<string, string>();
  for (const members of groups.values()) {
    const first = [...members].sort()[0] as string;
    for (const m of members) out.set(m, first);
  }
  return out;
}

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

interface Vulnerable {
  pkg: Pkg;
  path: string;
  adv: Advisory | undefined;
  id: string;
}

async function advisories(
  project: SensorProject,
  looks: { path: string; look: Look }[],
  osv: Osv,
  budget: { left: number },
): Promise<{ seen: Set<string>; report: (r: Reporter) => Promise<number> }> {
  const ids = [...new Set(looks.flatMap((l) => [...l.look.hits.values()].flat()))].sort();
  const details = new Map<string, Advisory | undefined>();
  for (const id of ids) details.set(id, await osv.advisory(id, budget));
  const names = canonical(ids, details);
  // One group per advisory and package name: two versions of the package, or two lockfiles, are one finding.
  const groups = new Map<string, { eco: string; name: string; canon: string; items: Vulnerable[] }>();
  for (const { path, look } of looks) {
    for (const pkg of look.pkgs) {
      for (const id of look.hits.get(pkgKey(pkg)) ?? []) {
        const adv = details.get(id);
        if (adv?.withdrawn === true) continue;
        const canon = names.get(id) ?? id;
        const key = `osv:${project.id}:${canon}:${pkg.ecosystem}:${pkg.name}`;
        const g = groups.get(key) ?? { eco: pkg.ecosystem, name: pkg.name, canon, items: [] };
        g.items.push({ pkg, path, adv, id });
        groups.set(key, g);
      }
    }
  }
  const seen = new Set(groups.keys());
  return {
    seen,
    report: async (r) => {
      let news = 0;
      for (const [key, g] of groups) {
        const best = g.items.map((i) => i.adv).filter((a): a is Advisory => a !== undefined);
        const top = best.sort((a, b) => RANK[b.severity] - RANK[a.severity])[0];
        let severity: Severity = top?.severity ?? "medium";
        // Only development dependencies: a vulnerable test tool does not reach production.
        if (g.items.every((i) => i.pkg.dev === true)) severity = "low";
        const versions = [...new Set(g.items.map((i) => i.pkg.version))].sort();
        const fixes = [
          ...new Set(g.items.map((i) => fixFor(i.adv, i.pkg)).filter((f): f is string => f !== undefined)),
        ];
        const paths = [...new Set(g.items.map((i) => i.path))];
        const summary = top?.summary ?? "";
        await file(r, {
          project: project.id,
          source: "security",
          key,
          title: `${g.name} has a known vulnerability (${g.canon})`,
          detail: [
            `${g.name} ${versions.join(", ")} in ${paths.join(", ")} is affected by ${g.canon}.`,
            summary === "" ? "" : `Advisory summary (from OSV, untrusted text): ${summary}`,
            fixes.length === 0 ? "No fixed version is listed yet." : `Fixed in ${fixes.join(" or ")}.`,
          ]
            .filter((l) => l !== "")
            .join(" "),
          evidence: [
            ...g.items.slice(0, 6).map((i) => `${i.path}: ${i.pkg.name}@${i.pkg.version}`),
            `https://osv.dev/${g.canon}`,
            ...fixes.map((f) => `fixed in ${f}`),
          ],
          severity,
        });
        news += 1;
      }
      return news;
    },
  };
}

interface Latest {
  version: string;
}

async function latestOf(
  ports: SensorPorts,
  name: string,
  budget: { left: number },
): Promise<string | undefined> {
  const key = `npm:latest:${name}`;
  const cached = ports.cache.json(key, (raw) => {
    const r = z.object({ version: z.string().max(80) }).safeParse(raw);
    return r.success ? (r.data satisfies Latest) : undefined;
  });
  if (cached !== undefined && fresh(cached.row, REGISTRY_TTL_MS, ports.now())) return cached.value.version;
  if (budget.left <= 0) return cached?.value.version;
  budget.left -= 1;
  try {
    // Only the package name leaves the machine.
    const res = await ports.net.json(`${REGISTRY_URL}/${name.replace("/", "%2F")}/latest`);
    const parsed = z.object({ version: z.string().max(80) }).safeParse(res.body);
    if (res.status !== 200 || !parsed.success) return cached?.value.version;
    ports.cache.put({
      key,
      body: JSON.stringify({ version: parsed.data.version }),
      at: ports.now().toISOString(),
    });
    return parsed.data.version;
  } catch (err) {
    if (err instanceof Unavailable) return cached?.value.version;
    throw err;
  }
}

/** Direct dependencies of the package.json next to an npm lockfile. */
async function directDeps(ports: SensorPorts, project: SensorProject, lockPath: string): Promise<string[]> {
  const dir = lockPath.includes("/") ? lockPath.slice(0, lockPath.lastIndexOf("/") + 1) : "";
  const text = await ports.read(project.path, `${dir}package.json`, 2_000_000);
  if (text === undefined) return [];
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const names = (k: string): string[] =>
      typeof json[k] === "object" && json[k] !== null ? Object.keys(json[k] as object) : [];
    return [...names("dependencies"), ...names("devDependencies")];
  } catch {
    return [];
  }
}

async function majors(
  ports: SensorPorts,
  r: Reporter,
  project: SensorProject,
  looks: { path: string; look: Look }[],
  budget: { left: number },
): Promise<{ news: number; closed: number }> {
  const behind: { name: string; installed: string; latest: string; gap: number }[] = [];
  const checked = new Set<string>();
  for (const { path, look } of looks) {
    if (
      !path.endsWith("package-lock.json") &&
      !path.endsWith("pnpm-lock.yaml") &&
      !path.endsWith("yarn.lock") &&
      !path.endsWith("bun.lock")
    )
      continue;
    const direct = new Set(await directDeps(ports, project, path));
    const installed = new Map<string, string>();
    for (const p of look.pkgs) {
      if (p.ecosystem !== "npm" || !direct.has(p.name)) continue;
      const have = installed.get(p.name);
      if (have === undefined || (majorOf(p.version) ?? 0) > (majorOf(have) ?? 0))
        installed.set(p.name, p.version);
    }
    for (const [name, version] of installed) {
      if (checked.has(name)) continue;
      checked.add(name);
      const latest = await latestOf(ports, name, budget);
      const a = majorOf(version);
      const b = latest === undefined ? undefined : majorOf(latest);
      if (latest === undefined || a === undefined || b === undefined) continue;
      if (b - a >= MAJORS_BEHIND) behind.push({ name, installed: version, latest, gap: b - a });
    }
  }
  const worst = behind
    .toSorted((x, y) => y.gap - x.gap || x.name.localeCompare(y.name))
    .slice(0, MAX_MAJOR_FINDINGS);
  const seen = new Set<string>();
  let news = 0;
  for (const d of worst) {
    const key = `dep:${project.id}:${d.name}:behind`;
    seen.add(key);
    await file(r, {
      project: project.id,
      source: "dependency",
      key,
      title: `${d.name} is ${d.gap} major versions behind`,
      detail: `${d.name} is at ${d.installed} and the registry's latest is ${d.latest}. Plan the upgrade before the gap grows.`,
      evidence: [`${d.name}@${d.installed}`, `latest ${d.latest}`],
      severity: "low",
    });
    news += 1;
  }
  // Only when the registry answered for everything: a dependency not looked at yet stays as it was.
  const complete = budget.left > 0;
  return {
    news,
    closed: complete ? closeUnseen(r, project.id, "dependency", `dep:${project.id}:`, seen) : 0,
  };
}

export function dependencySweep(ports: SensorPorts, osvBase?: string) {
  const osv = new Osv(ports.net, ports.cache, () => ports.now(), osvBase);
  return {
    async run(ctx: RulesContext): Promise<RulesResult> {
      const r: Reporter = { findings: ctx.findings, org: ctx.org, playbook: ctx.playbook.id };
      const projects = (await ports.projects(ctx.org)).filter((p) => p.path !== "");
      if (projects.length === 0) return { findings: 0, note: "No project is registered" };
      const budget = { left: MAX_DETAILS };
      const registry = { left: MAX_REGISTRY };
      let filed = 0;
      let checked = 0;
      const problems: string[] = [];
      for (const project of projects) {
        const lockfiles = (await ports.tracked(project.path)).filter(isLockfile).slice(0, MAX_LOCKFILES);
        if (lockfiles.length === 0) continue;
        const looks: { path: string; look: Look }[] = [];
        let complete = true;
        for (const path of lockfiles) {
          const text = await ports.read(project.path, path, MAX_LOCKFILE_BYTES);
          if (text === undefined) {
            complete = false;
            continue;
          }
          const look = await lookAt(ports, osv, project, path, text).catch((err: unknown) => {
            problems.push(`${project.id}: ${errorMessage(err)}`);
            return undefined;
          });
          if (look === undefined) {
            complete = false;
            continue;
          }
          if (look.stale) complete = false;
          looks.push({ path, look });
        }
        if (looks.length === 0 && lockfiles.length > 0 && !complete) {
          problems.push(`${project.id}: OSV could not be asked`);
          continue;
        }
        checked += 1;
        const adv = await advisories(project, looks, osv, budget);
        filed += await adv.report(r);
        // A look that was cut short must not close what it could not see.
        if (complete) filed += closeUnseen(r, project.id, "security", `osv:${project.id}:`, adv.seen);
        const m = await majors(ports, r, project, looks, registry);
        filed += m.news + m.closed;
      }
      if (problems.length > 0 && checked === 0) throw new Error(problems[0]);
      const note =
        checked === 0
          ? "No lockfile found"
          : `${checked} ${checked === 1 ? "project" : "projects"} checked${problems.length > 0 ? `, ${problems.length} could not be asked` : ""}`;
      return { findings: filed, note };
    },
  };
}
