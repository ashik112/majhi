import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { ConnectionTestResult, McpInstallResult, McpPreview } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

const FAKE_MCP = fileURLToPath(new URL("../testing/fake-mcp.mjs", import.meta.url));
const KEY = "weather-key-0123456789abcdef";

/** A remote MCP server that wants its Authorization header, like a hosted one. */
let remote: Server | undefined;
let remoteUrl = "";
const seenAuth: (string | undefined)[] = [];

async function startRemote(): Promise<void> {
  remote = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (msg.id === undefined) return void res.writeHead(202).end();
      seenAuth.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401).end();
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: msg.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "weather", version: "1" },
            }
          : { tools: [{ name: "get_forecast", inputSchema: { type: "object" } }] };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  const server = remote;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const repository = { url: "https://github.com/acme/weather-mcp", source: "github" };
const remoteServer = () => ({
  name: "io.github.acme/weather-remote",
  title: "Acme Weather",
  description: "Forecasts from Acme.",
  version: "2.0.0",
  repository,
  remotes: [
    {
      type: "streamable-http",
      url: remoteUrl,
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
});
const packageServer = (version: string | undefined = "1.2.0") => ({
  name: "io.github.acme/weather",
  description: "Forecasts, run locally.",
  version: "1.2.0",
  repository,
  packages: [
    {
      registryType: "npm",
      identifier: "@acme/weather-mcp",
      ...(version === undefined ? {} : { version }),
      runtimeHint: "npx",
      transport: { type: "stdio" },
      packageArguments: [{ type: "named", name: "--region", valueHint: "region", isRequired: true }],
      environmentVariables: [
        { name: "WEATHER_API_KEY", description: "Acme key", isRequired: true, isSecret: true },
        { name: "UNITS", default: "metric" },
      ],
    },
  ],
});

/** The registry's answers, in `/v0.1` shape unless `old` says the registry only has `/v0`. */
function registry(servers: () => unknown[], old = false) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const missing = { ok: false, status: 404, json: async () => ({}) };
    if (path === "/v0.1/servers" && !old)
      return answer({ servers: servers().map((server) => ({ server, _meta: {} })) });
    if (path === "/v0/servers") return answer({ servers: servers() });
    return missing;
  };
  return { fetch, urls };
}

