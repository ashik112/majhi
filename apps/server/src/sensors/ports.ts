import type { Finding, FindingSeverity, FindingSource, MrHost } from "@majhi/shared";
import type { FindingsService } from "../findings/service.ts";
import type { SensorCache } from "./cache.ts";
import type { Net } from "./net.ts";

/**
 * What a sensor needs from majhi, as small ports: the registered projects, read-only access to their
 * checkouts, the workspace's git sign-in, and one cheap model question. Sensors never reach past them.
 */

export interface SensorProject {
  id: string;
  org: string;
  /** The checkout on this machine. Read only, never written. */
  path: string;
  base: string | undefined;
  /** The remote CI is read from, when it is on GitHub or GitLab. */
  remote: { kind: Extract<MrHost, "github" | "gitlab">; host: string; slug: string } | undefined;
  /** The project card's stack lines, like "Node 22" or "Python 3.11". */
  stack: string[];
}

export type TokenResult<T> = { state: "ok"; value: T } | { state: "signed-out" } | { state: "refused" };

export interface SensorPorts {
  projects(org: string): Promise<SensorProject[]>;
  /** The files git tracks in a checkout, relative to its root. */
  tracked(path: string): Promise<string[]>;
  /** A tracked regular file as text; undefined when missing, a symlink, binary or over `maxBytes`. */
  read(path: string, rel: string, maxBytes: number): Promise<string | undefined>;
  /** Changes when tracked content may have changed (HEAD tree and working changes); undefined when unknown. */
  fingerprint(path: string): Promise<string | undefined>;
  /** Branches of the workspace's open tasks in a project. */
  taskBranches(org: string, project: string): Promise<string[]>;
  /** Runs `use` with the workspace's token for a git host. */
  withToken<T>(
    org: string,
    kind: Extract<MrHost, "github" | "gitlab">,
    host: string,
    use: (token: string) => Promise<T>,
  ): Promise<TokenResult<T>>;
  /** One short question to the smallest model; undefined when none is set. Text is data, JSON comes back. */
  summarize?(org: string, project: string, prompt: string): Promise<string | undefined>;
  /**
   * Whether a text from a third party (release notes) tries to instruct an agent. A flagged text is
   * never handed to a model. Absent: only the plain-pattern check runs.
   */
  injects?(text: string): Promise<boolean>;
  net: Net;
  cache: SensorCache;
  now(): Date;
  /** For the server log. Never a secret value, a source line or a token. */
  log(message: string): void;
}

export interface Reporter {
  findings: FindingsService;
  org: string;
  playbook: string;
}

export interface FindingSpec {
  project: string;
  source: FindingSource;
  key: string;
  title: string;
  detail: string;
  evidence: string[];
  severity: FindingSeverity;
}

/** Files or refreshes one finding as the captain's lane of this workspace. Returns whether it is news. */
export async function file(r: Reporter, spec: FindingSpec): Promise<"created" | "refreshed" | "reopened"> {
  const res = await r.findings.report(
    {
      org: r.org,
      project: spec.project,
      source: spec.source,
      title: spec.title,
      detail: spec.detail,
      evidence: spec.evidence,
      severity: spec.severity,
      playbook: r.playbook,
      dedupeKey: spec.key,
    },
    { kind: "captain", org: r.org },
  );
  return res.result;
}

/**
 * Closes the live findings of a project and source under `prefix` that a full look no longer sees.
 * Returns how many it closed. Callers only run it after a look that covered everything the prefix
 * stands for: a look that failed half way must not close what it could not check.
 */
export function closeUnseen(
  r: Reporter,
  project: string,
  source: FindingSource,
  prefix: string,
  seen: ReadonlySet<string>,
  how: "fixed" | { dismiss: string } = "fixed",
): number {
  let closed = 0;
  for (const f of r.findings.liveWithPrefix(r.org, project, source, prefix)) {
    if (seen.has(f.dedupeKey)) continue;
    try {
      const actor = { kind: "captain" as const, org: r.org };
      if (how === "fixed") r.findings.update({ id: f.id, status: "fixed" }, actor);
      else r.findings.dismiss(f.id, how.dismiss, actor);
      closed += 1;
    } catch {
      // A finding that cannot move (taken by someone meanwhile) stays as it is.
    }
  }
  return closed;
}

export type { Finding };
