/**
 * Measures the targets of SPEC 5.17 against a built majhi: `pnpm exec tsx scripts/perf.ts`.
 * Build first: `pnpm --filter @majhi/web build && pnpm --filter @majhi/server build`.
 *
 * It makes a throwaway home (the e2e one, on port 7090), fills it with tasks whose rooms hold
 * 40, 600 and 6,000 items, starts the built server (`node --max-semi-space-size=2 apps/server/dist/main.js`, no agents) and
 * a browser, and prints:
 *
 * - server memory (RSS) after start, and after the browser opened every task;
 * - task switch: click on a board card until the room's last message is painted;
 * - room update: a message's server timestamp until it is painted, in a fresh room and in a room
 *   that has loaded 1,500 older items.
 *
 * Nothing is asserted: the numbers are for PROGRESS.md. Both sides run on one machine, so the
 * clocks agree.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type Page } from "@playwright/test";

process.env.MAJHI_E2E_PORT ??= "7090";
const { E2E_PORT, E2E_ROOT, HOST_HOME, MAJHI_HOME, SECRETS_KEY_FILE } = await import("../e2e/paths.ts");
const { generateKey } = await import("../apps/server/src/secrets/store.ts");
const { Store } = await import("../apps/server/src/store/index.ts");
const { seedUiHome } = await import("../e2e/ui-seed.ts");

const SIZES = [
  { id: "PERF-1", items: 40 },
  { id: "PERF-2", items: 600 },
  { id: "PERF-3", items: 6000 },
] as const;
const LAST = (id: string) => `${id} final message`;
const now = () => new Date().toISOString();

function seed(): void {
  rmSync(E2E_ROOT, { recursive: true, force: true });
  mkdirSync(MAJHI_HOME, { recursive: true });
  mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true });
  seedUiHome();
  const store = Store.open(MAJHI_HOME);
  for (const { id, items } of SIZES) {
    const folder = join(E2E_ROOT, "tasks", id);
    mkdirSync(folder, { recursive: true });
    store.tasks.insert({
      id,
      title: `Perf room of ${items} items`,
      brief: "Check how the export job retries",
      kind: "code",
      org: "globex",
      status: "running",
      folder,
      repos: [],
      team: ["globex-lead"],
      mode: "lead",
      overrides: {},
      links: [],
      attachments: [],
      createdAt: now(),
      updatedAt: now(),
    });
    for (let i = 0; i < items; i++) {
      const itemId = `${id}-i${i}`;
      const kind = i % 5;
      if (kind === 0) {
        store.room.upsert(id, itemId, {
          type: "owner",
          text: `Question ${i}: how does the export job retry?`,
          attachments: [],
          queued: false,
        });
      } else if (kind === 4) {
        store.room.upsert(id, itemId, {
          type: "tool",
          agent: "globex-lead",
          toolCallId: itemId,
          title: `Read src/export/job-${i}.ts`,
          kind: "read",
          status: "completed",
          locations: [`/tasks/${id}/src/export/job-${i}.ts`],
          content: [],
        });
      } else {
        const text =
          i === items - 1
            ? LAST(id)
            : `Step ${i}: the retry runs **three times** with backoff.\n\n- first, read \`handler.ts\`\n- then, move the call into a job\n\n\`\`\`ts\nawait queue.add("export", { board });\n\`\`\``;
        store.room.upsert(id, itemId, { type: "agent", agent: "globex-lead", text });
      }
    }
    // The last item is always the marker the browser waits for.
    store.room.upsert(id, `${id}-last`, { type: "agent", agent: "globex-lead", text: LAST(id) });
  }
  store.close();
}

async function startServer(): Promise<{ pid: number; stop: () => void }> {
  mkdirSync(HOST_HOME, { recursive: true });
  writeFileSync(SECRETS_KEY_FILE, `${await generateKey()}\n`, { mode: 0o600 });
  // The flags and the malloc setting are the ones the Dockerfile starts the server with.
  const child = spawn(process.execPath, ["--max-semi-space-size=2", "apps/server/dist/main.js"], {
    env: {
      ...process.env,
      MALLOC_ARENA_MAX: "2",
      MAJHI_HOST: "127.0.0.1",
      MAJHI_PORT: String(E2E_PORT),
      HOST_HOME,
      MAJHI_HOME,
      MAJHI_VERSION: "perf",
      MAJHI_RUNNER: "local",
      MAJHI_SECRETS_KEY_FILE: SECRETS_KEY_FILE,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const url = `http://127.0.0.1:${E2E_PORT}/health`;
  for (let i = 0; i < 120; i++) {
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return { pid: child.pid ?? 0, stop: () => child.kill() };
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("The server did not start. Is apps/server/dist built?");
}

/** Resident memory of a process in MB: `/proc` on Linux, `ps` on a Mac. */
function rssMb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = /VmRSS:\s+(\d+) kB/.exec(status)?.[1];
    if (kb !== undefined) return Number(kb) / 1024;
  } catch {
    // Not Linux.
  }
  return (
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
        .toString()
        .trim(),
    ) / 1024
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const fmt = (xs: number[]) =>
  `median ${median(xs).toFixed(0)} ms, worst ${Math.max(...xs).toFixed(0)} ms (${xs.map((x) => x.toFixed(0)).join(", ")})`;

