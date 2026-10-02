// Throwaway check for PRV-69. Not committed.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

process.env.MAJHI_E2E_PORT ??= "7091";
const { E2E_PORT, E2E_ROOT, HOST_HOME, MAJHI_HOME, SECRETS_KEY_FILE } = await import("../e2e/paths.ts");
const { generateKey } = await import("../apps/server/src/secrets/store.ts");
const { Store } = await import("../apps/server/src/store/index.ts");
const { seedUiHome } = await import("../e2e/ui-seed.ts");

const OUT = process.env.OUT ?? "media";
const ID = "CHK-1";
const ITEMS = 800;
const TARGET = 31; // an agent message, 768 rows behind the newest
const now = () => new Date().toISOString();

rmSync(E2E_ROOT, { recursive: true, force: true });
mkdirSync(MAJHI_HOME, { recursive: true });
mkdirSync(dirname(SECRETS_KEY_FILE), { recursive: true });
mkdirSync(OUT, { recursive: true });
seedUiHome();
const store = Store.open(MAJHI_HOME);
const folder = join(E2E_ROOT, "tasks", ID);
mkdirSync(folder, { recursive: true });
store.tasks.insert({
  id: ID,
  title: "Retry room with a long history",
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
for (let i = 0; i < ITEMS; i++) {
  store.room.upsert(ID, `${ID}-i${i}`, {
    type: "agent",
    agent: "globex-lead",
    text: i === TARGET ? "The zebrafinch cache is what makes the export retry twice." : `Step ${i}: the retry runs with backoff.`,
  });
}
store.close();

writeFileSync(SECRETS_KEY_FILE, `${await generateKey()}\n`, { mode: 0o600 });
mkdirSync(HOST_HOME, { recursive: true });
const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
  env: {
    ...process.env,
    MAJHI_HOST: "127.0.0.1",
    MAJHI_PORT: String(E2E_PORT),
    HOST_HOME,
    MAJHI_HOME,
    MAJHI_VERSION: "check",
    MAJHI_RUNNER: "local",
    MAJHI_SECRETS_KEY_FILE: SECRETS_KEY_FILE,
  },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`http://127.0.0.1:${E2E_PORT}/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: `http://127.0.0.1:${E2E_PORT}`, reducedMotion: "reduce" })
  ).newPage();
  await page.goto("/");
  await page.locator("#card-" + ID).waitFor();

  // 1. Commands rank above search results.
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("searchbox");
  await box.fill("retry");
  await page.getByRole("option").first().waitFor();
  console.log("typed 'retry', sections:", await page.locator("[role=listbox] h2").allTextContents());
  await box.fill("new task");
  console.log("typed 'new task', first option:", (await page.getByRole("option").first().innerText()).trim());
  await box.fill("account");
  console.log("typed 'account', sections:", await page.locator("[role=listbox] h2").allTextContents());
  await page.screenshot({ path: join(OUT, "palette-commands.png") });

  // 2. A match in an old message opens with it in view.
  await box.fill("zebrafinch");
  await page.getByRole("option").filter({ hasText: "zebrafinch" }).first().waitFor();
  await page.screenshot({ path: join(OUT, "palette-match.png") });
  const started = Date.now();
  await page.keyboard.press("Enter");
  const row = page.locator(`#room-row-${ID}-i${TARGET}`);
  await row.waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    },
    `#room-row-${ID}-i${TARGET}`,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(400);
  const r = await row.boundingBox();
  console.log(
    `opened item ${TARGET} of ${ITEMS} in ${Date.now() - started} ms; row top ${r?.y.toFixed(0)}, height ${r?.height.toFixed(0)}, viewport 900; url ${page.url()}`,
  );
  console.log("data-found present:", await row.evaluate((el) => el.hasAttribute("data-found") || !!el.querySelector("[data-found]")));
  await page.screenshot({ path: join(OUT, "match-in-view.png") });
  await browser.close();
} finally {
  child.kill();
}
