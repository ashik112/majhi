import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { McpInstallResult, McpPreview } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

const FAKE_MCP = fileURLToPath(new URL("../testing/fake-mcp.mjs", import.meta.url));
const KEY = "weather-key-0123456789abcdef";

const repository = { url: "https://github.com/acme/weather-mcp", source: "github" };
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
  async function start(servers: () => unknown[], old = false) {
    const reg = registry(servers, old);
    w = await taskWorld({ mcpFetch: reg.fetch });
    return reg;
  }

  afterEach(async () => {
    await w?.cleanup();
    w = undefined;
  });

  it("refuses a package the registry does not pin", async () => {
    await start(() => [packageServer("latest")]);
    const res = await run("mcp.install", { org: "acme", registry: "io.github.acme/weather" });
    expect(res.status).toBe(400);
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

    const p = await preview({ json: snippet, pick: "weather" });
    expect(p).toMatchObject({
      id: "weather",
      command: "npx -y @acme/weather-mcp@1.2.0",
      env: [
        { name: "WEATHER_API_KEY", kind: "secret" },
        { name: "UNITS", kind: "text", value: "metric" },
      ],
    });
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

  it("asks for an org when there are several, and an agent confirms only its own preview", async () => {
    await start(() => []);
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    const none = await run("mcp.install", { command: `node ${FAKE_MCP}` });
    expect(none.status).toBe(400);

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
