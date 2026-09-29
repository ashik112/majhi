import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ServerEvent, TerminalServerMessage } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventHub } from "../events/hub.ts";
import { attachSockets } from "../sockets.ts";
import { tempDir } from "../testing/fixtures.ts";
import { type Harness, harness } from "../testing/harness.ts";
import { TerminalManager } from "./manager.ts";

const ENV = { PATH: "/usr/bin:/bin" };

describe("login terminals over WebSocket", () => {
  let server: Server;
  let base: string;
  let terminals: TerminalManager;
  let events: EventHub;
  let close: () => void;

  beforeEach(async () => {
    terminals = new TerminalManager({ removeAfterExitMs: 200 });
    events = new EventHub();
    server = createServer();
    ({ close } = attachSockets(server, {
      events,
      terminals,
      rooms: { snapshot: () => undefined, subscribe: () => () => {} },
    }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    terminals.closeAll();
    close();
    await new Promise((r) => server.close(r));
  });

  /** Connects and collects messages. */
  async function join(path: string, headers: Record<string, string> = {}) {
    const ws = new WebSocket(`${base}${path}`, { headers });
    const messages: TerminalServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const text = () => messages.flatMap((m) => (m.type === "output" ? [m.data] : [])).join("");
    const until = async (check: () => boolean, tries = 100) => {
      for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(check()).toBe(true);
    };
    return { ws, messages, text, until };
  }

  const start = (script: string, onExit?: () => Promise<undefined>) =>
    terminals.start({
      key: "k",
      command: "/bin/sh",
      args: ["-c", script],
      env: ENV,
      cwd: "/tmp",
      ...(onExit ? { onExit } : {}),
    });

  it("runs a command in a pty: input in, output and exit out", async () => {
    const terminal = start("read x; echo got $x");
    const client = await join(`/api/term/${terminal.id}`);

    client.ws.send(JSON.stringify({ type: "input", data: "hello\n" }));
    await client.until(() => client.messages.some((m) => m.type === "exit"));

    expect(client.text()).toContain("got hello");
    expect(client.messages.at(-1)).toEqual({ type: "exit", code: 0 });
    client.ws.close();
  });

  it("caps the buffer at 256 KB, keeping the end", async () => {
    const terminal = start(
      "echo line-0-start; yes line-x-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -n 8000; echo THE-END",
    );
    const client = await join(`/api/term/${terminal.id}`);
    await client.until(() => client.messages.some((m) => m.type === "exit"), 600);
    client.ws.close();

    const late = await join(`/api/term/${terminal.id}`);
    await late.until(
      () => late.messages.some((m) => m.type === "exit") && late.text().includes("THE-END"),
      600,
    );
    expect(late.text().length).toBeLessThanOrEqual(256 * 1024);
    expect(late.text()).toContain("THE-END");
    expect(late.text()).not.toContain("line-0-");
    late.ws.close();
  });

  it("kills the old terminal when the same key starts again, and removes ended ones", async () => {
    const first = start("sleep 30");
    const second = start("sleep 30");
    for (let i = 0; i < 100 && !first.exited; i++) await new Promise((r) => setTimeout(r, 50));
    expect(first.exited).toBe(true);
    expect(second.exited).toBe(false);

    second.kill();
    await new Promise((r) => setTimeout(r, 600));
    expect(terminals.get(second.id)).toBeUndefined();
  });

  it("rejects foreign origins on both sockets and unknown terminals", async () => {
    const terminal = start("sleep 5");
    const rejected = (path: string, origin?: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${base}${path}`, origin === undefined ? {} : { headers: { origin } });
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => {
          ws.close();
          resolve(101);
        });
      });

    expect(await rejected("/api/events", "https://evil.example")).toBe(403);
    expect(await rejected(`/api/term/${terminal.id}`, "https://evil.example")).toBe(403);
    expect(await rejected("/api/term/unknown-id")).toBe(404);
    expect(await rejected("/api/nothing")).toBe(404);
    expect(await rejected("/api/events", "http://localhost:5173")).toBe(101);
    expect(await rejected(`/api/term/${terminal.id}`, "http://127.0.0.1:7070")).toBe(101);
  });
});

describe("accounts.login.start", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  it("runs the tool's login in the account home, checks health on success and tells clients", async () => {
    h = await harness();
    await h.cmd("orgs.create", { id: "acme", name: "Acme" });
    await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    await h.cmd("accounts.create", {
      id: "claude-key",
      tool: "claude",
      org: "acme",
      auth: "api-key",
      apiKey: "sk-test-fake-0000",
    });
    h.runtime.login = {
      command: "/bin/sh",
      args: ["-c", "pwd; read code; echo signed-in-$code"],
      env: ENV,
      display: "claude auth login",
    };

    const server = createServer();
    h.majhi.attach(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const seen: ServerEvent[] = [];
    h.majhi.services.events.subscribe((e) => seen.push(e));

    try {
      const bad = await h.cmd("accounts.login.start", { id: "claude-key" });
      expect(bad.status).toBe(400);
      expect((await h.cmd("accounts.login.start", { id: "nope" })).status).toBe(404);
      const res = await h.cmd("accounts.login.start", { id: "claude-acme" });
      expect(res.status).toBe(200);
      expect(res.body.command).toBe("claude auth login");

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/term/${res.body.terminalId}`);
      const messages: TerminalServerMessage[] = [];
      ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.once("open", r));
      ws.send(JSON.stringify({ type: "input", data: "abc123\n" }));
      for (let i = 0; i < 100 && !messages.some((m) => m.type === "exit"); i++)
        await new Promise((r) => setTimeout(r, 50));
      const output = messages.flatMap((m) => (m.type === "output" ? [m.data] : [])).join("");
      expect(output).toContain(join(h.env.majhiHome, "accounts/claude-acme"));
      expect(output).toContain("signed-in-abc123");
      const exit = messages.at(-1);
      expect(exit).toMatchObject({ type: "exit", code: 0, health: { ok: true } });
      expect(seen.some((e) => e.topics.includes("accounts"))).toBe(true);
      expect(h.runtime.probes).toHaveLength(1);
      expect(
        (await h.cmd("accounts.list")).body.find((a: { id: string }) => a.id === "claude-acme").status,
      ).toBe("healthy");
      ws.close();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

void tempDir;
