import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { NETGUARD, NETGUARD_CAPS, type RunnerConfig } from "@majhi/acp";
import { testBrowserNames } from "../containers/names.ts";
import { errorMessage } from "../errors.ts";
import type { ToolCaller } from "../rooms/access.ts";
import { dockerOf, waitForLine } from "./docker.ts";

/** Where `docker/testbrowserd.mjs` lives in the test browser image. */
const DAEMON = "/usr/local/lib/majhi/testbrowserd.mjs";
/** What it prints when its port is open. */
const READY_LINE = "majhi-testbrowserd ready";
/** The port it listens on (its default). */
const PORT = 3000;

export interface TestBrowserDeps {
  /** The test browser image (`majhi-testbrowser:dev`). */
  image: string;
  /** The runner network: the container joins it so majhi, which is on it, reaches it by name. No runner can (netguard). */
  network: string;
  /** How runners start: docker, its environment, the user and the limits. Read at each start. */
  runner: () => Pick<RunnerConfig, "docker" | "cliEnv" | "user" | "memory" | "cpus" | "pidsLimit">;
  /** The workspace of a task: `private` for a task with none. */
  orgOf: (task: string) => string;
  /** Runs `docker args`. Replaced in tests. */
  docker?: (args: string[]) => Promise<string>;
  /** How long to wait for the container's port. Default 30 s. */
  readyMs?: number;
}

/**
 * The test browser (SPEC 4.5): a Playwright server for a repo's own `playwright test`. A run is given
 * `PW_TEST_CONNECT_WS_ENDPOINT` pointing at majhi with its own bearer token; majhi finds the run's workspace from
 * the token, starts that workspace's container if it is not running, and passes the WebSocket on to it. So the
 * container starts only when a test first connects, the run never reaches it directly, and a container is never
 * used for another workspace: the workspace comes from the token, never from the request.
 */
export class TestBrowserService {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: TestBrowserDeps) {}

  /** The container that serves `task`'s workspace, started if needed. Resolves its name on the runner network. */
  ensureFor(task: string): Promise<string> {
    const org = this.deps.orgOf(task);
    return this.serialized(org, () => this.ensure(org));
  }

  /** Passes the upgrade of an authenticated run on to its workspace's container. */
  async open(caller: ToolCaller, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    let host: string;
    try {
      host = await this.ensureFor(caller.task);
    } catch (err) {
      const why = `The test browser did not start: ${errorMessage(err).split("\n", 1)[0]}`;
      socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\n${why}\r\n`);
      return;
    }
    const upstream = net.connect(PORT, host);
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    upstream.on("connect", () => {
      // The run's bearer token is for majhi. It does not go on.
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? "";
        if (name.toLowerCase() !== "authorization") lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }

  /** At start: test browser containers a previous majhi left go. */
  async reset(): Promise<void> {
    const docker = this.docker();
    const ids = (await docker(["ps", "-aq", "--filter", "label=majhi.container=testbrowser"]).catch(() => ""))
      .split("\n")
      .filter((l) => l !== "");
    if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => "");
  }

  private docker(): (args: string[]) => Promise<string> {
    return this.deps.docker ?? dockerOf(this.deps.runner());
  }

  /** One start or check at a time per workspace. */
  private serialized<T>(org: string, step: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(org) ?? Promise.resolve()).catch(() => undefined).then(step);
    this.queue.set(org, next);
    return next;
  }

  private async ensure(org: string): Promise<string> {
    const names = testBrowserNames(org);
    const docker = this.docker();
    const state = await docker(["inspect", "--format", "{{.State.Running}}", names.container]).catch(
      () => "",
    );
    if (state.trim() === "true") return names.container;
    await docker(["rm", "-f", names.container]).catch(() => "");
    const cfg = this.deps.runner();
    await docker([
      "run",
      "-d",
      "--rm",
      "--init",
      "--name",
      names.container,
      ...names.labelFlags(),
      "--network",
      this.deps.network,
      "--cap-drop",
      "ALL",
      ...NETGUARD_CAPS.flatMap((c) => ["--cap-add", c]),
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(cfg.pidsLimit ?? 2048),
      "--memory",
      cfg.memory ?? "4g",
      "--cpus",
      cfg.cpus ?? "1",
      this.deps.image,
      NETGUARD,
      cfg.user ?? "0:0",
      "--",
      "node",
      DAEMON,
    ]);
    await waitForLine(docker, names.container, READY_LINE, this.deps.readyMs ?? 30_000);
    return names.container;
  }
}
