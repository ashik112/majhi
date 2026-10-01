import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { serve } from "@hono/node-server";
import type { McpServerSpec } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World | undefined;
let server: Server | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  server?.closeAllConnections?.();
  server?.close();
  await w?.cleanup();
  w = undefined;
  server = undefined;
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const text = (res: unknown): string =>
  ((res as { content: { text: string }[] }).content[0]?.text ?? "") as string;

async function connect(spec: McpServerSpec | undefined): Promise<Client> {
  if (spec === undefined) throw new Error("no majhi-connections on the session");
  const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
    requestInit: { headers: spec.headers },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

/**
 * Acme's builder holds the ssh connection acme-box; the root agent ops-root holds every connection
 * of acme and can attach globex's. Turns stay open until the test lets them end.
 */
async function world() {
  const remote: { alias: string; command: string }[] = [];
  w = await taskWorld({
    agent: { connections: ["acme-box"] },
    connectionsRemote: async (alias, command) => {
      remote.push({ alias, command });
      return { code: 0, output: `ran ${command}` };
    },
  });
  const { h } = w;
  await mkdir(join(h.dir, ".ssh"), { recursive: true });
  await writeFile(
    join(h.dir, ".ssh", "config"),
    "Host acme-box\n  HostName box.acme.example\nHost globex-box\n",
  );
  for (const [name, body] of [
    [
      "connections.create",
      { org: "acme", id: "acme-box", type: "ssh", name: "Acme box", fields: { alias: "acme-box" } },
    ],
    ["orgs.create", { id: "globex", name: "Globex", key: "GLX" }],
    [
      "connections.create",
      { org: "globex", id: "globex-box", type: "ssh", name: "Globex box", fields: { alias: "globex-box" } },
    ],
    [
      "agents.create",
      {
        id: "ops-root",
        frontmatter: { scope: "root", role: "Root", account: "claude-acme", perms: ["edit", "shell"] },
        instructions: "Investigate.\n",
      },
    ],
  ] as const) {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
  }
  server = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  const s = server;
  await new Promise<void>((resolve) => s.once("listening", () => resolve()));
  h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
  const servers: McpServerSpec[][] = [];
  const prompts: string[] = [];
  const open: (() => void)[] = [];
  h.runtime.onSession = (session, start) => {
    servers.push((start.mcpServers ?? []).filter((m): m is McpServerSpec => m.type === "http"));
    session.script = async (turn) => {
      prompts.push(turn.text);
      await Promise.race([new Promise<void>((r) => open.push(r)), turn.untilCancelled()]);
      return "end_turn";
    };
  };
  /** Ends the turn that is open, as the agent would by itself. */
  const endTurn = () => open.shift()?.();
  return { h, remote, servers, prompts, endTurn };
}

const named = (list: McpServerSpec[] | undefined) => list?.find((s) => s.name === "majhi-connections");

describe("majhi-connections", () => {
  it("lists what the run holds, runs reads over ssh and holds writes for the owner", async () => {
    const { h, remote, servers, prompts, endTurn } = await world();
    const task = (
      await h.cmd("tasks.create", {
        text: "check the box, repo api",
        repos: [{ project: "acme-api" }],
        kind: "ops",
        start: true,
      })
    ).body as { id: string };
    await until(() => prompts.length === 1, "first turn");
    const client = await connect(named(servers[0]));

    const list = text(await client.callTool({ name: "list", arguments: {} }));
    expect(list).toContain("Acme box (acme-box, SSH host, org acme)");
    expect(list).toContain("majhi-connections ssh tool");
    expect(list).not.toContain("Globex");
    expect(text(await client.callTool({ name: "attach", arguments: { id: "globex-box" } }))).toBe(
      "Only root agents attach connections.",
    );

    const read = text(
      await client.callTool({
        name: "ssh",
        arguments: { connection: "acme-box", command: "systemctl status api" },
      }),
    );
    expect(read).toBe("acme-box: systemctl status api (exit 0)\nran systemctl status api");
    expect(remote).toEqual([{ alias: "acme-box", command: "systemctl status api" }]);

    const write = text(
      await client.callTool({
        name: "ssh",
        arguments: { connection: "acme-box", command: "systemctl restart api" },
      }),
    );
    expect(write).toContain("waits for the owner");
    expect(remote).toHaveLength(1);
    const page = await h.cmd("room.items", { task: task.id, limit: 200 });
    const pending = (page.body.items as RoomItem[]).find(
      (i): i is Extract<RoomItem, { type: "permission" }> => i.type === "permission" && i.state === "pending",
    );
    expect(pending?.connection).toMatchObject({
      id: "acme-box",
      name: "Acme box",
      action: "systemctl restart api",
    });
    await h.cmd("room.permission", { task: task.id, item: pending?.id, option: "allow" });
    await until(() => remote.length === 2, "the restart to run");
    expect(
      h.majhi.services.store.permissions.audit(task.id).find((r) => r.kind === "connection-write"),
    ).toMatchObject({
      decision: "allow",
      by: "owner",
      detail: "acme-box: systemctl restart api",
    });
    endTurn();
    await until(() => prompts.some((p) => p.includes("The owner allowed it.")), "the result in a prompt");
    endTurn();
  });

  it("lets a root agent attach another org's connection, logs it and reloads the session", async () => {
    const { h, servers, prompts, endTurn } = await world();
    const task = (
      await h.cmd("tasks.create", {
        text: "why is the api slow, repo api",
        repos: [{ project: "acme-api" }],
        kind: "ops",
        team: ["ops-root"],
        start: true,
      })
    ).body as { id: string };
    await until(() => prompts.length === 1, "first turn");
    const client = await connect(named(servers[0]));
    expect(text(await client.callTool({ name: "list", arguments: {} }))).toContain(
      "Globex box (globex-box, SSH host, org globex)",
    );

    const attached = text(
      await client.callTool({ name: "attach", arguments: { id: "globex-box", why: "The api calls it." } }),
    );
    expect(attached).toContain("Attached Globex box");
    expect((await h.cmd("tasks.get", { id: task.id })).body.connections).toEqual(["globex-box"]);
    expect(h.majhi.services.store.permissions.audit(task.id)).toContainEqual(
      expect.objectContaining({
        kind: "connection-attach",
        org: "globex",
        detail: "globex-box (globex): The api calls it.",
      }),
    );
    const page = await h.cmd("room.items", { task: task.id, limit: 200 });
    expect(
      (page.body.items as RoomItem[]).some(
        (i) => i.type === "system" && i.text.includes("attached Globex box"),
      ),
    ).toBe(true);

    // The turn ends, the session reloads with the connection and the agent is told.
    endTurn();
    await until(() => servers.length === 2 && prompts.length === 2, "the reloaded session");
    expect(prompts[1]).toContain("Globex box (globex-box) is attached");
    const reloaded = await connect(named(servers[1]));
    expect(text(await reloaded.callTool({ name: "list", arguments: {} }))).toMatch(
      /^This run holds:\n- Acme box \(acme-box[^\n]*\n[^\n]*\n- Globex box \(globex-box/,
    );
    endTurn();
  });

  it("is not on a session that holds no connection, for an org agent", async () => {
    const { h, servers, prompts } = await world();
    await h.cmd("agents.update", {
      id: "acme-builder",
      frontmatter: {
        scope: "acme",
        role: "Builder",
        account: "claude-acme",
        perms: ["edit", "shell"],
        connections: [],
      },
      instructions: "Build.\n",
    });
    await h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true });
    await until(() => prompts.length === 1, "first turn");
    expect(named(servers[0])).toBeUndefined();
    expect(basename(servers[0]?.[0]?.url ?? "")).not.toBe("connections");
  });
});
