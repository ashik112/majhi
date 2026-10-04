import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { type SessionStart, startSession } from "@majhi/acp";
import { fakeAdapter } from "@majhi/acp/testing";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { cacheEnv } from "../runs/package-cache.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** A run's variables without the workspace package-cache paths every run gets (no secrets in them). */
const noCaches = (env: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => k !== "MAJHI_TOOLS" && !(k in cacheEnv("/x"))));

/**
 * SPEC 7, Phase 10, Done when: asked why the api is down in prod, a root agent investigates with a
 * read-only kubectl connection and an MCP server, streams what it does, can be stopped midway and
 * resumed, writes a report, and proposes a fix task and a restart that both wait for the owner. An
 * org agent cannot use another org's connection. The fake ACP agent plays the agent, a fake kubectl
 * the cluster and a local HTTP server New Relic, so nothing spends tokens or reaches a network.
 */

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
  - { name: prod, cluster: { server: "https://prod.acme.example" } }
  - { name: staging, cluster: { server: "https://staging.acme.example" } }
contexts:
  - { name: prod, context: { cluster: prod, user: viewer } }
  - { name: staging, context: { cluster: staging, user: admin } }
users:
  - { name: viewer, user: { token: prod-viewer-token-0123456789 } }
  - { name: admin, user: { token: staging-admin-token-9876543210 } }
`;
const API_KEY = "NRAK-acme-0123456789abcdef";
const GLOBEX_TOKEN = "glx-live-0123456789abcdef";

let w: World | undefined;
let app: Server | undefined;
let newRelic: Server | undefined;
afterEach(async () => {
  app?.closeAllConnections?.();
  app?.close();
  newRelic?.close();
  await w?.cleanup();
  w = undefined;
  app = undefined;
  newRelic = undefined;
});

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A New Relic stand-in: an MCP server over HTTP that wants its Api-Key. */
async function startNewRelic(): Promise<string> {
  newRelic = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (req.headers["api-key"] !== API_KEY) {
        res.writeHead(401).end();
        return;
      }
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: msg.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "nr", version: "1" },
            }
          : msg.method === "tools/list"
            ? { tools: [{ name: "list_alerts", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "1 open alert: api error rate above 5% since 09:12" }] };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  const server = newRelic;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function world(slowMs: number) {
  w = await taskWorld();
  const { h } = w;
  const must = async (name: string, body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  // The cluster: a kubectl that lists a crashing pod, logs what it is asked and keeps its kubeconfig.
  // Without a kubeconfig it fails, like the real one.
  const bin = join(h.dir, "bin");
  const seen = join(h.dir, "kubectl-seen");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "kubectl"),
    `#!/bin/sh
echo "$*" >> "${seen}.log"
cp "$KUBECONFIG" "${seen}.kubeconfig" || exit 1
case "$1" in
  get) echo "NAME      READY   STATUS             RESTARTS"; echo "api-7d9   0/1     CrashLoopBackOff   14";;
  logs) echo "panic: connection refused to db:5432";;
  config) cat "$KUBECONFIG";;
  rollout) echo "deployment.apps/api restarted";;
  *) echo "ok";;
esac
`,
  );
  await chmod(join(bin, "kubectl"), 0o755);

  for (const [name, body] of [
    [
      "agents.create",
      {
        id: "ops-root",
        frontmatter: { scope: "root", role: "Root", account: "claude-acme", perms: ["edit", "shell"] },
        instructions: "Investigate.\n",
      },
    ],
    [
      "connections.create",
      {
        org: "acme",
        id: "acme-prod",
        type: "kubectl",
        name: "Acme prod",
        fields: { context: "prod", namespace: "api" },
      },
    ],
    [
      "connections.create",
      {
        org: "acme",
        id: "acme-newrelic",
        type: "mcp",
        name: "New Relic",
        fields: { url: await startNewRelic() },
        headers: { "Api-Key": { kind: "secret" } },
      },
    ],
  ] as const) {
    await must(name, body);
  }
  await must("connections.setSecret", {
    id: "acme-newrelic",
    field: "Api-Key",
    list: "headers",
    value: API_KEY,
  });
  const form = new FormData();
  form.append("file", new File([KUBECONFIG], "config"), "config");
  const upload = (await (
    await h.majhi.app.request("/api/uploads?for=connection", { method: "POST", body: form })
  ).json()) as {
    id: string;
  };
  await must("connections.setFile", { id: "acme-prod", field: "kubeconfig", upload: upload.id });

  // The real ACP engine with the fake agent, which reaches majhi's MCP servers on a real port.
  app = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  const listening = app;
  await new Promise<void>((resolve) => listening.once("listening", () => resolve()));
  h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/mcp`;
  h.env.runtime.base = { ...h.env.runtime.base, PATH: `${bin}:${h.env.runtime.base.PATH}` };
  h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true, slowMs }) };
  const starts: SessionStart[] = [];
  h.runtime.startSession = (start) => {
    starts.push(start);
    return startSession(start);
  };
  return { h, must, seen, starts };
}

