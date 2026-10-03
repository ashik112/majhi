import type { RoomItem, TrackerLink } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * The phase's done-when, end to end with the real adapters: a Jira item flows into a room and gets
 * its MR link written back, and a local task pushed to ClickUp stays in sync. Only `fetch` is fake:
 * it plays the Jira Cloud and ClickUp REST APIs and keeps every request.
 */

interface Request {
  method: string;
  url: string;
  body: unknown;
  auth: string | undefined;
}

type Route = (req: Request) => { status?: number; json: unknown } | undefined;

function fakeFetch(route: Route): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const f = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const req: Request = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("Authorization") ?? undefined,
    };
    requests.push(req);
    const res = route(req);
    if (res === undefined) return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
    const status = res.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(res.json), { status });
  };
  return { fetch: f as typeof fetch, requests };
}

const JIRA = "https://acme.atlassian.net/rest/api/3";
const CLICKUP = "https://api.clickup.com/api/v2";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const world = (): World => {
  if (w === undefined) throw new Error("no world");
  return w;
};
const cmd = async (name: string, body?: unknown) => {
  const res = await world().h.cmd(name, body);
  if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
  return res.body;
};
const link = async (id: string): Promise<TrackerLink | undefined> =>
  ((await cmd("trackers.links", {})) as TrackerLink[]).find((l) => l.task === id);
const at = () => new Date().toISOString();

