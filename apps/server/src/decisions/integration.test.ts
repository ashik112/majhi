import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { HostJob, LayaStatus } from "@majhi/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { HostLink } from "../host/link.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World | undefined;
let stopHelper: (() => void) | undefined;
let server: Server | undefined;
afterEach(async () => {
  stopHelper?.();
  server?.closeAllConnections?.();
  server?.close();
  await w?.cleanup();
  w = undefined;
  server = undefined;
});

const READY: LayaStatus = { state: "ready", version: "0.2.0" };

/** Plays the host helper: answers jobs from a fake Laya. */
function playHelper(
  link: HostLink,
  laya: { status: LayaStatus; decide?: (job: Extract<HostJob, { method: "decide" }>) => unknown },
) {
  let stopped = false;
  const jobs: HostJob[] = [];
  void (async () => {
    while (!stopped) {
      const job = await link.poll({ version: "t", platform: "darwin", canRemount: false, laya: laya.status });
      if (job === undefined) continue;
      jobs.push(job);
      if (job.method === "decisions.status" || job.method === "decisions.install") {
        link.reply({ id: job.id, ok: true, result: laya.status });
      } else if (job.method === "decide") {
        link.reply({ id: job.id, ok: true, result: laya.decide?.(job) });
      } else link.reply({ id: job.id, ok: false, error: "not in this test" });
    }
  })();
  stopHelper = () => {
    stopped = true;
    link.close();
  };
  return jobs;
}

async function world(laya: Parameters<typeof playHelper>[1]) {
  const link = new HostLink({ pollTimeoutMs: 20 });
  const jobs = playHelper(link, laya);
  w = await taskWorld({ hostLink: link });
  // Let the first poll register.
  await new Promise((r) => setTimeout(r, 30));
  return { w, h: w.h, jobs };
}

const ask = {
  state: "Fix a typo in the readme",
  questions: {
    model: { type: "choice", instructions: "Which model?", options: ["haiku", "sonnet", "opus"] },
    risky: { type: "noul", instructions: "Touches payments?" },
  },
};

/** Plays Laya: `model` picks haiku; the yes/no, asked as A and B in both orders, says B (false). */
const layaAnswers = (job: Extract<HostJob, { method: "decide" }>) => ({
  answers: Object.fromEntries(
    Object.keys(job.params.questions).map((id) => [
      id,
      id === "model"
        ? {
            type: "choice",
            choice: "haiku",
            confidence: 0.1,
            probabilities: { haiku: 0.8, sonnet: 0.1, opus: 0.05, none: 0.05 },
          }
        : id.startsWith("triage")
          ? // A new finding's triage runs in the background of the world: it gets an option it has.
            { type: "choice", choice: id.startsWith("triage_kind") ? "other" : "keep", confidence: 0.5 }
          : { type: "choice", choice: "B", confidence: 0.4, probabilities: { A: 0.1, B: 0.9 } },
    ]),
  ),
  loadMs: 0,
  predictMs: 12,
});

describe("decisions.ask", () => {
  it("falls back to the stand-in agent, then to rules", async () => {
    const { w, h } = await world({ status: { state: "not-installed" } });
    expect((await h.cmd("decisions.set", { acp_agent: "acme-builder" })).status).toBe(200);
    h.runtime.onSession = (session) => {
      session.script = async (turn) => {
        turn.emit({
          type: "text",
          messageId: "m",
          text: '{"model":{"value":"opus","confidence":0.8},"risky":{"value":true,"confidence":0.7}}',
        });
        return "end_turn";
      };
    };
    const viaAcp = await h.cmd("decisions.ask", ask);
    expect(viaAcp.body).toMatchObject({ provider: "acp", estimated: true });
    expect(viaAcp.body.answers.model.value).toBe("opus");
    expect(viaAcp.body.skipped[0]).toMatchObject({ provider: "laya" });
    expect(h.runtime.sessions.at(-1)?.closed).toBe(true);

    // A reply that is never valid JSON: one retry, then rules answer.
    h.runtime.onSession = (session) => {
      session.script = async (turn) => {
        turn.emit({ type: "text", messageId: "m", text: "opus, I think" });
        return "end_turn";
      };
    };
    const viaRules = await h.cmd("decisions.ask", ask);
    expect(viaRules.body.provider).toBe("rules");
    expect(viaRules.body.skipped.map((s: { provider: string }) => s.provider)).toEqual(["laya", "acp"]);
    expect(h.runtime.sessions.at(-1)?.prompts).toHaveLength(2);
    expect(w.h.runtime.starts.length).toBeGreaterThan(0);
  });
});