async function items(task: string): Promise<RoomItem[]> {
  const page = await w?.h.cmd("room.items", { task, limit: 500 });
  return [...((page?.body.items ?? []) as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const tools = async (task: string) =>
  (await items(task)).filter((i): i is Extract<RoomItem, { type: "tool" }> => i.type === "tool");
const prompts = async (task: string) =>
  (await items(task)).filter(
    (i): i is Extract<RoomItem, { type: "permission" }> => i.type === "permission" && i.state === "pending",
  );
const output = (tool: Extract<RoomItem, { type: "tool" }> | undefined) =>
  (tool?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("Phase 10, done when", () => {
  it("a root agent investigates, is stopped and resumed, writes a report, and its fix task and restart wait for the owner", async () => {
    const { h, must, seen, starts } = await world(150);
    const runs = h.majhi.services.runs;
    const task = (await must("tasks.create", {
      text: "why is the api down in prod",
      team: ["ops-root"],
      connections: ["acme-prod", "acme-newrelic"],
      start: true,
    })) as { id: string; folder: string; kind: string };
    await runs.idle(task.id);
    // The task box's words make it an ops task.
    expect(task.kind).toBe("ops");

    // It investigates: reads stream into the room and run without asking. Esc stops it midway.
    await must("room.send", {
      task: task.id,
      text: [
        "run: kubectl get pods -n api",
        "run: kubectl config view --raw",
        "call: acme-newrelic/list_alerts {}",
        "run: kubectl logs api-7d9 -n api",
        "run: kubectl get events -n api",
      ].join("\n"),
    });
    await until(
      async () => (await tools(task.id)).some((t) => t.title === "list_alerts" && t.status === "completed"),
      "the alerts",
    );
    await must("room.cancel", { task: task.id });
    await runs.idle(task.id);
    const read = await tools(task.id);
    expect(read.some((t) => t.title === "kubectl get events -n api")).toBe(false);
    const pods = read.find((t) => t.title === "kubectl get pods -n api");
    expect(pods?.status).toBe("completed");
    expect(output(pods)).toContain("CrashLoopBackOff");
    const alerts = read.find((t) => t.title === "list_alerts");
    expect(output(alerts)).toContain("api error rate above 5%");
    expect(await prompts(task.id)).toEqual([]);
    // The run's kubeconfig holds only the connection's context.
    const kubeconfig = await readFile(`${seen}.kubeconfig`, "utf8");
    expect(kubeconfig).toContain("current-context: acme-prod");
    expect(kubeconfig).not.toContain("staging-admin-token");

    // The owner stops the task midway: the turn ends and the run's connection files go.
    await must("room.send", {
      task: task.id,
      text: [
        "run: kubectl describe pod api-7d9 -n api",
        "run: kubectl get deployments -n api",
        "run: kubectl get replicasets -n api",
      ].join("\n"),
    });
    await until(
      async () => (await tools(task.id)).some((t) => t.title === "kubectl describe pod api-7d9 -n api"),
      "the first step",
    );
    const first = starts.at(-1)?.env?.KUBECONFIG ?? "";
    expect(existsSync(first)).toBe(true);
    await must("tasks.stop", { id: task.id });
    expect(await must("tasks.get", { id: task.id })).toMatchObject({
      status: "paused",
      pausedReason: "owner",
    });
    await until(() => !existsSync(dirname(first)), "the run's files to go");
    expect((await tools(task.id)).some((t) => t.title === "kubectl get replicasets -n api")).toBe(false);

    // Resumed: the same session comes back with files of its own, and it writes the report.
    await must("tasks.start", { id: task.id });
    await must("room.send", { task: task.id, text: "create REPORT.md" });
    await runs.idle(task.id);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.resume).toBeDefined();
    const second = starts[1]?.env?.KUBECONFIG ?? "";
    expect(second).not.toBe(first);
    expect(existsSync(second)).toBe(true);
    expect(
      (await items(task.id)).some((i) => i.type === "system" && i.text.includes("@ops-root resumed")),
    ).toBe(true);
    expect(await must("tasks.report", { id: task.id })).toMatchObject({ content: "# Health\n\nok\n" });

    // It proposes a fix task, a follow-up of this one. The owner approves the proposal, and the fix
    // task still waits for the owner to approve its start.
    const card = async (command: string) =>
      (await items(task.id)).find(
        (i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval" && i.command === command,
      );
    await must("room.send", {
      task: task.id,
      text: `call: majhi-tasks/create {"title":"Retry the db connection on start","text":"Retry the db connection on start in repo api.","repos":[{"project":"acme-api"}],"followUpOf":"${task.id}"}`,
    });
    await runs.idle(task.id);
    await must("room.approve", {
      task: task.id,
      item: (await card("tasks.create"))?.id,
      decision: "approve",
    });
    await runs.idle(task.id);
    const fix = h.majhi.services.tasks
      .list(true)
      .map((t) => h.majhi.services.tasks.get(t.id))
      .find((t) => t.links.some((l) => l.type === "follow-up" && l.task === task.id));
    expect(fix?.repos.map((r) => r.project)).toEqual(["acme-api"]);
    await must("room.send", { task: task.id, text: `call: majhi-tasks/start {"id":"${fix?.id}"}` });
    await runs.idle(task.id);
    expect(await card("tasks.start")).toMatchObject({ state: "pending" });
    expect(h.majhi.services.tasks.get(fix?.id ?? "").status).not.toBe("running");

    // The restart waits for the owner, then runs, and leaves an audit row.
    await must("room.send", { task: task.id, text: "run: kubectl rollout restart deployment/api -n api" });
    await until(async () => (await prompts(task.id)).length === 1, "the restart prompt");
    const [restart] = await prompts(task.id);
    expect(restart?.connection).toMatchObject({
      id: "acme-prod",
      name: "Acme prod",
      action: "kubectl rollout restart deployment/api -n api",
    });
    expect(restart?.options.some((o) => o.kind === "allow_always")).toBe(false);
    expect(await readFile(`${seen}.log`, "utf8")).not.toContain("rollout");
    await must("room.permission", { task: task.id, item: restart?.id, option: "allow" });
    await runs.idle(task.id);
    expect(await readFile(`${seen}.log`, "utf8")).toContain("rollout restart deployment/api -n api");
    expect(output((await tools(task.id)).find((t) => t.title.startsWith("kubectl rollout")))).toContain(
      "restarted",
    );
    expect(h.majhi.services.store.permissions.audit(task.id)).toContainEqual(
      expect.objectContaining({
        kind: "connection-write",
        decision: "allow",
        by: "owner",
        detail: "acme-prod: kubectl rollout restart deployment/api -n api",
      }),
    );
    // No value reached the room: the token kubectl printed shows as its name.
    expect(output((await tools(task.id)).find((t) => t.title === "kubectl config view --raw"))).toContain(
      "[secret acme-prod.kubeconfig]",
    );
    const room = JSON.stringify(await items(task.id));
    expect(room).not.toContain("prod-viewer-token-0123456789");
    expect(room).not.toContain(API_KEY);
    // A full session with stops and restarts: about 8 s, past the 5 s default.
  }, 30_000);

  it("an org agent gets its own org's connections and nothing of another org's, in its variables or its MCP servers", async () => {
    const { h, must, starts } = await world(0);
    const runs = h.majhi.services.runs;
    await w?.addRepo("web");
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must("projects.register", {
      id: "globex-web",
      org: "globex",
      path: "~/Work/web",
      aliases: ["web"],
    });
    await must("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
    await must("connections.create", {
      org: "globex",
      id: "globex-keys",
      type: "env",
      name: "Globex keys",
      fields: { clis: "globex" },
      vars: { GLOBEX_TOKEN: { kind: "secret" } },
    });
    await must("connections.setSecret", {
      id: "globex-keys",
      field: "GLOBEX_TOKEN",
      list: "vars",
      value: GLOBEX_TOKEN,
    });
    // Its file names Acme's connections too, as a hand edit could.
    await must("agents.create", {
      id: "globex-builder",
      frontmatter: {
        scope: "globex",
        role: "Builder",
        account: "claude-globex",
        where: ["globex", "acme"],
        perms: ["edit", "shell"],
        connections: ["globex-keys", "acme-prod", "acme-newrelic"],
      },
      instructions: "Build.\n",
    });

    // In a Globex task it gets its own connection only.
    const own = (await must("tasks.create", {
      text: "check the web, repo web",
      repos: [{ project: "globex-web" }],
      kind: "ops",
      team: ["globex-builder"],
      start: true,
    })) as { id: string };
    await runs.idle(own.id);
    expect(starts).toHaveLength(1);
    expect(noCaches(starts[0]?.env)).toEqual({ GLOBEX_TOKEN });
    const ownServers = (starts[0]?.mcpServers ?? []).map((s) => s.name);
    expect(ownServers).toContain("majhi-connections");
    expect(ownServers).not.toContain("acme-newrelic");
    await must("room.send", {
      task: own.id,
      text: 'call: majhi-connections/list {}\ncall: majhi-connections/attach {"id":"acme-prod"}',
    });
    await runs.idle(own.id);
    const used = await tools(own.id);
    const list = output(used.find((t) => t.title === "list"));
    expect(list).toContain("globex-keys");
    expect(list).not.toContain("acme-prod");
    expect(list).not.toContain("acme-newrelic");
    expect(output(used.find((t) => t.title === "attach"))).toContain("Only root agents attach connections.");

    // In an Acme task it works in, it gets none: neither Acme's nor its own org's.
    const other = (await must("tasks.create", {
      text: "check the api, repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      team: ["globex-builder"],
      start: true,
    })) as { id: string };
    await runs.idle(other.id);
    expect(starts).toHaveLength(2);
    expect(noCaches(starts[1]?.env)).toEqual({});
    const otherServers = (starts[1]?.mcpServers ?? []).map((s) => s.name);
    expect(otherServers).toContain("majhi-room");
    expect(otherServers).not.toContain("acme-newrelic");
    expect(otherServers).not.toContain("majhi-connections");
    for (const start of starts) {
      expect(JSON.stringify(start)).not.toContain(API_KEY);
      expect(JSON.stringify(start)).not.toContain("prod-viewer-token");
    }
  });
});
