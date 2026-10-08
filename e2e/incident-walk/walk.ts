// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The incident journey, end to end, on a throwaway majhi (port 7490) with fakes: Slack on 7491, GitLab on 7492, the
 * watched database on 7493. Nothing reaches a real host. Each stage prints PASS or FAIL and takes a screenshot into
 * WALK_SHOTS. Run from the repository root:
 *
 *   node --import tsx e2e/incident-walk/walk.ts [stage ...]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { FakeSlack } from "../../apps/server/src/chat/testing/fake-slack.ts";
import { startFakeHosts } from "../../apps/server/src/deploy/testing/fake-hosts.ts";
import { fakeAdapter } from "../../packages/acp/testing/index.ts";
import { E2E_ROOT, HOST_HOME } from "../paths.ts";

/** The walk's ports: the majhi server, then the fake Slack, GitLab and database after it. `WALK_PORT` moves them all, so two walks can run side by side. */
export const PORT = Number(process.env.WALK_PORT ?? 7490);
export const SLACK_PORT = PORT + 1;
export const GITLAB_PORT = PORT + 2;
export const DB_PORT = PORT + 3;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.WALK_SHOTS ?? join(E2E_ROOT, "..", `majhi-walk-shots-${PORT}`);
const REPLIES = join(E2E_ROOT, "..", `majhi-walk-replies-${PORT}.json`);
mkdirSync(SHOTS, { recursive: true });

export type Reply = { when: string; flags?: string; say: string };
export function setReplies(rules: Reply[]): void {
  writeFileSync(REPLIES, JSON.stringify({ rules }));
}

export const results: { stage: string; ok: boolean; note: string }[] = [];
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function cmd<T = any>(name: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${BASE}/api/cmd/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text.slice(0, 400)}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

export async function until<T>(
  what: string,
  read: () => Promise<T | undefined | false>,
  ms = 60_000,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await read();
      if (v !== undefined && v !== false) return v;
    } catch (err) {
      last = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last === undefined ? "" : `: ${String(last)}`}`);
}

export interface World {
  slack: FakeSlack;
  hosts: Awaited<ReturnType<typeof startFakeHosts>>;
  db: { usage: number };
  dbServer: Server;
  server: ChildProcess;
  page: Page;
  close: () => Promise<void>;
}

export async function boot(): Promise<World> {
  const slack = await new FakeSlack().listen(SLACK_PORT);
  slack.addUser({ id: "U0SARA", name: "sara", real_name: "Sara Client" });
  slack.addChannel({ id: "C0CLIENT", name: "acme-client" });
  const hosts = await startFakeHosts({ port: GITLAB_PORT });
  const db = { usage: 42 };
  const dbServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ db: { usage: db.usage } }));
  });
  await new Promise<void>((r) => dbServer.listen(DB_PORT, "127.0.0.1", r));
  setReplies([]);
  const log = openSync(join(E2E_ROOT, "..", `majhi-walk-server-${PORT}.log`), "w");
  const server = spawn(process.execPath, ["--import", "tsx", "e2e/incident-walk/server.ts"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      MAJHI_E2E_PORT: String(PORT),
      MAJHI_E2E_ROOT: E2E_ROOT,
      WALK_REPLIES: REPLIES,
      WALK_GITLAB: `127.0.0.1:${GITLAB_PORT}`,
      WALK_SLACK_API: `http://127.0.0.1:${SLACK_PORT}/api`,
    },
  });
  await until("the server", async () => (await fetch(`${BASE}/health`)).ok, 90_000);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("majhi.appearance", JSON.stringify({ theme: "light", accent: "blue" }));
    } catch {
      // No storage: the default theme.
    }
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{backdrop-filter:none!important}";
    document.documentElement.append(style);
  });
  const page = await context.newPage();
  return {
    slack,
    hosts,
    db,
    dbServer,
    server,
    page,
    close: async () => {
      await browser.close();
      try {
        if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
      } catch {}
      await hosts.close();
      await slack.close();
      dbServer.close();
    },
  };
}

export async function shot(w: World, name: string, path = "/"): Promise<string> {
  await w.page.goto(`${BASE}${path}`);
  await sleep(1500);
  const file = join(SHOTS, `${name}.png`);
  await w.page.screenshot({ path: file, fullPage: false });
  return file;
}

export async function stage(name: string, run: () => Promise<string>): Promise<boolean> {
  try {
    const note = await run();
    results.push({ stage: name, ok: true, note });
    console.log(`PASS ${name}: ${note}`);
    return true;
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    results.push({ stage: name, ok: false, note });
    console.log(`FAIL ${name}: ${note}`);
    return false;
  }
}
void HOST_HOME;
void fakeAdapter;