describe("rateTask", () => {
  const request = {
    task: "ACM-1",
    agent: "acme-builder",
    role: "Builder" as const,
    title: "Fix a typo",
    brief: "Fix a typo\nThe readme says recieve.",
    kind: "code" as const,
    repos: ["acme-web"],
  };
  const answers = (level: string, p: number) => (job: Extract<HostJob, { method: "decide" }>) => {
    const keys = Object.keys(job.params.questions);
    const rest = (1 - p) / 3;
    return {
      answers: Object.fromEntries(
        keys.map((k) => [
          k,
          // Questions other than the task's size (a new finding's triage and injection check run in the
          // background of the world) are answered with an option each of them has.
          k.startsWith("triage") || k.startsWith("injects")
            ? {
                type: "choice",
                choice: k.startsWith("triage_kind") ? "other" : k.startsWith("triage") ? "keep" : "B",
                confidence: 0.5,
                probabilities: { keep: 0.5, other: 0.5, B: 0.5 },
              }
            : {
                type: "choice",
                choice: level,
                confidence: 0,
                probabilities: Object.fromEntries(
                  ["trivial", "small", "medium", "large"].map((l) => [l, l === level ? p : rest]),
                ),
              },
        ]),
      ),
      loadMs: 0,
      predictMs: 1,
    };
  };

  it("asks about the task in named fields, never about models, the agent's id or its instructions", async () => {
    const { w, jobs } = await world({ status: READY, decide: answers("small", 0.7) });
    const rating = await w.h.majhi.services.decisions.rateTask(request);
    expect(rating).toMatchObject({
      level: "small",
      confidence: 0.7,
      // No labels yet, so the model-pick slot runs in shadow: the answer is kept, and nothing acts on it.
      counted: false,
      provider: "laya",
      by: "Laya",
    });
    const job = jobs.find((j) => j.method === "decide" && String(j.params.state).includes("recieve"));
    const state = job?.method === "decide" ? job.params.state : "";
    expect(JSON.parse(state)).toEqual({
      task: "Fix a typo",
      description: "The readme says recieve.",
      kind: "code",
      repos: "acme-web",
      role: "Builder, who writes the code",
    });
    expect(state).not.toContain("acme-builder");
  });

  it("returns a weak answer as not counted, with why", async () => {
    const { w } = await world({ status: READY, decide: answers("large", 0.3) });
    const rating = await w.h.majhi.services.decisions.rateTask(request);
    expect(rating).toMatchObject({ level: "large", counted: false });
    expect(rating?.why).toMatch(/^shadow: 0 of 50 labels/);
  });
});

describe("/mcp/decide", () => {
  async function connect(token: string, url: string): Promise<Client> {
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport as unknown as Transport);
    return client;
  }

  it("lists the decide tool, answers, and stops at the per-run limit", async () => {
    const { w, h } = await world({ status: READY, decide: layaAnswers });
    server = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
    await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${port}/mcp`;
    expect((await h.cmd("decisions.set", { per_run_limit: 2 })).status).toBe(200);

    const attached = h.majhi.services.decisions.attachTool("ACM-1", "acme-builder");
    expect(attached?.server).toMatchObject({
      type: "http",
      name: "majhi-decide",
      url: `http://127.0.0.1:${port}/mcp/decide`,
    });
    const noAuth = await fetch(attached?.server.url ?? "", { method: "POST" });
    expect(noAuth.status).toBe(401);

    const client = await connect(attached?.token ?? "", attached?.server.url ?? "");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["decide"]);
    expect(tools[0]?.inputSchema.required).toEqual(expect.arrayContaining(["state", "questions"]));

    const call = async () => {
      const res = await client.callTool({ name: "decide", arguments: ask });
      return { text: (res.content as { text: string }[])[0]?.text ?? "", isError: res.isError === true };
    };
    const first = await call();
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text)).toMatchObject({
      provider: "laya",
      answers: { model: { value: "haiku" } },
    });
    expect((await call()).isError).toBe(false);
    const third = await call();
    expect(third).toMatchObject({ isError: true });
    expect(third.text).toContain("limit reached: 2 calls");

    const bad = await client.callTool({ name: "decide", arguments: { state: "x", questions: {} } });
    expect(bad.isError).toBe(true);

    const recent = await h.cmd("decisions.recent", {});
    expect(recent.body[0]).toMatchObject({ use: "tool", task: "ACM-1", agent: "acme-builder" });

    h.majhi.services.decisions.revoke(attached?.token ?? "");
    expect(w).toBeDefined();
    const after = await fetch(attached?.server.url ?? "", {
      method: "POST",
      headers: { authorization: `Bearer ${attached?.token}` },
    });
    expect(after.status).toBe(401);
    await client.close();
  });
});
