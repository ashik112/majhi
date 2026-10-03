import type { TrackerConfig, TrackerItem, TrackerTestResult } from "@majhi/shared";
import { z } from "zod";
import { fitItem, parse, request } from "./http.ts";
import { type TrackerAdapter, type TrackerAdapterInit, TrackerError } from "./types.ts";

type GitHubConfig = Extract<TrackerConfig, { type: "github" }>;

const API = "https://api.github.com";

const IssueSchema = z.looseObject({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
  state: z.string(),
  assignee: z.looseObject({ login: z.string() }).nullish(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string().nullish() })])).nullish(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});
type Issue = z.infer<typeof IssueSchema>;

const IssuesSchema = z.array(IssueSchema);
const UserSchema = z.looseObject({ login: z.string() });
const RepoSchema = z.looseObject({ full_name: z.string(), has_issues: z.boolean().optional() });

/** GitHub Issues through the REST API. Open and closed are its only statuses. */
export class GitHubIssuesAdapter implements TrackerAdapter {
  private readonly repo: string;

  constructor(private readonly init: TrackerAdapterInit<GitHubConfig>) {
    this.repo = init.config.repo.split("/").map(encodeURIComponent).join("/");
  }

  async pull(opts: { assignedToMe: boolean }): Promise<TrackerItem[]> {
    let query = "state=open&per_page=100&sort=updated";
    if (opts.assignedToMe) query += `&assignee=${encodeURIComponent((await this.user()).login)}`;
    const issues = parse(
      IssuesSchema,
      await this.call(`/repos/${this.repo}/issues?${query}`),
      "the GitHub issues",
    );
    // The issues list also returns pull requests. They are not tracker items.
    return issues.filter((issue) => issue.pull_request === undefined).map(item);
  }

  async get(key: string): Promise<TrackerItem> {
    return item(await this.issue(key));
  }

  async comment(key: string, text: string): Promise<void> {
    await this.call(`/repos/${this.repo}/issues/${number(key)}/comments`, "POST", { body: text });
  }

  async setStatus(key: string, status: string): Promise<void> {
    const wanted = status.trim().toLowerCase();
    if (wanted !== "open" && wanted !== "closed")
      throw new TrackerError("GitHub Issues only has open and closed");
    const issue = await this.issue(key);
    if (issue.state === wanted) return;
    const body = wanted === "closed" ? { state: "closed", state_reason: "completed" } : { state: "open" };
    await this.call(`/repos/${this.repo}/issues/${number(key)}`, "PATCH", body);
  }

  async link(key: string, url: string, title: string): Promise<void> {
    await this.comment(key, `${title}: ${url}`);
  }

  async create(input: { title: string; body: string }): Promise<TrackerItem> {
    const data = await this.call(`/repos/${this.repo}/issues`, "POST", {
      title: input.title,
      body: input.body,
    });
    return item(parse(IssueSchema, data, "the new GitHub issue"));
  }

  async test(): Promise<TrackerTestResult> {
    try {
      const user = await this.user();
      const repo = parse(RepoSchema, await this.call(`/repos/${this.repo}`), "the GitHub repository");
      if (repo.has_issues === false) {
        return {
          ok: false,
          detail: `Issues are turned off on ${repo.full_name}. Turn them on in its settings.`,
        };
      }
      return { ok: true, detail: `Signed in as ${user.login}, repo ${repo.full_name}` };
    } catch (err) {
      if (err instanceof TrackerError) return { ok: false, detail: err.message };
      throw err;
    }
  }

  private async user() {
    return parse(UserSchema, await this.call("/user"), "the GitHub account");
  }

  private async issue(key: string): Promise<Issue> {
    return parse(
      IssueSchema,
      await this.call(`/repos/${this.repo}/issues/${number(key)}`),
      `GitHub issue ${key}`,
    );
  }

  private call(path: string, method: "GET" | "POST" | "PATCH" = "GET", body?: unknown): Promise<unknown> {
    return request(this.init, `${API}${path}`, {
      method,
      body,
      headers: {
        Authorization: `Bearer ${this.init.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "majhi",
      },
    });
  }
}

/** An issue key is its number. Anything else never reaches a URL. */
function number(key: string): string {
  if (!/^\d+$/.test(key)) throw new TrackerError(`"${key}" is not a GitHub issue number.`);
  return key;
}

function item(issue: Issue): TrackerItem {
  const assignee = issue.assignee?.login;
  return fitItem({
    key: String(issue.number),
    title: issue.title,
    body: issue.body ?? "",
    url: issue.html_url,
    status: issue.state,
    closed: issue.state === "closed",
    ...(assignee === undefined ? {} : { assignee }),
    labels: (issue.labels ?? []).flatMap((label) => {
      const name = typeof label === "string" ? label : label.name;
      return name ? [name] : [];
    }),
    updatedAt: issue.updated_at,
  });
}