/** Time from a click on the board card to the room's last message on screen. */
async function switchTo(page: Page, id: string): Promise<number> {
  await page.goto("/");
  await page.locator(`#card-${id} a[data-card-link]`).waitFor();
  await page.evaluate((rowId) => {
    const w = window as unknown as { __perf: { start: number; end?: number } };
    w.__perf = { start: 0 };
    document.addEventListener(
      "click",
      (e) => {
        if ((e.target as Element).closest("a[data-card-link]")) w.__perf.start = performance.now();
      },
      { capture: true, once: true },
    );
    // The row of the last message has an id, so the check costs nothing however long the room is.
    const done = () => {
      if (w.__perf.start && w.__perf.end === undefined && document.getElementById(rowId)) {
        requestAnimationFrame(() => {
          w.__perf.end ??= performance.now();
        });
      }
    };
    new MutationObserver(done).observe(document.body, { subtree: true, childList: true });
  }, `room-row-${id}-last`);
  await page.locator(`#card-${id} a[data-card-link]`).click();
  await page.waitForFunction(
    () => (window as unknown as { __perf: { end?: number } }).__perf.end !== undefined,
  );
  return page.evaluate(() => {
    const p = (window as unknown as { __perf: { start: number; end: number } }).__perf;
    return p.end - p.start;
  });
}

