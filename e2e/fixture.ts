import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { E2E_ROOT } from "./paths.ts";

export { expect } from "@playwright/test";
export * from "./paths.ts";

/**
 * What a spec file's server starts with (written by home-seed.ts).
 *
 * - `empty`: first run, nothing set up.
 * - `roots`: past first run, with `~/Work` as the only root.
 * - `team`: what phase1.spec.ts sets up: org Acme; the login accounts claude-personal (Private),
 *   claude-acme-1 and claude-acme-2, signed in and healthy; the API-key account codex-key in Acme;
 *   the agents acme-lead and acme-reviewer on claude-acme-1, acme-builder on claude-acme-2, all with
 *   edit and shell; and the boss majhi-boss on claude-personal. No project is registered.
 * - `team-api`: `team`, plus ~/Work/alpha-api registered as Acme's project api (alias backend).
 */
export type Seed = "empty" | "roots" | "team" | "team-api";

export interface Home {
  seed: Seed;
  /**
   * Pause of the fake adapters between the steps of a turn, in ms. Default 0. Only specs that
   * watch a turn halfway (a pinned plan, Esc on a running turn) need one.
   */
  slow?: { claude?: number; codex?: number };
}

interface Server {
  url: string;
}

export const test = base.extend<object, { home: Home; server: Server }>({
  home: [{ seed: "empty" }, { scope: "worker", option: true }],
  server: [
    async ({ home }, use, workerInfo) => {
      const log = join(workerInfo.project.outputDir, `server-${workerInfo.workerIndex}.log`);
      const server = await startServer(home, log);
      try {
        await use({ url: server.url });
      } finally {
        await server.stop();
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],
  baseURL: async ({ server }, use) => use(server.url),
});

/**
 * Sets the home of this spec file's servers. Call it once, at the top of every spec file.
 *
 * Each call makes a new object, and Playwright keeps tests whose worker options differ in different
 * workers. So no two spec files ever share a worker, and so never a server or a majhi.yaml: each
 * worker starts its own server, on its own port, with its own throwaway home.
 */
export function useHome(home: Home): void {
  test.use({ home: { ...home } });
}

const START_SERVER = fileURLToPath(new URL("./start-server.ts", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(home: Home, logFile: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(dirname(logFile), { recursive: true });
  const out = openSync(logFile, "w");
  // Its own process group, so stopping it also stops the host helper and the fake agents.
  const child = spawn(process.execPath, ["--import", "tsx", START_SERVER], {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      MAJHI_E2E_ROOT: E2E_ROOT,
      MAJHI_E2E_PORT: String(port),
      MAJHI_E2E_SEED: home.seed,
      MAJHI_E2E_SLOW_CLAUDE: String(home.slow?.claude ?? 0),
      MAJHI_E2E_SLOW_CODEX: String(home.slow?.codex ?? 0),
    },
  });
  closeSync(out);
  let exited = false;
  const done = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const stop = async () => {
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 5_000);
    await done;
    clearTimeout(timer);
    kill("SIGKILL");
    rmSync(E2E_ROOT, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (exited) throw new Error("the e2e server exited while starting");
      if (Date.now() > deadline) throw new Error("the e2e server did not answer /health in 45 s");
      const ok = await fetch(`${url}/health`).then(
        (res) => res.ok,
        () => false,
      );
      if (ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (err) {
    await stop();
    const tail = readFileSync(logFile, "utf8").split("\n").slice(-30).join("\n");
    throw new Error(`${(err as Error).message}\n--- ${logFile} ---\n${tail}`);
  }
  return { url, stop };
}
