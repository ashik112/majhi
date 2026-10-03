/**
 * The SSH agent socket majhi's server container uses on Linux and WSL2 (decision 2). The helper
 * listens on `~/.majhi/run/ssh-agent.sock` and pipes each connection to the agent it loads keys
 * into, so the container's path stays the same when that agent restarts, changes or appears after
 * login. Failures go to the log. What passes through, requests and signatures, never does.
 */
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { errorMessage } from "../errors.ts";
import type { Logger } from "../log.ts";

export interface ForwarderOptions {
  /** Where to listen. Its folder is made 0700, which keeps everyone else out from the start. */
  path: string;
  /**
   * The agent to forward to, or undefined when there is none. With `failed`, the socket that just
   * refused a connection, it is looked up again instead of answered from what was found last.
   */
  upstream: (failed?: string) => Promise<string | undefined>;
  log: Logger;
}

function connect(path: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const failed = (): void => {
      socket.destroy();
      resolve(undefined);
    };
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      resolve(socket);
    });
  });
}

/** True when something listens on the socket at `path`. A dead socket file or any other file is false. */
export async function reachable(path: string): Promise<boolean> {
  const socket = await connect(path);
  socket?.destroy();
  return socket !== undefined;
}

/** Starts listening and returns a function that stops. Never throws: failures are logged. */
export function serveAgent(options: ForwarderOptions): () => void {
  const { path, log } = options;
  const open = new Set<Socket>();
  let stopped = false;
  let noted = "";
  const note = (message: string): void => {
    if (message === noted) return;
    noted = message;
    log(`ssh-agent forwarder: ${message}`);
  };

  /** A connection to the agent found last, else to one looked up again. */
  const reach = async (): Promise<Socket | undefined> => {
    let target = await options.upstream();
    let agent = target === undefined ? undefined : await connect(target);
    if (agent === undefined && target !== undefined) {
      target = await options.upstream(target);
      agent = target === undefined ? undefined : await connect(target);
    }
    if (target === undefined) note("no agent to forward to");
    else if (agent === undefined) note(`cannot reach the agent at ${target}`);
    else note(`forwarding to ${target}`);
    return agent;
  };

  const track = (socket: Socket): void => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  };

  const server = createServer({ allowHalfOpen: true }, (client) => {
    track(client);
    client.on("error", () => client.destroy());
    // What the client sends first waits in its buffer until the pipe below reads it.
    void reach()
      .catch(() => undefined)
      .then((agent) => {
        if (agent === undefined) {
          client.destroy();
          return;
        }
        if (stopped || client.destroyed) {
          agent.destroy();
          return;
        }
        track(agent);
        agent.on("error", () => client.destroy());
        client.on("error", () => agent.destroy());
        client.on("close", () => agent.destroy());
        // An agent that ended or went away: the client gets what was sent, then the end.
        agent.on("close", () => client.end());
        client.pipe(agent);
        agent.pipe(client);
      });
  });

  const start = async (): Promise<void> => {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const existing = await lstat(path).catch(() => undefined);
    if (existing !== undefined) {
      if (!existing.isSocket()) {
        log(`ssh-agent forwarder: ${path} is not a socket, so it was left alone and the forwarder is off`);
        return;
      }
      if (await reachable(path)) {
        log(`ssh-agent forwarder: another helper is serving ${path}, so this one is off`);
        return;
      }
      // Left by a helper that was killed. Nothing listens on it.
      await unlink(path);
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => log(`ssh-agent forwarder: ${errorMessage(err)}`));
    await chmod(path, 0o600);
    if (stopped) server.close();
    else log(`ssh-agent forwarder: listening on ${path}`);
  };
  void start().catch((err) => log(`ssh-agent forwarder: cannot listen on ${path}: ${errorMessage(err)}`));

  return () => {
    stopped = true;
    for (const socket of open) socket.destroy();
    server.close();
  };
}
