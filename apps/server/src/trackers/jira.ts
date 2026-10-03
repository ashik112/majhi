import type { TrackerConfig, TrackerItem, TrackerTestResult } from "@majhi/shared";
import { z } from "zod";
import { fitItem, isoTime, parse, request } from "./http.ts";
import { type TrackerAdapter, type TrackerAdapterInit, TrackerError } from "./types.ts";

type JiraConfig = Extract<TrackerConfig, { type: "jira" }>;

const FIELDS = ["summary", "description", "status", "assignee", "labels", "updated"];

const IssueSchema = z.looseObject({
  key: z.string(),
  fields: z.looseObject({
    summary: z.string().nullish(),
    description: z.unknown(),
    status: z.looseObject({
      name: z.string(),
      statusCategory: z.looseObject({ key: z.string() }).optional(),
    }),
    assignee: z.looseObject({ displayName: z.string() }).nullish(),
    labels: z.array(z.string()).nullish(),
    updated: z.string(),
  }),
});
type Issue = z.infer<typeof IssueSchema>;

const SearchSchema = z.looseObject({ issues: z.array(IssueSchema) });
const TransitionsSchema = z.looseObject({
  transitions: z.array(
    z.looseObject({ id: z.string(), name: z.string(), to: z.looseObject({ name: z.string() }).optional() }),
  ),
});
const MyselfSchema = z.looseObject({ displayName: z.string() });
const CreatedSchema = z.looseObject({ key: z.string() });

/** Jira Cloud through REST v3, signed in with the account's email and API token. */
export class JiraAdapter implements TrackerAdapter {
  private readonly base: string;
  private readonly auth: string;

  constructor(private readonly init: TrackerAdapterInit<JiraConfig>) {
    this.base = `https://${init.config.site}`;
    this.auth = Buffer.from(`${init.config.email}:${init.token}`).toString("base64");
  }

  async pull(opts: { assignedToMe: boolean }): Promise<TrackerItem[]> {
    const { project } = this.init.config;
    const scope = opts.assignedToMe
      ? "assignee = currentUser() AND "
      : project
        ? `project = ${project} AND `
        : "";
    const jql = `${scope}statusCategory != Done ORDER BY updated DESC`;
    const data = await this.call("/rest/api/3/search/jql", "POST", { jql, maxResults: 100, fields: FIELDS });
    return parse(SearchSchema, data, "the Jira search").issues.map((issue) => this.item(issue));
  }

  async get(key: string): Promise<TrackerItem> {
    return this.item(await this.issue(key));
  }

  async comment(key: string, text: string): Promise<void> {
    await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, "POST", { body: adf(text) });
  }

  async setStatus(key: string, status: string): Promise<void> {
    const wanted = status.trim().toLowerCase();
    const issue = await this.issue(key);
    if (issue.fields.status.name.toLowerCase() === wanted) return;
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
    const { transitions } = parse(TransitionsSchema, await this.call(path), "the Jira transitions");
    const match = transitions.find(
      (t) => (t.to?.name ?? t.name).toLowerCase() === wanted || t.name.toLowerCase() === wanted,
    );
    if (match === undefined) {
      const reachable = [...new Set(transitions.map((t) => t.to?.name ?? t.name))];
      throw new TrackerError(
        `${key} cannot move to "${status}". It can move to: ${reachable.length === 0 ? "nothing from its current status" : reachable.join(", ")}.`,
      );
    }
    await this.call(path, "POST", { transition: { id: match.id } });
  }

  async link(key: string, url: string, title: string): Promise<void> {
    // The global id is the url, so linking the same address again updates the link.
    await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, "POST", {
      globalId: url,
      object: { url, title },
    });
  }

  async create(item: { title: string; body: string }): Promise<TrackerItem> {
    const { project, issue_type } = this.init.config;
    if (project === undefined) throw new TrackerError("Set the Jira project key for pushed tasks");
    const fields: Record<string, unknown> = {
      project: { key: project },
      summary: item.title,
      issuetype: { name: issue_type ?? "Task" },
    };
    if (item.body.trim() !== "") fields.description = adf(item.body);
    const created = parse(
      CreatedSchema,
      await this.call("/rest/api/3/issue", "POST", { fields }),
      "the new Jira issue",
    );
    return this.get(created.key);
  }

  async test(): Promise<TrackerTestResult> {
    try {
      const me = parse(MyselfSchema, await this.call("/rest/api/3/myself"), "the Jira account");
      const { project } = this.init.config;
      if (project === undefined) return { ok: true, detail: `Signed in as ${me.displayName}` };
      await this.call(`/rest/api/3/project/${encodeURIComponent(project)}`);
      return { ok: true, detail: `Signed in as ${me.displayName}, project ${project}` };
    } catch (err) {
      if (err instanceof TrackerError) return { ok: false, detail: err.message };
      throw err;
    }
  }

  private async issue(key: string): Promise<Issue> {
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(",")}`;
    return parse(IssueSchema, await this.call(path), `Jira issue ${key}`);
  }

  private item(issue: Issue): TrackerItem {
    const { fields } = issue;
    const assignee = fields.assignee?.displayName;
    return fitItem({
      key: issue.key,
      title: fields.summary ?? "",
      body: adfToText(fields.description),
      url: `${this.base}/browse/${encodeURIComponent(issue.key)}`,
      status: fields.status.name,
      closed: fields.status.statusCategory?.key === "done",
      ...(assignee === undefined ? {} : { assignee }),
      labels: fields.labels ?? [],
      updatedAt: isoTime(fields.updated),
    });
  }

  private call(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    return request(this.init, `${this.base}${path}`, {
      method,
      body,
      headers: { Authorization: `Basic ${this.auth}`, Accept: "application/json" },
      secrets: [this.auth],
    });
  }
}

/** Plain text as an Atlassian Document Format doc, one paragraph per line. */
function adf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: text.split(/\r?\n/).map((line) => ({
      type: "paragraph",
      content: line === "" ? [] : [{ type: "text", text: line }],
    })),
  };
}

const BLOCKS = new Set(["paragraph", "heading", "listItem"]);

/** Plain text from an ADF doc: text nodes joined, a newline after paragraphs, headings and list items. */
export function adfToText(doc: unknown): string {
  let out = "";
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: unknown; text?: unknown; attrs?: { text?: unknown }; content?: unknown };
    if (n.type === "text" && typeof n.text === "string") out += n.text;
    else if (n.type === "hardBreak") out += "\n";
    else if ((n.type === "mention" || n.type === "emoji") && typeof n.attrs?.text === "string")
      out += n.attrs.text;
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
    // A list item holds a paragraph that already ended its line.
    if (typeof n.type === "string" && BLOCKS.has(n.type) && !out.endsWith("\n")) out += "\n";
  };
  walk(doc);
  return out.trim();
}
