import type { CiState, MrState } from "@majhi/shared";
import { type Exec, runCli } from "./exec.ts";
import { firstLines } from "./github.ts";
import { type MrHostClient, MrHostError, type MrStatus, type MrTarget, scrub } from "./types.ts";

/** GitLab through the `glab` CLI, logged in with `GITLAB_TOKEN` for the call. */
export class GitLabHost implements MrHostClient {
  constructor(
    private readonly exec: Exec = runCli,
    private readonly bin = "glab",
  ) {}

  async open(t: MrTarget, mr: { head: string; base: string; title: string; body: string }) {
    const out = await this.glab(t, [
      "mr",
      "create",
      "--repo",
      t.slug,
      "--source-branch",
      mr.head,
      "--target-branch",
      mr.base,
      "--title",
      mr.title,
      "--description",
      mr.body,
      "--yes",
    ]);
    const url = out
      .split("\n")
      .reverse()
      .find((l) => /\/merge_requests\/\d+/.test(l))
      ?.trim();
    const number = url === undefined ? undefined : Number(/\/merge_requests\/(\d+)/.exec(url)?.[1]);
    if (url === undefined || number === undefined || Number.isNaN(number)) {
      throw new MrHostError("glab created a merge request but did not print its address.");
    }
    return { url: url.replace(/^.*?(https?:\/\/\S+).*$/, "$1"), number };
  }

  async updateDescription(t: MrTarget, number: number, mr: { title: string; body: string }) {
    await this.glab(t, ["mr", "update", String(number), "--repo", t.slug, "--description", mr.body]);
  }

  async status(t: MrTarget, number: number): Promise<MrStatus> {
    const out = await this.glab(t, ["mr", "view", String(number), "--repo", t.slug, "--output", "json"]);
    let data: {
      state?: string;
      web_url?: string;
      head_pipeline?: { status?: string } | null;
      pipeline?: { status?: string } | null;
    };
    try {
      data = JSON.parse(out) as typeof data;
    } catch {
      throw new MrHostError("glab answered with something that is not JSON.");
    }
    const pipeline = data.head_pipeline ?? data.pipeline;
    return { state: stateOf(data.state), ci: ciOf(pipeline?.status), url: data.web_url ?? "" };
  }

  async merge(t: MrTarget, number: number) {
    await this.glab(t, ["mr", "merge", String(number), "--repo", t.slug, "--yes"]);
  }

  private async glab(t: MrTarget, args: string[]): Promise<string> {
    const env: Record<string, string> = { NO_PROMPT: "1", NO_COLOR: "1" };
    if (t.token !== undefined) env.GITLAB_TOKEN = t.token;
    if (t.hostName !== undefined && t.hostName !== "gitlab.com") env.GITLAB_HOST = t.hostName;
    const res = await this.exec(this.bin, args, { env });
    if (res.code !== 0) {
      throw new MrHostError(
        `glab ${args.slice(0, 2).join(" ")} failed: ${scrub(firstLines(res.stderr || res.stdout), t.token)}`,
      );
    }
    return res.stdout;
  }
}

function stateOf(state: string | undefined): MrState {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

/** GitLab's pipeline status as one CI state. No pipeline is `none`. */
export function ciOf(status: string | null | undefined): CiState {
  if (status === undefined || status === null || status === "") return "none";
  if (status === "success") return "passing";
  if (status === "skipped") return "none";
  if (status === "failed" || status === "canceled" || status === "canceling") return "failing";
  return "pending";
}
