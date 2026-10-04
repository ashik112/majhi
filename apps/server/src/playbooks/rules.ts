import type { Playbook } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { FindingsService } from "../findings/service.ts";

/**
 * The playbooks that run as code and need no model (cost tier "rules"). A run reads what the owner
 * listed, files findings through the findings store and reports how many it filed. What it reads is
 * data: a response body is never looked at, only the status, and nothing it reads is an instruction.
 */

export interface RulesContext {
  org: string;
  playbook: Playbook;
  /** What the owner filled in, one list of lines per setting. */
  settings: Readonly<Record<string, readonly string[]>>;
  findings: FindingsService;
  now: () => Date;
  fetch: typeof fetch;
  /** The owner pressed Run now: a playbook that skips a repeat within its period runs anyway. */
  manual?: boolean;
}

export interface RulesResult {
  /** Findings it filed or refreshed. */
  findings: number;
  /** One line for the history; empty when nothing happened. */
  note: string;
  /** Tokens a model spent in the run, estimated. Absent for code. */
  tokens?: number;
  /** Something to wake the captain with, when a finding is news. The findings store wakes it already. */
}

export interface RulesRunner {
  run(ctx: RulesContext): Promise<RulesResult>;
  /** A problem with the owner's settings, or undefined. */
  check?(settings: Readonly<Record<string, readonly string[]>>): string | undefined;
}

const TIMEOUT_MS = 10_000;
/** A URL must fail this many checks in a row before it is an incident. */
export const FAILS_BEFORE_INCIDENT = 2;

/** An http or https URL, or a problem. Nothing else is fetched. */
export function urlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a URL.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `"${raw}" is not an http or https address.`;
  }
  if (url.username !== "" || url.password !== "") {
    return "Leave the sign-in out of the URL. A password does not belong in a check.";
  }
  return undefined;
}

/** The URL key a finding is deduplicated by. */
export function incidentKey(url: string): string {
  return `uptime:${url}`;
}

/** Consecutive failures per workspace and URL. In memory: a restart starts counting again. */
const failures = new Map<string, number>();

const uptime: RulesRunner = {
  check(settings) {
    for (const raw of settings.urls ?? []) {
      const bad = urlProblem(raw);
      if (bad !== undefined) return bad;
    }
    return undefined;
  },
  async run(ctx) {
    const urls = [...new Set(ctx.settings.urls ?? [])]
      .filter((u) => urlProblem(u) === undefined)
      .slice(0, 20);
    let filed = 0;
    const down: string[] = [];
    for (const url of urls) {
      const key = `${ctx.org}\u0000${url}`;
      const outcome = await probe(ctx.fetch, url);
      if (outcome.up) {
        failures.delete(key);
        const open = ctx.findings.find(ctx.org, incidentKey(url));
        if (open !== undefined && open.status !== "fixed" && open.status !== "dismissed") {
          ctx.findings.update({ id: open.id, status: "fixed" }, { kind: "captain", org: ctx.org });
          filed += 1;
        }
        continue;
      }
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      down.push(url);
      if (count < FAILS_BEFORE_INCIDENT) continue;
      await ctx.findings.report(
        {
          org: ctx.org,
          source: "incident",
          title: `${url} is down`,
          detail: `${url} failed ${count} checks in a row. Last answer: ${outcome.why}.`,
          evidence: [`${url}: ${outcome.why}`],
          severity: "high",
          playbook: ctx.playbook.id,
          dedupeKey: incidentKey(url),
        },
        { kind: "captain", org: ctx.org },
      );
      filed += 1;
    }
    if (urls.length === 0) return { findings: 0, note: "No URL to check" };
    return {
      findings: filed,
      note: down.length === 0 ? `${urls.length} up` : `${down.length} of ${urls.length} down`,
    };
  },
};

async function probe(doFetch: typeof fetch, url: string): Promise<{ up: true } | { up: false; why: string }> {
  try {
    const res = await doFetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The body is never read: only the status matters.
    void res.body?.cancel().catch(() => undefined);
    return res.status < 400 ? { up: true } : { up: false, why: `status ${res.status}` };
  } catch (err) {
    return { up: false, why: errorMessage(err).slice(0, 160) };
  }
}

/** Clears the counts: for tests. */
export function resetUptimeCounts(): void {
  failures.clear();
}

export const RULES_RUNNERS: Readonly<Record<string, RulesRunner>> = { uptime };
