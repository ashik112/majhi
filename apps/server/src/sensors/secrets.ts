import { createHash } from "node:crypto";
import { detectSecrets } from "@majhi/shared";
import type { RulesContext, RulesResult } from "../playbooks/rules.ts";
import { fresh } from "./cache.ts";
import {
  closeUnseen,
  file,
  type Reporter,
  reporterOf,
  type SensorPorts,
  type SensorProject,
} from "./ports.ts";

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

/** Files that are noise for this scan: lockfiles hold integrity hashes, the rest is built, vendored or binary. */
const SKIP =
  /(^|\/)(node_modules|vendor|dist|build|\.git|staticfiles|third_party|bower_components)\/|\.(lock|lockb|min\.js|min\.css|map|png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mov|wasm|snap)$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$/i;

/**
 * Kinds a provider's own format proves (a private key block, an AWS key id, a GitHub token): very
 * likely real. The rest (`assigned`, `token`, `jwt`) come from heuristics and are often sample values.
 */
const STRONG = new Set(["private-key", "anthropic", "openai", "github", "gitlab", "slack", "aws"]);

/** How many file:line entries one finding lists; the count in the title covers the rest. */
const EVIDENCE_MAX = 20;

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
      const r = reporterOf(ctx);
      const projects = await ports.projects(ctx.org);
      if (projects.length === 0) return { findings: 0, note: "No project is registered" };
      let filed = 0;
      let scanned = 0;
      for (const project of projects) {
        const print = await ports.fingerprint(project.path);
        const key = `secrets-scan:${project.id}`;
        const last = ports.cache.get(key);
        const hash = print === undefined ? undefined : createHash("sha256").update(print).digest("hex");
        if (hash !== undefined && last?.hash === hash && fresh(last, RESCAN_MS, ports.now())) continue;
        const hits = await scan(ports, project);
        scanned += 1;
        const seen = new Set<string>();
        // One finding per project and strength, not one per file: a repo with config maps full of
        // keys is one thing to fix, and hundreds of findings bury everything else.
        for (const strong of [true, false]) {
          const group = hits.filter((h) => STRONG.has(h.kind) === strong);
          if (group.length === 0) continue;
          const k = `secrets:${project.id}:${strong ? "strong" : "likely"}`;
          seen.add(k);
          const files = new Set(group.map((h) => h.path));
          const kinds = [...new Set(group.map((h) => (h.kind === "token" ? "token or key" : h.kind)))].sort();
          const evidence = group.flatMap((h) => h.lines.map((n) => `${h.path}:${n} (${h.kind})`));
          await file(r, {
            project: project.id,
            source: "security",
            key: k,
            title: strong
              ? `Committed secrets in ${project.id}: ${files.size} ${files.size === 1 ? "file" : "files"} (${kinds.join(", ")})`
              : `Possible secrets in ${project.id}: ${files.size} ${files.size === 1 ? "file" : "files"} (${kinds.join(", ")})`,
            detail: strong
              ? `These files hold values in a provider's own key format. The values are not shown or stored. Treat them as leaked: rotate them, then move them out of the code.${evidence.length > EVIDENCE_MAX ? ` ${evidence.length - EVIDENCE_MAX} more places are not listed.` : ""}`
              : `These files assign values that look like secrets. Some may be samples or placeholders. Check them, rotate any that are real, then move them out of the code.${evidence.length > EVIDENCE_MAX ? ` ${evidence.length - EVIDENCE_MAX} more places are not listed.` : ""}`,
            evidence: evidence.slice(0, EVIDENCE_MAX),
            severity: strong ? "high" : "medium",
          });
          filed += 1;
        }
        filed += closeUnseen(r, project.id, "security", `secrets:${project.id}:`, seen);
        // Findings from before grouping (one per file and kind) fold into the grouped ones.
        filed += closeUnseen(r, project.id, "security", `secret:${project.id}:`, new Set(), {
          dismiss: "Folded into one finding per project",
        });
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
