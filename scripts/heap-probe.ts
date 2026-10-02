// Scratch probe, not committed. Seeds like perf.ts, starts the server with heap/report signals,
// writes snapshots and reports before and after opening tasks.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

process.env.MAJHI_E2E_PORT ??= "7091";
const { E2E_PORT, E2E_ROOT, HOST_HOME, MAJHI_HOME, SECRETS_KEY_FILE } = await import("../e2e/paths.ts");
const { generateKey } = await import("../apps/server/src/secrets/store.ts");
const { Store } = await import("../apps/server/src/store/index.ts");
const { seedUiHome } = await import("../e2e/ui-seed.ts");
const OUT = process.env.PROBE_OUT ?? "/tmp/probe";
mkdirSync(OUT, { recursive: true });
const SIZES = [{ id: "PERF-1", items: 40 }, { id: "PERF-2", items: 600 }, { id: "PERF-3", items: 6000 }];
const now = () => new Date().toISOString();
rmSync(E2E_ROOT, { recursive: true, force: true });
mkdirSync(MAJHI_HOME, { recursive: true });
mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true });
seedUiHome();
const store = Store.open(MAJHI_HOME);
for (const { id, items } of SIZES) {
  const folder = join(E2E_ROOT, "tasks", id);
  mkdirSync(folder, { recursive: true });
  store.tasks.insert({ id, title: `Perf room of ${items}`, brief: "b", kind: "code", org: "globex", status: "running", folder, repos: [], team: ["globex-lead"], mode: "lead", overrides: {}, links: [], attachments: [], createdAt: now(), updatedAt: now() });
  for (let i = 0; i < items; i++) {
    const itemId = `${id}-i${i}`;
    if (i % 5 === 0) store.room.upsert(id, itemId, { type: "owner", text: `Question ${i}: how does the export job retry?`, attachments: [], queued: false });
    else if (i % 5 === 4) store.room.upsert(id, itemId, { type: "tool", agent: "globex-lead", toolCallId: itemId, title: `Read src/export/job-${i}.ts`, kind: "read", status: "completed", locations: [`/tasks/${id}/src/export/job-${i}.ts`], content: [] });
    else store.room.upsert(id, itemId, { type: "agent", agent: "globex-lead", text: `Step ${i}: the retry runs **three times** with backoff.\n\n- first, read \`handler.ts\`\n- then\n\n\`\`\`ts\nawait queue.add("export", { board });\n\`\`\`` });
  }
  store.room.upsert(id, `${id}-last`, { type: "agent", agent: "globex-lead", text: `${id} final message` });
}
store.close();
mkdirSync(HOST_HOME, { recursive: true });
writeFileSync(SECRETS_KEY_FILE, `${await generateKey()}\n`, { mode: 0o600 });
const child = spawn(process.execPath, [...(process.env.PROBE_NODE_ARGS ?? "").split(" ").filter(Boolean), `--heapsnapshot-signal=SIGUSR2`, `--report-signal=SIGWINCH`, `--report-on-signal`, `--report-directory=${OUT}`, join(process.cwd(), "apps/server/dist/main.js")], {
  cwd: OUT,
  env: { ...process.env, MAJHI_HOST: "127.0.0.1", MAJHI_PORT: String(E2E_PORT), HOST_HOME, MAJHI_HOME, MAJHI_VERSION: "perf", MAJHI_RUNNER: "local", MAJHI_SECRETS_KEY_FILE: SECRETS_KEY_FILE },
  stdio: ["ignore", "ignore", "inherit"],
});
const pid = child.pid ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120; i++) {
  if (await fetch(`http://127.0.0.1:${E2E_PORT}/health`).then((r) => r.ok, () => false)) break;
  await sleep(250);
}
const rss = () => /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
async function capture(label: string, snap = false) {
  process.kill(pid, "SIGWINCH");
  await sleep(1500);
  if (snap) {
    process.kill(pid, "SIGUSR2");
    await sleep(15000);
  }
  const reps = readdirSync(OUT).filter((f) => f.startsWith("report")).sort();
  const rep = JSON.parse(readFileSync(join(OUT, reps[reps.length - 1] as string), "utf8"));
  const h = rep.javascriptHeap;
  console.log(`${label} [${process.env.PROBE_NODE_ARGS ?? ""} ${process.env.MALLOC_ARENA_MAX ?? ""}]: RSS ${Number(rss()) / 1024 | 0} MB; heapUsed ${(h.usedMemory / 1e6) | 0} MB heapTotal ${(h.totalMemory / 1e6) | 0} MB; external ${(h.externalMemory / 1e6) | 0} MB; rss(report) ${(rep.resourceUsage.rss / 1e6) | 0}`);
  const snaps = readdirSync(OUT).filter((f) => f.endsWith(".heapsnapshot")).sort();
  const last = snaps[snaps.length - 1];
  if (last) { const { renameSync } = await import("node:fs"); renameSync(join(OUT, last), join(OUT, `${label}.heapsnapshot`)); }
}
await sleep(5000);
await capture("idle");
await sleep(2000);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: `http://127.0.0.1:${E2E_PORT}` })).newPage();
for (const { id } of SIZES) {
  for (let k = 0; k < 3; k++) {
    await page.goto(`/t/${id}`);
    await page.locator(`#room-row-${id}-last`).waitFor();
    await sleep(300);
  }
}
await sleep(3000);
await capture("opened");
await sleep(5000);
if (!process.env.PROBE_NOSNAP) await capture("opened-later", true);
await browser.close();
child.kill();
