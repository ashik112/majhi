import type { CiState, MrState } from "@majhi/shared";
import { type Exec, runCli } from "./exec.ts";
import { type MrHostClient, MrHostError, type MrStatus, type MrTarget, scrub } from "./types.ts";

/** GitHub through the `gh` CLI, logged in with `GH_TOKEN` for the call. */
export class GitHubHost implements MrHostClient {
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
    return { state: stateOf(data.state), ci: ciOf(data.statusCheckRollup), url: data.url ?? "" };
  }

  async merge(t: MrTarget, number: number) {
    await this.gh(t, ["pr", "merge", String(number), "--repo", t.slug, "--merge"]);
  }

  private async gh(t: MrTarget, args: string[], input?: string): Promise<string> {
    const env: Record<string, string> = {
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    };
    if (t.token !== undefined) env.GH_TOKEN = t.token;
    if (t.hostName !== undefined && t.hostName !== "github.com") env.GH_HOST = t.hostName;
    const res = await this.exec(this.bin, args, { env, input });
    if (res.code !== 0) {
      throw new MrHostError(
        `gh ${args.slice(0, 2).join(" ")} failed: ${scrub(firstLines(res.stderr || res.stdout), t.token)}`,
      );
    }
    return res.stdout;
  }
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
