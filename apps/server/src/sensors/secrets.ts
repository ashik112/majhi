import { createHash } from "node:crypto";
import { detectSecrets } from "@majhi/shared";
import type { RulesContext, RulesResult } from "../playbooks/rules.ts";
import { fresh } from "./cache.ts";
import { closeUnseen, file, type Reporter, type SensorPorts, type SensorProject } from "./ports.ts";

/**
 * The secret scan (SPEC 5.18, sensors): the tracked files of each checkout, read-only, through the same
 * detector that keeps secrets out of memory (`detectSecrets`). A finding names the file, the kind of
 * secret and the line numbers. The value is never stored, logged or sent anywhere: only its position
 * leaves the detector. A scan repeats only when the checkout changed or a week passed.
 */

const MAX_BYTES = 200_000;
export const MAX_FILES = 5_000;
export const MAX_TOTAL_BYTES = 60_000_000;
const RESCAN_MS = 7 * 86_400_000;

/** Files that are noise for this scan: lockfiles hold integrity hashes, the rest is built or binary. */
const SKIP =
  /(^|\/)(node_modules|vendor|dist|build|\.git)\/|\.(lock|lockb|min\.js|min\.css|map|png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mov|wasm|snap)$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$/i;

export interface SecretHit {
  path: string;
  kind: string;
  /** 1-based, ascending. */
  lines: number[];
}

/** Secrets in one file's text: kinds and line numbers only. */
export function secretsIn(path: string, text: string): SecretHit[] {
  const matches = detectSecrets(text);
  if (matches.length === 0) return [];
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const byKind = new Map<string, Set<number>>();
  for (const m of matches) byKind.set(m.kind, (byKind.get(m.kind) ?? new Set<number>()).add(lineOf(m.start)));
  return [...byKind].map(([kind, lines]) => ({
    path,
    kind,
    lines: [...lines].sort((a, b) => a - b).slice(0, 20),
  }));
}

async function scan(ports: SensorPorts, project: SensorProject): Promise<SecretHit[]> {
  const files = (await ports.tracked(project.path)).filter((p) => !SKIP.test(p)).slice(0, MAX_FILES);
  const hits: SecretHit[] = [];
  let total = 0;
  for (const rel of files) {
    if (total > MAX_TOTAL_BYTES) break;
    const text = await ports.read(project.path, rel, MAX_BYTES);
    if (text === undefined) continue;
    total += text.length;
    hits.push(...secretsIn(rel, text));
  }
  return hits;
}

export function secretScan(ports: SensorPorts) {
  return {
    async run(ctx: RulesContext): Promise<RulesResult> {
      const r: Reporter = { findings: ctx.findings, org: ctx.org, playbook: ctx.playbook.id };
      const projects = await ports.projects(ctx.org);
      if (projects.length === 0) return { findings: 0, note: "No project is registered" };
      let filed = 0;
      let scanned = 0;
      for (const project of projects) {
        const print = await ports.fingerprint(project.path);
        const key = `secrets:${project.id}`;
        const last = ports.cache.get(key);
        const hash = print === undefined ? undefined : createHash("sha256").update(print).digest("hex");
        if (hash !== undefined && last?.hash === hash && fresh(last, RESCAN_MS, ports.now())) continue;
        const hits = await scan(ports, project);
        scanned += 1;
        const seen = new Set<string>();
        for (const h of hits) {
          const k = `secret:${project.id}:${h.path}:${h.kind}`;
          seen.add(k);
          await file(r, {
            project: project.id,
            source: "security",
            key: k,
            title: `A ${h.kind === "token" ? "token or key" : `${h.kind} secret`} is committed in ${h.path}`,
            detail: `${h.path} holds what looks like a ${h.kind} secret at line ${h.lines.join(", ")}. The value is not shown or stored. Treat it as leaked: rotate it, then remove it from the code.`,
            evidence: h.lines.map((n) => `${h.path}:${n}`),
            severity: "high",
          });
          filed += 1;
        }
        filed += closeUnseen(r, project.id, "security", `secret:${project.id}:`, seen);
        ports.cache.put({
          key,
          ...(hash === undefined ? {} : { hash }),
          body: String(hits.length),
          at: ports.now().toISOString(),
        });
      }
      return {
        findings: filed,
        note: scanned === 0 ? "Nothing changed since the last scan" : `${scanned} checked`,
      };
    },
  };
}