/** Time from a message's server timestamp to the frame that shows it. */
async function updateLatency(
  page: Page,
  id: string,
  n: number,
): Promise<{ total: number[]; toClient: number[] }> {
  const out: number[] = [];
  const toClient: number[] = [];
  for (let i = 0; i < n; i++) {
    const marker = `perf-update-${id}-${i}-${Date.now()}`;
    // The init script stamps the frame that carries the marker; rows are stamped as they appear.
    await page.evaluate((text) => {
      const w = window as unknown as { __recv?: number; __marker: string };
      w.__recv = undefined;
      w.__marker = text;
    }, marker);
    const res = await fetch(`http://127.0.0.1:${E2E_PORT}/api/cmd/room.send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: id, text: marker, attachments: [], mode: "queue" }),
    });
    const body = (await res.json()) as { item?: { id: string; at: string } };
    if (body.item === undefined) throw new Error(`room.send failed: ${JSON.stringify(body)}`);
    const rowId = `room-row-${body.item.id}`;
    await page.waitForFunction(
      (row) => (window as unknown as { __rows: Record<string, number> }).__rows[row] !== undefined,
      rowId,
    );
    const [seen, received] = await page.evaluate((row) => {
      const w = window as unknown as { __rows: Record<string, number>; __recv?: number };
      return [w.__rows[row], w.__recv] as const;
    }, rowId);
    const sent = new Date(body.item.at).getTime();
    if (seen !== undefined) out.push(seen - sent);
    if (received !== undefined) toClient.push(received - sent);
    await sleep(300);
  }
  return { total: out, toClient };
}

/** Where the page spends its time while updates arrive: the heaviest functions by their own time (V8 sampling). */
async function profileUpdates(page: Page, id: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await cdp.send("Profiler.start");
  await updateLatency(page, id, 6);
  const { profile } = await cdp.send("Profiler.stop");
  const self = new Map<string, number>();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas ?? [];
  profile.samples?.forEach((nodeId, i) => {
    const node = byId.get(nodeId);
    if (!node) return;
    const f = node.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop() ?? ""}:${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const top = [...self.entries()]
    .filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  console.log("heaviest functions during 6 updates (own time, ms):");
  for (const [k, ms] of top) console.log(`  ${ms.toFixed(0).padStart(5)}  ${k}`);
}

/** Scrolls the log to the top until it holds `want` items, as an owner reading history would. */
async function loadHistory(page: Page, want: number): Promise<number> {
  const log = page.locator('[role="log"]');
  let rows = 0;
  for (let i = 0; i < 60 && rows < want; i++) {
    await log.evaluate((el) => el.scrollTo({ top: 0 }));
    await sleep(250);
    rows = await page.locator('[role="log"] li').count();
  }
  await log.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  return rows;
}

seed();
const server = await startServer();
try {
  await sleep(5000);
  const idle = rssMb(server.pid);
  console.log(`server RSS after start, idle 5 s: ${idle.toFixed(0)} MB (target under 200)`);

  const browser = await chromium.launch();
  const page = await (
    await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: `http://127.0.0.1:${E2E_PORT}`,
    })
  ).newPage();

  // tsx wraps functions in a `__name` helper that the page does not have.
  await page.addInitScript(`
    window.__name = (f) => f;
    window.__marker = "";
    window.__rows = {};
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && typeof n.id === "string" && n.id.startsWith("room-row-")) {
          const row = n.id;
          requestAnimationFrame(() => { window.__rows[row] ??= performance.timeOrigin + performance.now(); });
        }
      }
    }).observe(document, { subtree: true, childList: true });
    window.__recv = undefined;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (e) => {
          if (window.__marker !== "" && window.__recv === undefined && typeof e.data === "string" && e.data.includes(window.__marker)) {
            window.__recv = performance.timeOrigin + performance.now();
          }
        });
      }
    };
  `);

  for (const { id, items } of SIZES) {
    const first = await switchTo(page, id);
    const again: number[] = [];
    for (let i = 0; i < 8; i++) again.push(await switchTo(page, id));
    console.log(
      `task switch, room of ${items}: first open ${first.toFixed(0)} ms; reopened: ${fmt(again)} (target under 100)`,
    );
  }
  console.log(`server RSS after opening three tasks: ${rssMb(server.pid).toFixed(0)} MB`);

  await switchTo(page, "PERF-3");
  const fresh = await updateLatency(page, "PERF-3", 8);
  console.log(`room update, fresh room of 6000: ${fmt(fresh.total)} (target under 50)`);
  console.log(`  of which server stamp to the browser receiving the frame: ${fmt(fresh.toClient)}`);
  const rows = await loadHistory(page, 1500);
  const long = await updateLatency(page, "PERF-3", 8);
  console.log(`room update, after loading ${rows} rows: ${fmt(long.total)}`);
  console.log(`  of which server stamp to the browser receiving the frame: ${fmt(long.toClient)}`);
  if (process.env.PROFILE) await profileUpdates(page, "PERF-3");
  // A search match 5,990 messages back: the room loads older pages until the row exists, then centers it.
  const started = Date.now();
  await page.goto("/t/PERF-3?item=PERF-3-i10");
  const row = page.locator("#room-row-PERF-3-i10");
  await row.waitFor({ timeout: 30_000 });
  await sleep(500);
  const box = await row.boundingBox();
  const inView = box !== null && box.y >= 0 && box.y + box.height <= 900;
  console.log(
    `scroll to a match 5,990 messages back: ${Date.now() - started} ms, ${inView ? "in view" : "NOT in view"}, address cleared: ${!page.url().includes("item=")}`,
  );
  console.log(`server RSS at the end: ${rssMb(server.pid).toFixed(0)} MB`);
  await browser.close();
} finally {
  server.stop();
}