describe("Jira", () => {
  it("brings an item into a room and writes its MR link and status back", async () => {
    let status = "To Do";
    const issue = () => ({
      key: "ACME-12",
      fields: {
        summary: "Login button does nothing",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Steps: open /login." }] }],
        },
        status: { name: status, statusCategory: { key: status === "Done" ? "done" : "indeterminate" } },
        assignee: { displayName: "Dana Acme" },
        labels: [],
        updated: "2026-10-01T10:00:00.000+0000",
      },
    });
    const transitions = [
      { id: "21", name: "Start", to: { name: "In Progress" } },
      { id: "31", name: "Send to review", to: { name: "In Review" } },
      { id: "41", name: "Finish", to: { name: "Done" } },
    ];
    const jira = fakeFetch((req) => {
      if (req.method === "POST" && req.url === `${JIRA}/search/jql`) return { json: { issues: [issue()] } };
      if (req.method === "GET" && req.url.startsWith(`${JIRA}/issue/ACME-12?`)) return { json: issue() };
      if (req.url === `${JIRA}/issue/ACME-12/transitions`) {
        if (req.method === "GET") return { json: { transitions } };
        const id = (req.body as { transition: { id: string } }).transition.id;
        status = transitions.find((t) => t.id === id)?.to.name ?? status;
        return { status: 204, json: null };
      }
      if (req.method === "POST" && req.url === `${JIRA}/issue/ACME-12/remotelink`)
        return { status: 201, json: { id: 10000 } };
      return undefined;
    });

    w = await taskWorld({ noAgent: true, trackerFetch: jira.fetch });
    const { ref } = await cmd("secrets.save", { name: "jira-acme", value: "jira-token-value" });
    await cmd("orgs.update", {
      id: "acme",
      tracker: {
        type: "jira",
        site: "acme.atlassian.net",
        email: "owner@acme.com",
        token: ref,
        project: "ACME",
      },
    });

    // The item flows into Up next and its room says where it came from.
    expect(await cmd("trackers.pull", { org: "acme" })).toMatchObject({ created: ["ACM-1"] });
    expect(jira.requests[0]?.auth).toBe(
      `Basic ${Buffer.from("owner@acme.com:jira-token-value").toString("base64")}`,
    );
    expect(jira.requests[0]?.body).toMatchObject({
      jql: "project = ACME AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    });
    expect(await cmd("tasks.get", { id: "ACM-1" })).toMatchObject({
      status: "inbox",
      title: "Login button does nothing",
    });
    const room = (await cmd("room.items", { task: "ACM-1", limit: 300 })).items as RoomItem[];
    expect(room.some((i) => i.type === "system" && i.text.includes("Pulled from Jira: ACME-12"))).toBe(true);

    // The task opens an MR: the link goes on the issue and the issue moves to In Review.
    const { store, trackers } = world().h.majhi.services;
    const mr = "https://github.com/acme/api/pull/9";
    store.tasks.setMr("ACM-1", "acme-api", { url: mr, number: 9, state: "open", ci: "none" });
    store.tasks.setStatus("ACM-1", "mr", undefined, at());
    jira.requests.length = 0;
    await trackers.syncAll();
    const writes = jira.requests.filter((r) => r.method === "POST");
    expect(writes.map((r) => r.url)).toEqual([
      `${JIRA}/issue/ACME-12/remotelink`,
      `${JIRA}/issue/ACME-12/transitions`,
    ]);
    expect(writes[0]?.body).toMatchObject({ globalId: mr, object: { url: mr } });
    expect(writes[1]?.body).toEqual({ transition: { id: "31" } });
    expect(status).toBe("In Review");
    expect(await link("ACM-1")).toMatchObject({ mrs: [mr], stage: "review", error: null });

    // Nothing changed, so nothing is written again.
    jira.requests.length = 0;
    await trackers.syncAll();
    expect(jira.requests.filter((r) => r.method === "POST")).toEqual([]);
  });
});

describe("ClickUp", () => {
  it("creates the pushed task on the list and moves it with the local task", async () => {
    let status = "to do";
    const task = () => ({
      id: "86abc1",
      name: "Add a health check to api",
      text_content: "",
      url: "https://app.clickup.com/t/86abc1",
      status: { status, type: status === "complete" ? "closed" : "open" },
      assignees: [],
      tags: [],
      date_updated: "1759312800000",
    });
    const clickup = fakeFetch((req) => {
      if (req.method === "POST" && req.url === `${CLICKUP}/list/901234/task`) return { json: task() };
      if (req.method === "GET" && req.url === `${CLICKUP}/list/901234`)
        return {
          json: {
            name: "Backlog",
            statuses: [
              { status: "to do" },
              { status: "in progress" },
              { status: "review" },
              { status: "complete" },
            ],
          },
        };
      if (req.url === `${CLICKUP}/task/86abc1`) {
        if (req.method === "PUT") status = (req.body as { status: string }).status;
        return { json: task() };
      }
      return undefined;
    });

    w = await taskWorld({ noAgent: true, trackerFetch: clickup.fetch });
    const { ref } = await cmd("secrets.save", { name: "clickup-acme", value: "clickup-token-value" });
    await cmd("orgs.update", { id: "acme", tracker: { type: "clickup", token: ref, list: "901234" } });
    await cmd("tasks.create", {
      text: "Add a health check to api",
      repos: [{ project: "acme-api" }],
      start: false,
    });

    expect(await cmd("trackers.push", { id: "ACM-1" })).toMatchObject({
      type: "clickup",
      key: "86abc1",
      url: "https://app.clickup.com/t/86abc1",
      origin: "pushed",
    });
    expect(clickup.requests[0]).toMatchObject({ method: "POST", auth: "clickup-token-value" });

    const { store, trackers } = world().h.majhi.services;
    store.tasks.setStatus("ACM-1", "running", undefined, at());
    await trackers.syncAll();
    expect(status).toBe("in progress");
    store.tasks.setStatus("ACM-1", "review", undefined, at());
    await trackers.syncAll();
    expect(status).toBe("review");
    store.tasks.setStatus("ACM-1", "done", undefined, at());
    await trackers.syncAll();
    expect(status).toBe("complete");
    expect(clickup.requests.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual([
      { status: "in progress" },
      { status: "review" },
      { status: "complete" },
    ]);
    expect(await link("ACM-1")).toMatchObject({ stage: "done", error: null });
  });
});
