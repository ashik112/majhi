import type { CiState, MrReview, MrState } from "@majhi/shared";
import { EtagCache, type Exec, runCli, splitHttp } from "./exec.ts";
import { firstLines } from "./github.ts";
import { type MrHostClient, MrHostError, type MrStatus, type MrTarget, scrub } from "./types.ts";

/** GitLab through the `glab` CLI, logged in with `GITLAB_TOKEN` for the call. */
export class GitLabHost implements MrHostClient {
  private readonly etags = new EtagCache();

  constructor(
    private readonly exec: Exec = runCli,
    private readonly bin = "glab",
  ) {}

  async open(t: MrTarget, mr: { head: string; base: string; title: string; body: string }) {
    // The description goes in on stdin: `--description -` would open an editor, and a long one
    // does not belong on the command line.
    const out = await this.glab(
      t,
      [
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
        "--description-file",
        "-",
        "--yes",
      ],
      mr.body,
    );
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
    await this.glab(
      t,
      ["mr", "update", String(number), "--repo", t.slug, "--description-file", "-"],
      mr.body,
    );
  }

  async status(t: MrTarget, number: number): Promise<MrStatus> {
    const out = await this.glab(t, ["mr", "view", String(number), "--repo", t.slug, "--output", "json"]);
    let data: {
      state?: string;
      web_url?: string;
      head_pipeline?: { status?: string } | null;
      pipeline?: { status?: string } | null;
      reviewers?: { username?: string }[];
      blocking_discussions_resolved?: boolean | null;
    };
    try {
      data = JSON.parse(out) as typeof data;
    } catch {
      throw new MrHostError("glab answered with something that is not JSON.");
    }
    const pipeline = data.head_pipeline ?? data.pipeline;
    const state = stateOf(data.state);
    const review =
      state === "open"
        ? await this.approvals(t, number)
            .then((a) => gitlabReview(a, data))
            .catch(() => undefined)
        : undefined;
    return { state, ci: ciOf(pipeline?.status), url: data.web_url ?? "", ...(review ? { review } : {}) };
  }

  /** The approvals of the merge request: a GET that answers 304 while nothing changed. */
  private async approvals(t: MrTarget, number: number): Promise<unknown> {
    const path = `projects/${encodeURIComponent(t.slug)}/merge_requests/${number}/approvals`;
    const key = `${t.hostName ?? ""}|${path}`;
    const known = this.etags.get(key);
    const args = ["api", "-i"];
    if (known !== undefined) args.push("-H", `If-None-Match: ${known.etag}`);
    args.push(path);
    const res = await this.run(t, args);
    const http = splitHttp(res.stdout);
    if (http.status === 304 && known !== undefined) return known.value;
    if (res.code !== 0 || http.status < 200 || http.status >= 300) {
      throw new MrHostError(
        `glab api failed: ${scrub(firstLines([res.stderr, res.stdout].filter((s) => s.trim() !== "").join("\n")), t.token)}`,
      );
    }
    const value: unknown = JSON.parse(http.body);
    this.etags.set(key, http.etag, value);
    return value;
  }

  async merge(t: MrTarget, number: number) {
    // glab turns on auto-merge by default while a pipeline runs. majhi decides when to merge, so it
    // asks for the merge now.
    await this.glab(t, ["mr", "merge", String(number), "--repo", t.slug, "--yes", "--auto-merge=false"]);
  }

  private run(t: MrTarget, args: string[], input?: string) {
    const env: Record<string, string> = { GLAB_NO_PROMPT: "1", NO_COLOR: "1" };
    if (t.token !== undefined) env.GITLAB_TOKEN = t.token;
    if (t.hostName !== undefined && t.hostName !== "gitlab.com") env.GITLAB_HOST = t.hostName;
    return this.exec(this.bin, args, { env, input });
  }

  private async glab(t: MrTarget, args: string[], input?: string): Promise<string> {
    const res = await this.run(t, args, input);
    if (res.code !== 0) {
      throw new MrHostError(
        `glab ${args.slice(0, 2).join(" ")} failed: ${scrub(firstLines([res.stderr, res.stdout].filter((s) => s.trim() !== "").join("\n")), t.token)}`,
      );
    }
    return res.stdout;
  }
}

/**
 * GitLab's approvals answer and the merge request itself: approved as the host counts it, the
 * approvals still missing, reviewers asked who have not approved, and an unresolved blocking
 * discussion as changes requested.
 */
export function gitlabReview(
  approvals: unknown,
  mr: { reviewers?: { username?: string }[]; blocking_discussions_resolved?: boolean | null },
): MrReview {
  const a = approvals as {
    approved?: boolean;
    approvals_left?: number;
    approved_by?: { user?: { username?: string } }[];
  };
  const by = (a.approved_by ?? []).map((x) => x.user?.username).filter((n): n is string => n !== undefined);
  const pending = (mr.reviewers ?? [])
    .map((r) => r.username)
    .filter((n): n is string => n !== undefined && !by.includes(n));
  return {
    approved: a.approved === true,
    approvals: (a.approved_by ?? []).length,
    ...(typeof a.approvals_left === "number" ? { approvalsNeeded: a.approvals_left } : {}),
    changesRequested: mr.blocking_discussions_resolved === false,
    pending,
  };
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
