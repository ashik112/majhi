import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { McpServerSpec, PromptBlock } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";
import type { RemoteRunFn } from "./remote.ts";

const COMMAND = "docker restart api";

let w: World | undefined;
let server: Server | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => undefined);
  server?.closeAllConnections?.();
  server?.close();
  await w?.cleanup();
  w = server = client = undefined;
});

const textOf = (res: unknown): string =>
  ((res as { content: { text: string }[] }).content.map((c) => c.text).join("\n") ?? "") as string;
const promptText = (blocks: PromptBlock[]): string =>
  blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");

/**
 * An agent in a task that holds an ssh host, over the fake ACP session. Its first turn stays open
 * until `endTurn`, so a test can answer a card while the agent is still working.
 */
async function agentWithHost(remote: RemoteRunFn) {
  w = await taskWorld({ agent: { connections: ["acme-host"] }, connectionsRemote: remote });
  const { h } = w;
  const must = async (name: Parameters<typeof h.cmd>[0], body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  await must("connections.create", {
    org: "acme",
    id: "acme-host",
    type: "ssh",
    name: "Host",
    fields: { alias: "deploy@10.0.0.5" },
  });
  server = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  const s = server;
  await new Promise<void>((resolve) => s.once("listening", () => resolve()));
  h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;

  let spec: McpServerSpec | undefined;
  let endTurn: () => void = () => undefined;
  const turnOpen = new Promise<void>((resolve) => {
    endTurn = resolve;
  });
  h.runtime.onSession = (session, start) => {
    spec = (start.mcpServers ?? []).find(
      (m): m is McpServerSpec => m.type === "http" && m.name === "majhi-connections",
    );
    let turns = 0;
    session.script = async (turn) => {
      turn.emit({ type: "text", messageId: `m${++turns}`, text: "working" });
      if (turns === 1) await turnOpen;
      return "end_turn";
    };
  };
  const task = (await must("tasks.create", {
    text: "restart the api, repo api",
    repos: [{ project: "acme-api" }],
    start: true,
  })) as { id: string };
  await until(() => spec !== undefined && h.runtime.sessions[0]?.prompts.length === 1);
  if (spec === undefined) throw new Error("no majhi-connections on the session");
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    }) as Transport,
  );
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    textOf(await client?.callTool({ name, arguments: args }));
  const ssh = () => tool("ssh", { connection: "acme-host", command: COMMAND });
  const items = async (): Promise<RoomItem[]> =>
    (await h.cmd("room.items", { task: task.id, limit: 500 })).body.items as RoomItem[];
  const answer = async (option: string) => {
    const card = (await items()).find((i) => i.type === "permission");
    if (card === undefined) throw new Error("no card");
    await must("room.permission", { task: task.id, item: card.id, option });
  };
  /** Answers the card in the same step that made it: before ssh() can attach to the wait. */
  const answerAtOnce = (option: string) => {
    const { runs, room, store } = h.majhi.services;
    const ask = runs.askConnectionWrite.bind(runs);
    runs.askConnectionWrite = (...args) => {
      const asked = ask(...args);
      room.flush(task.id);
      const card = store.room.pendingPermissions().find((i) => i.task === task.id);
      if (card === undefined) throw new Error("no card");
      runs.answerPermission(task.id, card.id, option);
      return asked;
    };
  };
  /** What the agent was prompted with after its first turn. */
  const later = () => (h.runtime.sessions[0]?.prompts.slice(1) ?? []).map(promptText).join("\n---\n");
  return { h, task, ssh, tool, items, answer, answerAtOnce, endTurn, later };
}

describe("an approved ssh command", () => {
  const said = "The owner allowed it.";
  const cases = (["while its turn runs", "before the wait is registered"] as const).flatMap((when) =>
    (["its next tool call", "a message at the end of its turn"] as const).map((way) => [when, way] as const),
  );

  it.each(cases)(
    "runs once and the agent gets the output: approved %s, read through %s",
    async (when, way) => {
      const ran: string[] = [];
      const t = await agentWithHost(async (_alias, command) => {
        ran.push(command);
        return { code: 0, output: "api restarted" };
      });
      if (when === "before the wait is registered") t.answerAtOnce("allow");
      expect(await t.ssh()).toContain("waits for the owner");
      if (when === "while its turn runs") await t.answer("allow");
      if (way === "its next tool call") {
        await until(async () => (await t.tool("list")).includes("api restarted"));
        t.endTurn();
        await t.h.majhi.services.runs.idle(t.task.id);
        // Read once: the message that would have woken it is dropped.
        expect(t.later()).toBe("");
      } else {
        t.endTurn();
        await until(() => t.later().includes(said));
        await t.h.majhi.services.runs.idle(t.task.id);
        expect(t.later().split("api restarted")).toHaveLength(2);
      }
      expect(ran).toEqual([COMMAND]);
    },
  );
});
