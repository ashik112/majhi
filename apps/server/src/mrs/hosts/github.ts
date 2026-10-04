import type { CiState, MrReview, MrState } from "@majhi/shared";
import { EtagCache, type Exec, runCli, splitHttp } from "./exec.ts";
import { type MrHostClient, MrHostError, type MrStatus, type MrTarget, scrub } from "./types.ts";

/** GitHub through the `gh` CLI, logged in with `GH_TOKEN` for the call. */
export class GitHubHost implements MrHostClient {
  private readonly etags = new EtagCache();

  constructor(
    private readonly exec: Exec = runCli,
    private readonly bin = "gh",
  ) {}

  async open(t: MrTarget, mr: { head: string; base: string; title: string; body: string }) {
    const out = await this.gh(
      t,
      [
        "pr",
        "create",
        "--repo",
        t.slug,
        "--head",
        mr.head,
        "--base",
        mr.base,
        "--title",
        mr.title,
        "--body-file",
        "-",
      ],
      mr.body,
    );
    const url = out
      .split("\n")
      .reverse()
      .find((l) => /\/pull\/\d+/.test(l))
      ?.trim();
    const number = url === undefined ? undefined : Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (url === undefined || number === undefined || Number.isNaN(number)) {
      throw new MrHostError("gh created a pull request but did not print its address.");
    }
    return { url, number };
  }

  async updateDescription(t: MrTarget, number: number, mr: { title: string; body: string }) {
    await this.gh(t, ["pr", "edit", String(number), "--repo", t.slug, "--body-file", "-"], mr.body);
  }

  async status(t: MrTarget, number: number): Promise<MrStatus> {
    const out = await this.gh(t, [
      "pr",
      "view",
      String(number),
      "--repo",
      t.slug,
      "--json",
      "state,url,statusCheckRollup",
    ]);
    let data: { state?: string; url?: string; statusCheckRollup?: unknown };
    try {
      data = JSON.parse(out) as typeof data;
    } catch {
      throw new MrHostError("gh answered with something that is not JSON.");
    }
    const state = stateOf(data.state);
    const review = state === "open" ? await this.review(t, number).catch(() => undefined) : undefined;
    return { state, ci: ciOf(data.statusCheckRollup), url: data.url ?? "", ...(review ? { review } : {}) };
  }

  /** The reviews and the asked reviewers: two GETs that answer 304 while nothing changed. */
  private async review(t: MrTarget, number: number): Promise<MrReview> {
    const base = `repos/${t.slug}/pulls/${number}`;
    const [reviews, pr] = await Promise.all([this.get(t, `${base}/reviews?per_page=100`), this.get(t, base)]);
    return githubReview(reviews, pr);
  }

  private async get(t: MrTarget, path: string): Promise<unknown> {
    const key = `${t.hostName ?? ""}|${path}`;
    const known = this.etags.get(key);
    const args = ["api", "-i", "-H", "Accept: application/vnd.github+json"];
    if (known !== undefined) args.push("-H", `If-None-Match: ${known.etag}`);
    args.push(path);
    const res = await this.run(t, args);
    const http = splitHttp(res.stdout);
    if (http.status === 304 && known !== undefined) return known.value;
    if (res.code !== 0 || http.status < 200 || http.status >= 300) {
      throw new MrHostError(`gh api failed: ${scrub(firstLines(res.stderr || res.stdout), t.token)}`);
    }
    const value: unknown = JSON.parse(http.body);
    this.etags.set(key, http.etag, value);
    return value;
  }

  async merge(t: MrTarget, number: number) {
    await this.gh(t, ["pr", "merge", String(number), "--repo", t.slug, "--merge"]);
  }

  private run(t: MrTarget, args: string[], input?: string) {
    const env: Record<string, string> = {
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    };
    if (t.token !== undefined) env.GH_TOKEN = t.token;
    if (t.hostName !== undefined && t.hostName !== "github.com") env.GH_HOST = t.hostName;
    return this.exec(this.bin, args, { env, input });
  }

  private async gh(t: MrTarget, args: string[], input?: string): Promise<string> {
    const res = await this.run(t, args, input);
    if (res.code !== 0) {
      throw new MrHostError(
        `gh ${args.slice(0, 2).join(" ")} failed: ${scrub(firstLines(res.stderr || res.stdout), t.token)}`,
      );
    }
    return res.stdout;
  }
}

/**
 * Reads GitHub's reviews (oldest first) and its pull request: the latest approval or change request
 * of each reviewer counts, a comment does not, a dismissal clears. Reviewers asked and not yet heard.
 */
export function githubReview(reviews: unknown, pr: unknown): MrReview {
  const latest = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  if (Array.isArray(reviews)) {
    for (const r of reviews as { user?: { login?: string } | null; state?: string }[]) {
      const who = r.user?.login;
      if (who === undefined) continue;
      if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latest.set(who, r.state);
      else if (r.state === "DISMISSED") latest.delete(who);
    }
  }
  const approvals = [...latest.values()].filter((s) => s === "APPROVED").length;
  const changesRequested = [...latest.values()].includes("CHANGES_REQUESTED");
  const asked = pr as { requested_reviewers?: { login?: string }[]; requested_teams?: { slug?: string }[] };
  const pending = [
    ...(asked.requested_reviewers ?? []).map((u) => u.login),
    ...(asked.requested_teams ?? []).map((x) => x.slug),
  ].filter((n): n is string => typeof n === "string");
  return { approved: approvals > 0 && !changesRequested, approvals, changesRequested, pending };
}

function stateOf(state: string | undefined): MrState {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** Reduces the checks and statuses of a pull request to one state. Empty is `none`. */
export function ciOf(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const item of rollup as Record<string, unknown>[]) {
    // A check run has status and conclusion; a commit status has state.
    const result = String(item.conclusion || item.state || "").toUpperCase();
    if (FAILED.has(result)) return "failing";
    if (!PASSED.has(result)) pending = true;
  }
  return pending ? "pending" : "passing";
}

export function firstLines(text: string): string {
  return text.trim().split("\n").slice(0, 3).join(" ").slice(0, 400);
}
