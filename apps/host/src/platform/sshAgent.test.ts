import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failed, fakeOs, ok } from "./fakeOs.ts";
import { linuxPlatform, parseEnvironment } from "./linux.ts";

describe("the SSH agent socket on Linux", () => {
  let tmp: string;
  let servers: Server[];
  beforeEach(async () => {
    // Short, because a socket path has a length limit.
    tmp = await mkdtemp(join(tmpdir(), "mj-"));
    await mkdir(join(tmp, "run"));
    servers = [];
  });
  afterEach(async () => {
    await Promise.all(servers.map(close));
    await rm(tmp, { recursive: true, force: true });
  });

  /** An agent that answers on `path`. */
  async function listen(path: string): Promise<Server> {
    const server = createServer((client) => client.end());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    servers.push(server);
    return server;
  }

  /** Stops an agent, which removes its socket file. */
  function close(server: Server): Promise<void> {
    servers = servers.filter((other) => other !== server);
    return new Promise((done) => server.close(() => done()));
  }

  /** A socket file nothing listens on, as an agent that was killed leaves behind. */
  async function deadSocket(path: string): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(`${path}.live`, resolve));
    // Closing removes the file the server knows, so it is moved out of the way first.
    await rename(`${path}.live`, path);
    await new Promise((done) => server.close(done));
  }

  /** The Linux platform, with `manager` as the systemd user manager's answer when given. */
  function linux(env: Record<string, string>, manager?: string) {
    const systemctl = (args: readonly string[]) =>
      args.join(" ") === "--user show-environment" && manager !== undefined ? ok(manager) : failed();
    const os = fakeOs({ env, majhiHome: tmp, programs: { "/usr/bin/systemctl": systemctl } });
    return { agent: linuxPlatform(os.deps).sshAgent, logs: os.logs };
  }

  it("takes the helper's own socket, then the systemd user manager's, then majhi's own agent", async () => {
    const own = join(tmp, "own.sock");
    const manager = join(tmp, "manager agent.sock");
    const majhi = join(tmp, "run", "agent.sock");
    await Promise.all([listen(own), listen(manager), listen(majhi)]);
    // systemd quotes a value with a space in it.
    const show = `HOME=/home/owner\nNORTHWIND_TOKEN=abc123\nSSH_AUTH_SOCK=$'${manager}'\n`;

    expect(await linux({ SSH_AUTH_SOCK: own }, show).agent.socket()).toBe(own);
    const fromManager = linux({}, show);
    expect(await fromManager.agent.socket()).toBe(manager);
    expect(await linux({}).agent.socket()).toBe(majhi);
  });

  it("passes over a dead socket, a file that is not a socket, a relative path and its own forwarder", async () => {
    const dead = join(tmp, "dead.sock");
    const plain = join(tmp, "plain");
    const compose = join(tmp, "run", "ssh-agent.sock");
    const majhi = join(tmp, "run", "agent.sock");
    await Promise.all([deadSocket(dead), writeFile(plain, ""), listen(compose)]);
    const majhiAgent = await listen(majhi);

    expect(await linux({ SSH_AUTH_SOCK: dead }, `SSH_AUTH_SOCK=${plain}\n`).agent.socket()).toBe(majhi);
    expect(await linux({ SSH_AUTH_SOCK: compose }, "SSH_AUTH_SOCK=run/agent.sock\n").agent.socket()).toBe(
      majhi,
    );

    await close(majhiAgent);
    const none = linux({ SSH_AUTH_SOCK: dead });
    expect(await none.agent.socket()).toBeUndefined();
  });

  it("reads systemd's $'...' quoting, with C escapes and UTF-8 bytes in octal", () => {
    expect(
      parseEnvironment(
        "HOME=/home/owner\nSSH_AUTH_SOCK=$'/run/user/1000/caf\\303\\251 agent\\x2fs.sock'\n" +
          "TABS=$'a\\tb\\\\c\\'d'\nEMPTY=\nnot a variable\n=x\n",
      ),
    ).toEqual({
      HOME: "/home/owner",
      SSH_AUTH_SOCK: "/run/user/1000/café agent/s.sock",
      TABS: "a\tb\\c'd",
      EMPTY: "",
    });
  });
});
