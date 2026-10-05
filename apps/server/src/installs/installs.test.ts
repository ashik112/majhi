import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

const KEY = "weather-key-0123456789abcdef";

const registryServer = {
  name: "io.github.acme/weather-remote",
  title: "Acme Weather",
  description: "Forecasts from Acme.",
  version: "2.0.0",
  repository: { url: "https://github.com/acme/weather-mcp", source: "github" },
  remotes: [
    {
      type: "streamable-http",
      url: "http://127.0.0.1:9/mcp",
      headers: [
        {
          name: "Authorization",
          description: "Your Acme key",
          isRequired: true,
          isSecret: true,
          value: "Bearer {api_key}",
          variables: { api_key: { isSecret: true } },
        },
      ],
    },
  ],
};
const mcpFetch = async (url: string) => {
  const path = new URL(url).pathname;
  const body = { servers: [{ server: registryServer, _meta: {} }] };
  return path === "/v0.1/servers"
    ? { ok: true, status: 200, json: async () => body }
    : { ok: false, status: 404, json: async () => ({}) };
};

describe("install by message", () => {
  let w: World | undefined;
  const world = (): World => {
    if (w === undefined) throw new Error("no world");
    return w;
  };
  const must = async (name: string, body: unknown, meta?: unknown) => {
    const res = await world().h.cmd(name, body, meta);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const items = async (task: string) =>
    ((await must("room.items", { task, limit: 100 })) as { items: RoomItem[] }).items;
  const card = async (task: string) =>
    (await items(task)).find((i) => i.type === "approval" && i.state === "pending") as
      | Extract<RoomItem, { type: "approval" }>
      | undefined;
  const newTask = async () =>
    (
      (await must("tasks.create", {
        text: "check the forecast, repo api",
        repos: [{ project: "acme-api" }],
        start: false,
      })) as {
        id: string;
      }
    ).id;
  const agentFile = () => readFile(join(world().h.env.majhiHome, "agents", "acme-builder.md"), "utf8");
  const kinds = (task: string, prefix: string) =>
    world()
      .h.majhi.services.store.permissions.audit(task)
      .map((r) => r.kind)
      .filter((k) => k.startsWith(prefix));

  afterEach(async () => {
    await w?.cleanup();
    w = undefined;
  });

  it("asks once, installs an MCP server and turns it on for that agent only after approval", async () => {
    w = await taskWorld({ mcpFetch });
    const task = await newTask();
    const sent = (await must("room.send", {
      task,
      text: "@acme-builder add this MCP server io.github.acme/weather-remote",
    })) as { item: RoomItem };
    expect(sent.item.type).toBe("owner");

    // One card, with the source and the agent. Nothing is installed and the agent was not woken.
    const pending = await card(task);
    expect(pending).toMatchObject({ command: "mcp.install", agent: "acme-builder" });
    expect(await must("connections.list", {})).toEqual([]);
    expect(world().h.runtime.starts).toHaveLength(0);
    expect(await agentFile()).not.toContain("weather-remote");

    const approved = (await must("room.approve", { task, item: pending?.id, decision: "approve" })) as {
      item: Extract<RoomItem, { type: "approval" }>;
    };
    expect(approved.item.state).toBe("applied");
    expect(kinds(task, "mcp-")).toEqual(["mcp-install"]);

    // The key is asked for with a secret request tied to the connection, never in chat.
    const request = (await items(task)).find((i) => i.type === "secret-request") as Extract<
      RoomItem,
      { type: "secret-request" }
    >;
    expect(request).toMatchObject({
      state: "pending",
      bind: { connection: "weather-remote", list: "headers", field: "Authorization" },
    });
    const answered = (await must("room.secret", { task, item: request.id, value: `Bearer ${KEY}` })) as {
      item: RoomItem;
    };
    expect(answered.item).toMatchObject({ type: "secret-request", state: "saved" });
    const view = (await must("connections.get", { id: "weather-remote" })) as { problems: string[] };
    expect(view.problems).toEqual([]);

    // The value is in the secret store only: not in the config, the agent file, the room or the audit.
    const everything = JSON.stringify([
      await readFile(world().h.majhi.services.config.file, "utf8"),
      await agentFile(),
      await items(task),
      world().h.majhi.services.store.permissions.audit(task),
    ]);
    expect(everything).not.toContain(KEY);
  });

  it("installs nothing when the owner rejects the card", async () => {
    w = await taskWorld({ mcpFetch });
    const task = await newTask();
    await must("room.send", {
      task,
      text: "@acme-builder add this MCP server io.github.acme/weather-remote",
    });
    const pending = await card(task);
    const rejected = (await must("room.approve", { task, item: pending?.id, decision: "reject" })) as {
      item: RoomItem;
    };
    expect(rejected.item).toMatchObject({ state: "rejected" });
    expect(await must("connections.list", {})).toEqual([]);
    expect(await agentFile()).not.toContain("weather-remote");
    expect(kinds(task, "mcp-")).toEqual([]);
  });
});
