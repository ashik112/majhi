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
