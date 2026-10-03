import type { TrackerConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { createAdapter } from "./index.ts";
import { type TrackerAdapter, TrackerError } from "./types.ts";

type JiraConfig = Extract<TrackerConfig, { type: "jira" }>;

const TOKEN = "tok-secret-123";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; json?: unknown } | undefined;

/** A fetch that records every request and answers from `answer`. An unanswered request fails the test. */
function fake(answer: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = answer(call);
    if (reply === undefined) throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    const status = reply.status ?? 200;
    // A 204 has no body, and a Response refuses to carry one.
    return new Response(status === 204 ? null : JSON.stringify(reply.json ?? {}), { status });
  };
  return { fetch: fetchFn, calls };
}

/** Answers every request with an error whose body echoes the Authorization header back. */
function echoAuth(status = 401) {
  return fake((call) => {
    const auth = call.headers.Authorization ?? "";
    return {
      status,
      json: { errorMessages: [`bad ${auth}`], err: `bad ${auth}`, message: `bad ${auth}` },
    };
  });
}

const jiraConfig: JiraConfig = {
  type: "jira",
  site: "acme.atlassian.net",
  email: "dev@acme.example",
  token: "secret:jira",
  project: "ACME",
};
const clickupConfig: TrackerConfig = {
  type: "clickup",
  token: "secret:clickup",
  list: "9001",
};
const githubConfig: TrackerConfig = { type: "github", repo: "acme/widgets" };

const { project: _project, ...withoutProject } = jiraConfig;

function adapter(config: TrackerConfig, f: typeof fetch): TrackerAdapter {
  return createAdapter({ config, token: TOKEN, fetch: f });
}

function jqlOf(call: Call | undefined): string | undefined {
  return (call?.body as { jql?: string } | undefined)?.jql;
}

async function failure(run: Promise<unknown>): Promise<TrackerError> {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TrackerError);
  return err as TrackerError;
}

