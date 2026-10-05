import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";
import { isRepoPage, parseInstallRequest } from "./parse.ts";

const FAKE_CLI = {
  command: process.execPath,
  args: [fileURLToPath(new URL("../testing/fake-skills.mjs", import.meta.url))],
};
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

describe("parsing an install request", () => {
  it("reads a skill from a link, an owner/repo or a name from a source", () => {
    expect(
      parseInstallRequest("@acme-builder install this skill https://github.com/acme/agent-skills"),
    ).toEqual({
      kind: "skill",
      source: "https://github.com/acme/agent-skills",
    });
    expect(parseInstallRequest("please add the skill acme/agent-skills.")).toEqual({
      kind: "skill",
      source: "acme/agent-skills",
    });
    expect(parseInstallRequest("install skill lint-fixes from acme/agent-skills")).toEqual({
      kind: "skill",
      source: "acme/agent-skills",
      skill: "lint-fixes",
    });
  });

  it("reads an MCP server from a registry name, a URL, a command, a snippet or a word", () => {
    const mcp = (text: string) => (parseInstallRequest(text) as { ref: unknown } | undefined)?.ref;
    expect(mcp("@acme-builder add this MCP server io.github.acme/weather")).toEqual({
      type: "registry",
      name: "io.github.acme/weather",
    });
    expect(mcp("add this mcp server https://mcp.acme.test/sse")).toEqual({
      type: "url",
      url: "https://mcp.acme.test/sse",
    });
    expect(mcp("add this MCP server npx -y @acme/mcp-weather@1.2.0")).toEqual({
      type: "command",
      command: "npx -y @acme/mcp-weather@1.2.0",
    });
    expect(
      mcp('add the mcp server {"mcpServers":{"weather":{"url":"https://mcp.acme.test"}}}'),
    ).toMatchObject({
      type: "json",
    });
    expect(mcp("add this MCP server weather")).toEqual({ type: "search", query: "weather" });
  });

  it("leaves ordinary messages to the agent", () => {
    for (const text of [
      "install the skill, then fix the bug in the API",
      "add this MCP server to the plan and tell me what it costs",
      "can you install this skill from the docs and explain it",
      "the skill lint-fixes is broken",
      "",
    ]) {
      expect(parseInstallRequest(text)).toBeUndefined();
    }
  });

  it("knows a repository page from a server address", () => {
    expect(isRepoPage("https://github.com/acme/weather-mcp")).toBe(true);
    expect(isRepoPage("https://mcp.acme.test/sse")).toBe(false);
  });
});

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
    expect(pending).toMatchObject({
      command: "mcp.install",
      agent: "acme-builder",
      summary: expect.stringContaining("Acme Weather"),
    });
    expect(pending?.summary).toContain("registry io.github.acme/weather-remote 2.0.0");
    expect(pending?.summary).toContain("@acme-builder");
    expect(pending?.input).toContain("github.com/acme/weather-mcp");
    expect(await must("connections.list", {})).toEqual([]);
    expect(world().h.runtime.starts).toHaveLength(0);
    expect(await agentFile()).not.toContain("weather-remote");

    const approved = (await must("room.approve", { task, item: pending?.id, decision: "approve" })) as {
      item: Extract<RoomItem, { type: "approval" }>;
    };
    expect(approved.item.state).toBe("applied");
    expect(approved.item.result).toContain("Installed weather-remote, on for @acme-builder");
    // A server reaches every agent of its org unless it is off for one, so nothing is written to the
    // agent's file and the enable is a no-op that leaves no row of its own.
    expect(await agentFile()).not.toContain("weather-remote");
    const installed = (await must("connections.get", { id: "weather-remote" })) as { agentsOff: string[] };
    expect(installed.agentsOff).not.toContain("acme-builder");
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

  it("installs a skill and turns it on for the agent, whose next session has it", async () => {
    w = await taskWorld({ skillsCommand: FAKE_CLI });
    const task = await newTask();
    await must("room.send", {
      task,
      text: "@acme-builder install this skill lint-fixes from acme/agent-skills",
    });
    const pending = await card(task);
    expect(pending).toMatchObject({ command: "skills.install", agent: "acme-builder" });
    expect(pending?.summary).toContain("lint-fixes from acme/agent-skills");
    expect(await must("skills.list", {})).toEqual([]);

    const approved = (await must("room.approve", { task, item: pending?.id, decision: "approve" })) as {
      item: Extract<RoomItem, { type: "approval" }>;
    };
    expect(approved.item.state).toBe("applied");
    expect(await agentFile()).toContain("lint-fixes");
    expect(kinds(task, "skill-")).toEqual(["skill-install", "skill-enable"]);
    const listed = (await must("skills.list", { agent: "acme-builder" })) as { name: string }[];
    expect(listed.map((s) => s.name)).toEqual(["lint-fixes"]);
  });

  it("sends a message that only mentions installing to the agent as usual", async () => {
    w = await taskWorld({ mcpFetch });
    const task = await newTask();
    await must("room.send", { task, text: "@acme-builder install the skill, then fix the bug" });
    expect(await card(task)).toBeUndefined();
  });

  it("does not turn a server on for a root agent", async () => {
    w = await taskWorld({ mcpFetch, agent: { scope: "root" } });
    const task = await newTask();
    await must("room.send", {
      task,
      text: "@acme-builder add this MCP server io.github.acme/weather-remote",
    });
    const pending = await card(task);
    expect(pending?.summary).not.toContain("turn it on");
    await must("room.approve", { task, item: pending?.id, decision: "approve" });
    expect(await agentFile()).not.toContain("weather-remote");
    expect(kinds(task, "mcp-")).toEqual(["mcp-install"]);
  });
});
