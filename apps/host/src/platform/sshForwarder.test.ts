import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reachable, serveAgent } from "./sshForwarder.ts";

/** Waits until `check` holds. It has no deadline of its own: the test's timeout is the only clock. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Sends `request` through the socket at `path` and collects what comes back until it closes. A
 * reset counts as closed: a socket closed before reading the request resets the other end.
 */
function exchange(path: string, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let got = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      got += chunk;
    });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(got));
    socket.on("connect", () => socket.end(request));
  });
}

describe("the ssh-agent forwarder", () => {
  let tmp: string;
  let path: string;
  let logs: string[];
  let stops: (() => void)[];
  let agents: { server: Server; open: Set<Socket> }[];
  beforeEach(async () => {
    // Short, because a socket path has a length limit.
    tmp = await mkdtemp(join(tmpdir(), "mj-"));
    path = join(tmp, "run", "ssh-agent.sock");
    logs = [];
    stops = [];
    agents = [];
  });
  afterEach(async () => {
    for (const stop of stops) stop();
    await Promise.all(agents.map(stopAgent));
    await rm(tmp, { recursive: true, force: true });
  });

  /** An agent on `socket` that answers each request with `name:` and the request, then ends. */
  async function agentAt(socket: string, name: string) {
    const open = new Set<Socket>();
    const server = createServer((client) => {
      open.add(client);
      client.on("close", () => open.delete(client));
      client.on("data", (chunk) => client.write(`${name}:${chunk}`));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const agent = { server, open };
    agents.push(agent);
    return agent;
  }

  /** Stops an agent and its connections, which removes its socket file. */
  function stopAgent(agent: { server: Server; open: Set<Socket> }): Promise<void> {
    agents = agents.filter((other) => other !== agent);
    for (const socket of agent.open) socket.destroy();
    return new Promise((done) => agent.server.close(() => done()));
  }

  /** Starts the forwarder and waits until it listens. */
  async function serve(upstream: (failed?: string) => Promise<string | undefined>): Promise<() => void> {
    const stop = serveAgent({ path, upstream, log: (line) => logs.push(line) });
    stops.push(stop);
    await until(() => logs.some((line) => line.includes("listening on") || line.includes("is off")));
    return stop;
  }

  it("pipes bytes both ways on a socket only the owner can use", async () => {
    await mkdir(join(tmp, "run"), { mode: 0o755 });
    const upstream = join(tmp, "agent.sock");
    await agentAt(upstream, "agent");
    await serve(async () => upstream);

    expect(await exchange(path, "sign this")).toBe("agent:sign this");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(tmp, "run"))).mode & 0o777).toBe(0o700);
    expect(logs).toEqual([
      `ssh-agent forwarder: listening on ${path}`,
      `ssh-agent forwarder: forwarding to ${upstream}`,
    ]);
    // What passed through is never logged.
    expect(logs.join("\n")).not.toContain("sign this");
  });

  it("replaces a socket a killed helper left behind, and removes its own when it stops", async () => {
    await mkdir(join(tmp, "run"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(`${path}.old`, resolve));
    // Closing removes the file the server knows, so it is moved out of the way first.
    await rename(`${path}.old`, path);
    await new Promise((done) => server.close(done));
    expect(await reachable(path)).toBe(false);

    const upstream = join(tmp, "agent.sock");
    await agentAt(upstream, "agent");
    const stop = await serve(async () => upstream);
    expect(await exchange(path, "hello")).toBe("agent:hello");

    stop();
    await until(async () => (await lstat(path).catch(() => undefined)) === undefined);
  });

  it("leaves a file that is not a socket, and a socket another helper serves, alone", async () => {
    await mkdir(join(tmp, "run"));
    await writeFile(path, "keep me");
    await serve(async () => undefined);
    expect(logs).toEqual([
      `ssh-agent forwarder: ${path} is not a socket, so it was left alone and the forwarder is off`,
    ]);
    expect(await readFile(path, "utf8")).toBe("keep me");

    await rm(path);
    await agentAt(path, "other helper");
    logs.length = 0;
    await serve(async () => undefined);
    expect(logs).toEqual([`ssh-agent forwarder: another helper is serving ${path}, so this one is off`]);
    expect(await exchange(path, "hello")).toBe("other helper:hello");
  });

  it("closes the client when there is no agent to forward to", async () => {
    await serve(async () => undefined);
    expect(await exchange(path, "hello")).toBe("");
    expect(logs).toContain("ssh-agent forwarder: no agent to forward to");
  });

  it("looks the agent up again when the one it used went away", async () => {
    const first = join(tmp, "first.sock");
    const second = join(tmp, "second.sock");
    const old = await agentAt(first, "first");
    let current = first;
    const asked: (string | undefined)[] = [];
    await serve(async (failed) => {
      asked.push(failed);
      if (failed !== undefined) current = second;
      return current;
    });
    expect(await exchange(path, "one")).toBe("first:one");

    await stopAgent(old);
    await agentAt(second, "second");
    expect(await exchange(path, "two")).toBe("second:two");
    expect(asked).toEqual([undefined, undefined, first]);
    expect(logs).toContain(`ssh-agent forwarder: forwarding to ${second}`);
  });
});