describe("Jira", () => {
  const jiraIssue = (key: string, status: string, category = "indeterminate") => ({
    key,
    fields: {
      summary: "Fix the login form",
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Steps" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Open the page" },
              { type: "hardBreak" },
              { type: "text", text: "Click Sign in" },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
              },
            ],
          },
        ],
      },
      status: { name: status, statusCategory: { key: category } },
      assignee: { displayName: "Dana Acme" },
      labels: ["bug"],
      updated: "2026-10-01T10:00:00.000+0200",
    },
  });

  it("pulls with the right query and turns the ADF description into text", async () => {
    const { fetch: f, calls } = fake((c) =>
      c.url.endsWith("/rest/api/3/search/jql")
        ? { json: { issues: [jiraIssue("ACME-1", "In Progress")] } }
        : undefined,
    );
    const items = await adapter(jiraConfig, f).pull({ assignedToMe: true });
    expect(items).toEqual([
      {
        key: "ACME-1",
        title: "Fix the login form",
        body: "Steps\nOpen the page\nClick Sign in\none\ntwo",
        url: "https://acme.atlassian.net/browse/ACME-1",
        status: "In Progress",
        closed: false,
        assignee: "Dana Acme",
        labels: ["bug"],
        updatedAt: "2026-10-01T08:00:00.000Z",
      },
    ]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`dev@acme.example:${TOKEN}`).toString("base64")}`,
    );
    expect(calls[0]?.body).toEqual({
      jql: "project = ACME AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      maxResults: 100,
      fields: ["summary", "description", "status", "assignee", "labels", "updated"],
    });
  });

  it("scopes an unassigned pull to the project, or to nothing without one", async () => {
    const { fetch: f, calls } = fake(() => ({ json: { issues: [] } }));
    await adapter(jiraConfig, f).pull({ assignedToMe: false });
    await adapter(withoutProject, f).pull({ assignedToMe: false });
    expect(jqlOf(calls[0])).toBe("project = ACME AND statusCategory != Done ORDER BY updated DESC");
    expect(jqlOf(calls[1])).toBe("statusCategory != Done ORDER BY updated DESC");
  });

  it("marks done items closed and reads a null description as empty", async () => {
    const issue = { ...jiraIssue("ACME-2", "Done", "done") };
    issue.fields = { ...issue.fields, description: null as never, assignee: null as never };
    const { fetch: f } = fake(() => ({ json: issue }));
    const item = await adapter(jiraConfig, f).get("ACME-2");
    expect(item).toMatchObject({ body: "", closed: true });
    expect(item.assignee).toBeUndefined();
  });

  it("moves through the transition that leads to the status, matched without regard to case", async () => {
    const { fetch: f, calls } = fake((c) => {
      if (c.url.includes("/transitions")) {
        return c.method === "GET"
          ? {
              json: {
                transitions: [
                  { id: "11", name: "Start", to: { name: "In Progress" } },
                  { id: "31", name: "Finish", to: { name: "Done" } },
                ],
              },
            }
          : { status: 204 };
      }
      return { json: jiraIssue("ACME-3", "To Do", "new") };
    });
    await adapter(jiraConfig, f).setStatus("ACME-3", "in progress");
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { transition: { id: "11" } } });
    expect(calls.at(-1)?.url).toBe("https://acme.atlassian.net/rest/api/3/issue/ACME-3/transitions");
  });

  it("does nothing when the status already matches, and names the reachable statuses when none does", async () => {
    const { fetch: f, calls } = fake((c) => {
      if (c.url.includes("/transitions")) {
        return { json: { transitions: [{ id: "31", name: "Finish", to: { name: "Done" } }] } };
      }
      return { json: jiraIssue("ACME-4", "In Progress") };
    });
    const jira = adapter(jiraConfig, f);
    await jira.setStatus("ACME-4", "IN PROGRESS");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    const err = await failure(jira.setStatus("ACME-4", "Blocked"));
    expect(err.message).toContain("Done");
  });

  it("links with a global id so repeats update", async () => {
    const { fetch: f, calls } = fake(() => ({ json: {} }));
    await adapter(jiraConfig, f).link("ACME-5", "https://git.acme.example/mr/1", "MR 1");
    expect(calls[0]?.body).toEqual({
      globalId: "https://git.acme.example/mr/1",
      object: { url: "https://git.acme.example/mr/1", title: "MR 1" },
    });
  });

  it("creates in the project with the issue type, then reads the issue back", async () => {
    const { fetch: f, calls } = fake((c) =>
      c.method === "POST"
        ? { status: 201, json: { key: "ACME-6" } }
        : { json: jiraIssue("ACME-6", "To Do", "new") },
    );
    const item = await adapter({ ...jiraConfig, issue_type: "Bug" }, f).create({
      title: "New bug",
      body: "line one\nline two",
    });
    expect(item.key).toBe("ACME-6");
    expect(calls[0]?.body).toEqual({
      fields: {
        project: { key: "ACME" },
        summary: "New bug",
        issuetype: { name: "Bug" },
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "line one" }] },
            { type: "paragraph", content: [{ type: "text", text: "line two" }] },
          ],
        },
      },
    });
  });

  it("refuses to create without a project", async () => {
    const { fetch: f, calls } = fake(() => undefined);
    const err = await failure(adapter(withoutProject, f).create({ title: "t", body: "" }));
    expect(err.message).toBe("Set the Jira project key for pushed tasks");
    expect(calls).toEqual([]);
  });

  it("keeps the token, in plain or encoded form, out of error messages", async () => {
    const { fetch: f } = echoAuth();
    const jira = adapter(jiraConfig, f);
    const encoded = Buffer.from(`dev@acme.example:${TOKEN}`).toString("base64");
    const err = await failure(jira.get("ACME-1"));
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(encoded);
    const test = await jira.test();
    expect(test.ok).toBe(false);
    expect(test.detail).not.toContain(encoded);
  });
});

describe("ClickUp", () => {
  const task = (over: Record<string, unknown> = {}) => ({
    id: "86abc",
    name: "Write the docs",
    text_content: "Plain body",
    description: "Markdown body",
    url: "https://app.clickup.com/t/86abc",
    status: { status: "in progress", type: "custom" },
    assignees: [{ username: "dana" }],
    tags: [{ name: "docs" }],
    date_updated: "1790000000000",
    ...over,
  });

  it("pulls open tasks with the right query and maps them", async () => {
    const { fetch: f, calls } = fake((c) =>
      c.url.includes("/list/9001/task") ? { json: { tasks: [task()] } } : undefined,
    );
    const items = await adapter(clickupConfig, f).pull({ assignedToMe: false });
    expect(calls[0]?.url).toBe(
      "https://api.clickup.com/api/v2/list/9001/task?include_closed=false&subtasks=true&order_by=updated&reverse=true&page=0",
    );
    expect(calls[0]?.headers.Authorization).toBe(TOKEN);
    expect(items).toEqual([
      {
        key: "86abc",
        title: "Write the docs",
        body: "Plain body",
        url: "https://app.clickup.com/t/86abc",
        status: "in progress",
        closed: false,
        assignee: "dana",
        labels: ["docs"],
        updatedAt: new Date(1790000000000).toISOString(),
      },
    ]);
  });

  it("adds the user's id to an assigned pull and counts closed and done types as closed", async () => {
    const { fetch: f, calls } = fake((c) => {
      if (c.url.endsWith("/user")) return { json: { user: { id: 42, username: "dana" } } };
      return {
        json: { tasks: [task({ status: { status: "complete", type: "closed" }, text_content: null })] },
      };
    });
    const items = await adapter(clickupConfig, f).pull({ assignedToMe: true });
    expect(calls[1]?.url).toContain("&assignees[]=42");
    expect(items[0]).toMatchObject({ closed: true, body: "Markdown body" });
  });

  it("sets the list's exact status name, matched without regard to case", async () => {
    const { fetch: f, calls } = fake((c) =>
      c.method === "GET"
        ? { json: { name: "Sprint", statuses: [{ status: "to do" }, { status: "In Review" }] } }
        : { json: {} },
    );
    await adapter(clickupConfig, f).setStatus("86abc", "in review");
    expect(calls[1]).toMatchObject({
      method: "PUT",
      url: "https://api.clickup.com/api/v2/task/86abc",
      body: { status: "In Review" },
    });
  });

  it("names the list's statuses when none matches", async () => {
    const { fetch: f, calls } = fake(() => ({
      json: { name: "Sprint", statuses: [{ status: "to do" }, { status: "complete" }] },
    }));
    const err = await failure(adapter(clickupConfig, f).setStatus("86abc", "shipped"));
    expect(err.message).toContain("to do, complete");
    expect(calls).toHaveLength(1);
  });

  it("creates with a markdown description and links with a comment", async () => {
    const { fetch: f, calls } = fake((c) => (c.url.endsWith("/comment") ? { json: {} } : { json: task() }));
    const clickup = adapter(clickupConfig, f);
    const item = await clickup.create({ title: "Write the docs", body: "# Plan" });
    expect(item.key).toBe("86abc");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.clickup.com/api/v2/list/9001/task",
      body: { name: "Write the docs", markdown_description: "# Plan" },
    });
    await clickup.link("86abc", "https://git.acme.example/mr/2", "MR 2");
    expect(calls[1]?.body).toEqual({
      comment_text: "MR 2: https://git.acme.example/mr/2",
      notify_all: false,
    });
  });

  it("keeps the token out of error messages", async () => {
    const { fetch: f } = echoAuth();
    const clickup = adapter(clickupConfig, f);
    const err = await failure(clickup.get("86abc"));
    expect(err.message).toContain("[token]");
    expect(err.message).not.toContain(TOKEN);
    expect((await clickup.test()).detail).not.toContain(TOKEN);
  });
});

describe("GitHub Issues", () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    number: 7,
    title: "Crash on start",
    body: null,
    html_url: "https://github.com/acme/widgets/issues/7",
    state: "open",
    assignee: { login: "dana" },
    labels: [{ name: "bug" }, { name: "p1" }],
    updated_at: "2026-10-01T08:00:00Z",
    ...over,
  });

  it("pulls open issues, skips pull requests and maps the rest", async () => {
    const { fetch: f, calls } = fake(() => ({
      json: [
        issue(),
        issue({ number: 8, pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/8" } }),
      ],
    }));
    const items = await adapter(githubConfig, f).pull({ assignedToMe: false });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/widgets/issues?state=open&per_page=100&sort=updated",
    );
    expect(calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "majhi",
    });
    expect(items).toEqual([
      {
        key: "7",
        title: "Crash on start",
        body: "",
        url: "https://github.com/acme/widgets/issues/7",
        status: "open",
        closed: false,
        assignee: "dana",
        labels: ["bug", "p1"],
        updatedAt: "2026-10-01T08:00:00Z",
      },
    ]);
  });

  it("adds the login to an assigned pull", async () => {
    const { fetch: f, calls } = fake((c) =>
      c.url.endsWith("/user") ? { json: { login: "dana" } } : { json: [] },
    );
    await adapter(githubConfig, f).pull({ assignedToMe: true });
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/acme/widgets/issues?state=open&per_page=100&sort=updated&assignee=dana",
    );
  });

  it("closes as completed, reopens, and does nothing when already in that state", async () => {
    let state = "open";
    const { fetch: f, calls } = fake((c) => {
      if (c.method === "PATCH") {
        state = (c.body as { state: string }).state;
        return { json: issue({ state }) };
      }
      return { json: issue({ state }) };
    });
    const github = adapter(githubConfig, f);
    await github.setStatus("7", "open");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    await github.setStatus("7", "Closed");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.com/repos/acme/widgets/issues/7",
      body: { state: "closed", state_reason: "completed" },
    });
    await github.setStatus("7", "closed");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    await github.setStatus("7", "open");
    expect(calls.at(-1)?.body).toEqual({ state: "open" });
  });

  it("refuses other statuses and keys that are not digits without a request", async () => {
    const { fetch: f, calls } = fake(() => undefined);
    const github = adapter(githubConfig, f);
    expect((await failure(github.setStatus("7", "in progress"))).message).toBe(
      "GitHub Issues only has open and closed",
    );
    await failure(github.get("7/../../user"));
    await failure(github.comment("abc", "hi"));
    expect(calls).toEqual([]);
  });

  it("creates an issue and links with a comment", async () => {
    const { fetch: f, calls } = fake((c) =>
      c.url.endsWith("/comments") ? { status: 201, json: {} } : { status: 201, json: issue() },
    );
    const github = adapter(githubConfig, f);
    expect((await github.create({ title: "Crash on start", body: "Details" })).key).toBe("7");
    expect(calls[0]).toMatchObject({ method: "POST", body: { title: "Crash on start", body: "Details" } });
    await github.link("7", "https://github.com/acme/widgets/pull/9", "MR 9");
    expect(calls[1]).toMatchObject({
      url: "https://api.github.com/repos/acme/widgets/issues/7/comments",
      body: { body: "MR 9: https://github.com/acme/widgets/pull/9" },
    });
  });

  it("refuses a repo with issues turned off", async () => {
    const { fetch: f } = fake((c) =>
      c.url.endsWith("/user")
        ? { json: { login: "dana" } }
        : { json: { full_name: "acme/widgets", has_issues: false } },
    );
    const result = await adapter(githubConfig, f).test();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Issues are turned off");
  });

  it("keeps the token out of error messages, and turns a network failure into a TrackerError", async () => {
    const github = adapter(githubConfig, echoAuth(403).fetch);
    const err = await failure(github.get("7"));
    expect(err.status).toBe(403);
    expect(err.message).not.toContain(TOKEN);
    const down: typeof fetch = async () => {
      throw new Error(`connect failed with ${TOKEN}`);
    };
    const unreachable = await failure(adapter(githubConfig, down).get("7"));
    expect(unreachable.message).toContain("Could not reach api.github.com");
    expect(unreachable.message).not.toContain(TOKEN);
  });
});