describe("MCP servers", () => {
  let w: World | undefined;
  const run = (name: string, body: unknown, meta?: unknown) => (w as World).h.cmd(name, body, meta);
  const must = async (name: string, body: unknown, meta?: unknown) => {
    const res = await run(name, body, meta);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const preview = async (body: Record<string, unknown>) => {
    const p = (await must("mcp.install", { org: "acme", ...body })) as McpPreview;
    expect(p.status).toBe("preview");
    return p;
  };
  const confirm = async (p: McpPreview) =>
    (await must("mcp.install", { confirm: p.previewId })) as Extract<
      McpInstallResult,
      { status: "installed" }
    >;
  const configText = () => readFile((w as World).h.majhi.services.config.file, "utf8");
  const audit = () =>
    (w as World).h.majhi.services.store.permissions
      .audit("")
      .map((r) => r.kind)
      .filter((k) => k.startsWith("mcp-"));

  async function start(servers: () => unknown[], old = false) {
    const reg = registry(servers, old);
    w = await taskWorld({ mcpFetch: reg.fetch });
    return reg;
  }

  beforeEach(startRemote);
  afterEach(async () => {
    remote?.closeAllConnections?.();
    remote?.close();
    seenAuth.length = 0;
    await w?.cleanup();
    w = undefined;
  });

  it("searches the registry and falls back to /v0", async () => {
    const reg = await start(() => [remoteServer(), packageServer()]);
    const found = (await must("mcp.search", { query: "weather" })) as {
      name: string;
      publisher: string;
      transports: string[];
      packages: string[];
      repository?: string;
      install: unknown;
    }[];
    expect(found.map((f) => f.name)).toEqual(["io.github.acme/weather-remote", "io.github.acme/weather"]);
    expect(found[0]).toMatchObject({
      publisher: "io.github.acme",
      repository: "https://github.com/acme/weather-mcp",
      transports: ["streamable-http"],
      install: { registry: "io.github.acme/weather-remote" },
    });
    expect(found[1]).toMatchObject({ transports: ["stdio"], packages: ["npm"] });
    expect(reg.urls[0]).toContain("/v0.1/servers?search=weather&version=latest");

    await w?.cleanup();
    const old = await start(() => [packageServer()], true);
    expect(await must("mcp.search", { query: "weather" })).toHaveLength(1);
    expect(old.urls.map((u) => new URL(u).pathname)).toEqual(["/v0.1/servers", "/v0/servers"]);
  });

  it("installs a registry server with a secret header as a connection, then Test lists its tools", async () => {
    await start(() => [remoteServer()]);
    const p = await preview({ registry: "io.github.acme/weather-remote" });
    expect(p).toMatchObject({
      org: "acme",
      id: "weather-remote",
      name: "Acme Weather",
      transport: "remote",
      protocol: "http",
      url: remoteUrl,
      source: {
        kind: "registry",
        publisher: "io.github.acme",
        repository: "https://github.com/acme/weather-mcp",
      },
      headers: [{ name: "Authorization", kind: "secret", required: true }],
    });
    // Nothing exists until the owner confirms.
    expect(await must("connections.list", {})).toEqual([]);

    const done = await confirm(p);
    expect(done.needs).toEqual([
      {
        list: "headers",
        name: "Authorization",
        required: true,
        description: "Your Acme key Format: Bearer {api_key}",
      },
    ]);
    expect(done.test).toBeUndefined();
    expect(done.connection).toMatchObject({ type: "mcp", org: "acme", agents: ["acme-builder"] });
    expect(done.connection.problems).toEqual(["Authorization is not set"]);

    await must("connections.setSecret", {
      id: "weather-remote",
      list: "headers",
      field: "Authorization",
      value: `Bearer ${KEY}`,
    });
    const test = (await must("connections.test", { id: "weather-remote" })) as ConnectionTestResult;
    expect(test).toMatchObject({ ok: true, tools: ["get_forecast"] });
    expect(seenAuth.at(-1)).toBe(`Bearer ${KEY}`);
    expect(await configText()).not.toContain(KEY);
    expect(audit()).toEqual(["mcp-install"]);
  });

  it("maps a package to a pinned command and holds the install until required values are given", async () => {
    await start(() => [packageServer()]);
    const first = await preview({ registry: "io.github.acme/weather" });
    expect(first.inputs).toEqual([
      { name: "UNITS", required: false, value: "metric" },
      { name: "--region", required: true },
    ]);
    const blocked = await run("mcp.install", { confirm: first.previewId });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain("--region");

    const p = await preview({ registry: "io.github.acme/weather", values: { "--region": "eu west" } });
    expect(p.command).toBe("npx -y @acme/weather-mcp@1.2.0 --region 'eu west'");
    expect(p.env).toEqual([
      { name: "WEATHER_API_KEY", kind: "secret", required: true, description: "Acme key" },
      { name: "UNITS", kind: "text", required: false, value: "metric" },
    ]);
    expect(p.source.package).toEqual({
      registryType: "npm",
      identifier: "@acme/weather-mcp",
      version: "1.2.0",
    });
    const done = await confirm(p);
    expect(done.needs).toEqual([
      { list: "env", name: "WEATHER_API_KEY", required: true, description: "Acme key" },
    ]);
    expect(await configText()).toContain("npx -y @acme/weather-mcp@1.2.0 --region 'eu west'");
  });

  it("refuses a package the registry does not pin", async () => {
    await start(() => [packageServer("latest")]);
    const res = await run("mcp.install", { org: "acme", registry: "io.github.acme/weather" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("pinned");
  });

  it("installs a local command, runs Test with the tool list, and warns when it is unpinned", async () => {
    await start(() => []);
    const p = await preview({
      command: `node ${FAKE_MCP}`,
      name: "Weather",
      env: { FAKE_MCP_REQUIRE: "UNITS", UNITS: "metric" },
    });
    expect(p).toMatchObject({
      transport: "local",
      id: "weather",
      env: [
        { name: "FAKE_MCP_REQUIRE", kind: "text", value: "UNITS" },
        { name: "UNITS", kind: "text", value: "metric" },
      ],
    });
    const done = await confirm(p);
    expect(done.needs).toEqual([]);
    expect(done.test).toMatchObject({ ok: true, tools: ["get_forecast", "list_stations", "set_alert"] });

    const loose = await preview({ command: "npx -y @acme/weather-mcp" });
    expect(loose.warnings.join(" ")).toContain("not pinned");
    expect((await preview({ command: "npx -y @acme/weather-mcp@1.2.0" })).warnings).toEqual([]);
  });

  it("takes a URL with headers, spots SSE, and refuses a key in the address", async () => {
    await start(() => []);
    const p = await preview({
      url: "https://mcp.acme.example/sse",
      headers: { "Api-Key": "abc", "X-Region": "eu" },
    });
    expect(p).toMatchObject({
      protocol: "sse",
      headers: [
        { name: "Api-Key", kind: "secret" },
        { name: "X-Region", kind: "text", value: "eu" },
      ],
    });
    expect(JSON.stringify(p)).not.toContain('"abc"');
    const done = await confirm(p);
    expect(done.connection.fields.protocol).toMatchObject({ value: "sse" });
    for (const url of [
      "https://u:p@mcp.acme.example/mcp",
      "https://mcp.acme.example/mcp?api_key=abc",
      "ftp://x.example/mcp",
    ]) {
      expect((await run("mcp.install", { org: "acme", url })).status).toBe(400);
    }
  });

  it("reads a pasted mcpServers snippet and never keeps a secret value from it", async () => {
    await start(() => []);
    const snippet = JSON.stringify({
      mcpServers: {
        weather: {
          command: "npx",
          args: ["-y", "@acme/weather-mcp@1.2.0"],
          env: { WEATHER_API_KEY: KEY, UNITS: "metric" },
        },
        logs: { url: "https://logs.acme.example/mcp", headers: { Authorization: `Bearer ${KEY}` } },
      },
    });
    const ambiguous = await run("mcp.install", { org: "acme", json: snippet });
    expect(ambiguous.status).toBe(400);
    expect(JSON.stringify(ambiguous.body)).toContain("pick");

    const p = await preview({ json: snippet, pick: "weather" });
    expect(p).toMatchObject({
      id: "weather",
      command: "npx -y @acme/weather-mcp@1.2.0",
      env: [
        { name: "WEATHER_API_KEY", kind: "secret" },
        { name: "UNITS", kind: "text", value: "metric" },
      ],
    });
    expect(p.warnings.join(" ")).toContain("WEATHER_API_KEY was not kept");
    expect(JSON.stringify(p)).not.toContain(KEY);
    await confirm(p);
    expect(await configText()).not.toContain(KEY);
    const remoteOne = await preview({ json: snippet, pick: "logs" });
    expect(remoteOne).toMatchObject({
      transport: "remote",
      headers: [{ name: "Authorization", kind: "secret" }],
    });
    expect(JSON.stringify(remoteOne)).not.toContain(KEY);
    expect((await run("mcp.install", { org: "acme", json: "{ not json" })).status).toBe(400);
  });

  it("reaches every agent of the org once installed, switches per agent only inside the org, and audits it", async () => {
    await start(() => []);
    await confirm(await preview({ command: `node ${FAKE_MCP}`, name: "Weather" }));
    const agents = async () =>
      ((await must("connections.get", { id: "weather" })) as { agents: string[] }).agents;
    expect(await agents()).toEqual(["acme-builder"]);

    await must("mcp.disable", { connection: "weather", agent: "acme-builder" });
    await must("mcp.disable", { connection: "weather", agent: "acme-builder" });
    expect(await agents()).toEqual([]);
    expect(((await must("connections.get", { id: "weather" })) as { agentsOff: string[] }).agentsOff).toEqual(
      ["acme-builder"],
    );
    expect(audit()).toEqual(["mcp-install", "mcp-disable"]);

    await must("mcp.enable", { connection: "weather", agent: "acme-builder" });
    expect(await agents()).toEqual(["acme-builder"]);
    expect(audit()).toEqual(["mcp-install", "mcp-disable", "mcp-enable"]);

    expect((await run("mcp.enable", { connection: "nope", agent: "acme-builder" })).status).toBe(404);
    expect((await run("mcp.enable", { connection: "weather", agent: "nobody" })).status).toBe(404);
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must("connections.create", {
      org: "globex",
      type: "mcp",
      name: "Globex logs",
      fields: { url: "https://logs.globex.example/mcp" },
    });
    const other = await run("mcp.enable", { connection: "globex-logs", agent: "acme-builder" });
    expect(other.status).toBe(400);
    expect(JSON.stringify(other.body)).toContain("own org");
  });

  it("restarts the agent's open session when a server is turned off or on, so its next run matches", async () => {
    await start(() => []);
    await confirm(await preview({ url: remoteUrl, name: "Weather" }));
    const task = (await must("tasks.create", {
      text: "check the forecast, repo api",
      repos: [{ project: "acme-api" }],
      start: true,
    })) as { id: string };
    await (w as World).h.majhi.services.runs.idle(task.id);
    const names = () => ((w as World).h.runtime.starts.at(-1)?.mcpServers ?? []).map((m) => m.name);
    expect(names()).toContain("weather");

    await must("mcp.disable", { connection: "weather", agent: "acme-builder" });
    await must("room.send", { task: task.id, text: "what is the forecast?" });
    await (w as World).h.majhi.services.runs.idle(task.id);
    expect(names()).not.toContain("weather");

    await must("mcp.enable", { connection: "weather", agent: "acme-builder" });
    await must("room.send", { task: task.id, text: "and now?" });
    await (w as World).h.majhi.services.runs.idle(task.id);
    expect(names()).toContain("weather");
  });

  it("asks for an org when there are several, and an agent confirms only its own preview", async () => {
    await start(() => []);
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    const none = await run("mcp.install", { command: `node ${FAKE_MCP}` });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body)).toContain("org");

    const owner = await preview({ command: `node ${FAKE_MCP}`, name: "Weather" });
    const agent = { actor: { kind: "agent", id: "acme-builder" } };
    expect((await run("mcp.install", { confirm: owner.previewId }, agent)).status).toBe(409);
    expect((await run("mcp.install", { confirm: "mcp_unknown" })).status).toBe(404);
    const own = (await must(
      "mcp.install",
      { org: "acme", command: `node ${FAKE_MCP}`, name: "Mine" },
      agent,
    )) as McpPreview;
    expect(((await must("mcp.install", { confirm: own.previewId }, agent)) as McpInstallResult).status).toBe(
      "installed",
    );
    // A preview is used once.
    expect((await run("mcp.install", { confirm: own.previewId }, agent)).status).toBe(404);
  });
});
