import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpServerSpec } from "@majhi/acp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { cacheEnv } from "../runs/package-cache.ts";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { runFilesRoot } from "./run-files.ts";

/** A run's variables without the workspace package-cache paths every run gets (no secrets in them). */
const noCaches = (env: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).filter(([k]) => k !== "MAJHI_TOOLS" && !(k in cacheEnv("/x"))),
  );

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://prod.acme.example" } }]
contexts: [{ name: prod, context: { cluster: c, user: viewer } }]
users: [{ name: viewer, user: { token: prod-viewer-token-0123456789 } }]
`;
const API_KEY = "NRAK-acme-0123456789abcdef";

describe("a run's connections", () => {
  let w: World;
  const must = async (name: string, body: unknown) => {
    const res = await w.h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  beforeEach(async () => {
    w = await taskWorld({ agent: { connections: ["acme-prod", "acme-newrelic"] } });
    await must("connections.create", {
      org: "acme",
      id: "acme-prod",
      type: "kubectl",
      name: "Acme prod",
      fields: { context: "prod", namespace: "api" },
    });
    const form = new FormData();
    form.append("file", new File([KUBECONFIG], "config"), "config");
    const res = await w.h.majhi.app.request("/api/uploads?for=connection", { method: "POST", body: form });
    const upload = (await res.json()) as { id: string };
    await must("connections.setFile", { id: "acme-prod", field: "kubeconfig", upload: upload.id });
    await must("connections.create", {
      org: "acme",
      id: "acme-newrelic",
      type: "mcp",
      name: "New Relic",
      fields: { url: "https://mcp.newrelic.com/mcp" },
      headers: { "Api-Key": { kind: "secret" } },
    });
    await must("connections.setSecret", {
      id: "acme-newrelic",
      field: "Api-Key",
      list: "headers",
      value: API_KEY,
    });
    // Globex: its own connection, and an agent that may also work in acme.
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
    await must("agents.create", {
      id: "globex-builder",
      frontmatter: {
        scope: "globex",
        role: "Builder",
        account: "claude-globex",
        where: ["globex", "acme"],
        perms: ["edit", "shell"],
        connections: ["globex-prod", "acme-prod"],
      },
      instructions: "Build.\n",
    });
    await must("connections.create", {
      org: "globex",
      id: "globex-prod",
      type: "ssh",
      name: "Globex box",
      fields: { alias: "globex-box" },
    });
  });
  afterEach(() => w.cleanup());

  it("gets its org's listed connections: variables, a kubeconfig of its own, MCP servers and a read-only folder", async () => {
    const task = (await must("tasks.create", {
      text: "why is the api slow? repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      start: true,
    })) as {
      id: string;
    };
    await w.h.majhi.services.runs.idle(task.id);
    const start = w.h.runtime.starts.at(-1);
    const kubeconfig = start?.env?.KUBECONFIG ?? "";
    const dir = dirname(kubeconfig);
    expect(dirname(dir)).toBe(runFilesRoot(w.h.env.majhiHome));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(kubeconfig)).mode & 0o777).toBe(0o600);
    expect(parse(await readFile(kubeconfig, "utf8"))["current-context"]).toBe("acme-prod");
    expect(start?.mounts).toContainEqual({ path: dir, readOnly: true });
    const servers = (start?.mcpServers ?? []) as McpServerSpec[];
    expect(servers.find((s) => s.name === "acme-newrelic")).toEqual({
      type: "http",
      name: "acme-newrelic",
      url: "https://mcp.newrelic.com/mcp",
      headers: { "Api-Key": API_KEY },
    });

    // TASK.md lists them, never a value.
    const brief = await readFile(join(w.taskDir(task.id), "TASK.md"), "utf8");
    expect(brief).not.toContain(API_KEY);

    // The folder goes with the session.
    await must("tasks.stop", { id: task.id });
    const gone = async () =>
      stat(dir).then(
        () => false,
        () => true,
      );
    await until(gone);
  });

  it("gives an org agent nothing of another org, even where it may work", async () => {
    const task = (await must("tasks.create", {
      text: "check the api logs, repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      team: ["globex-builder"],
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(task.id);
    const start = w.h.runtime.starts.at(-1);
    expect(noCaches(start?.env)).toEqual({});
    const names = (start?.mcpServers ?? []).map((s) => s.name);
    expect(names).not.toContain("acme-newrelic");
    expect(names).not.toContain("globex-prod");
    expect(JSON.stringify(start)).not.toContain(API_KEY);
    expect(await readdir(runFilesRoot(w.h.env.majhiHome)).catch(() => [])).toEqual([]);
  });
});
