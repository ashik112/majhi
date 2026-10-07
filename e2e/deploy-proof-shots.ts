/**
 * The deploy proof with a browser: runs the flows of `deploy-proof-run.ts` on the isolated server and takes
 * the screens that the approved mockup (screens E and C) shows, at 1440 and 1100 wide, dark and light, plus
 * the owner's click on "Deploy production". Shots go to `MAJHI_PROOF_SHOTS` (default /tmp/majhi-deploy-proof).
 *
 *   MAJHI_E2E_PORT=7191 node --import tsx e2e/deploy-proof-shots.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { cmd, startProof } from "./deploy-proof.ts";
import { prepare, sleep, until } from "./deploy-proof-flow.ts";

const OUT = process.env.MAJHI_PROOF_SHOTS ?? "/tmp/majhi-deploy-proof";
mkdirSync(OUT, { recursive: true });

const proof = await startProof();
const { url, hosts } = proof;
const browser = await chromium.launch();
const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1100", width: 1100, height: 800 },
] as const;
const THEMES = ["dark", "light"] as const;

async function page(theme: (typeof THEMES)[number], size: (typeof SIZES)[number]): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    (appearance) => {
      window.localStorage.setItem("majhi.appearance", JSON.stringify(appearance));
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{backdrop-filter:none!important}";
      document.addEventListener("DOMContentLoaded", () => document.head.append(style));
    },
    { theme, accent: "amber" },
  );
  return context.newPage();
}

/** Every screen at every size and theme: `shoot(name, setup)` visits, lets it settle, and saves one file each. */
async function eachView(name: string, setup: (p: Page) => Promise<void>) {
  for (const theme of THEMES) {
    for (const size of SIZES) {
      const p = await page(theme, size);
      await setup(p);
      await sleep(600);
      await p.screenshot({ path: join(OUT, `${name}-${theme}-${size.name}.png`) });
      await p.context().close();
    }
  }
}

/** Opens the project and scrolls its detail pane so the named heading sits just under the pane's head. */
const toHeading = (name: string) => async (p: Page) => {
  p.on("pageerror", (e) => console.error("page error:", e.message));
  await p.goto(`${url}/projects?project=storefront`);
  const heading = p.getByRole("heading", { name, exact: true });
  await heading.waitFor({ timeout: 15_000 }).catch(async (err) => {
    await p.screenshot({ path: join(OUT, `debug-${name}.png`) });
    throw err;
  });
  await heading.evaluate((el) => {
    let pane: HTMLElement | null = el.parentElement;
    while (pane !== null && getComputedStyle(pane).overflowY !== "auto") pane = pane.parentElement;
    if (pane === null) return;
    pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 70;
  });
};
const toDeploySection = toHeading("Deploy targets");
const toHistory = toHeading("History");

try {
  const { makeTask, landed } = await prepare(proof);
  const one = await makeTask("Checkout fails when a coupon takes more than 50% off", "coupon.txt");
  const landed1 = await until("the fix to land", () => landed(one));
  proof.push(landed1.commit);
  proof.majhi.services.captain.deployChanged("acme");
  await until("the question for production", async () => {
    const d = await cmd(url, "tasks.detail", { id: one });
    return d.deployAsk === undefined ? undefined : d;
  });
  console.log("staging live, production waits");

  await eachView("E-deploy-targets", toDeploySection);
  await eachView("C-production-asks", async (p) => {
    await p.goto(`${url}/t/${one}`);
    await p.getByRole("region", { name: "Deploy to production" }).waitFor();
  });
  await eachView("B-board-asks", async (p) => {
    await p.goto(`${url}/`);
    await p.getByText("Production deploy waits for you").first().waitFor();
  });

  // The owner's click, in the browser.
  const click = await page("dark", SIZES[0]);
  await click.goto(`${url}/t/${one}`);
  await click.getByRole("button", { name: "Deploy production" }).click();
  await until("production to go live", async () => {
    const h = (await cmd(url, "projects.deployView", { project: "storefront" })).history;
    return h.find((r: { env: string; state: string }) => r.env === "production" && r.state === "live");
  });
  await click.getByRole("region", { name: "Deploy to production" }).waitFor({ state: "detached" });
  console.log(
    "production live after the click:",
    (await proof.onHost("tail -1 /srv/storefront/RELEASE")).split("\n")[0],
  );
  await click.context().close();
  await eachView("C-production-live", async (p) => {
    await p.goto(`${url}/t/${one}`);
    await sleep(800);
  });

  // A fix whose deploy fails: rolled back, with an incident.
  hosts.outcome.github = "failure";
  const two = await makeTask("Invoice footer shows the wrong tax", "tax.txt");
  const landed2 = await until("the second fix to land", () => landed(two));
  proof.push(landed2.commit);
  proof.majhi.services.captain.deployChanged("acme");
  await until("the rollback and the incident", async () => {
    const h = (await cmd(url, "projects.deployView", { project: "storefront" })).history;
    return h.find(
      (r: { commit: string; incident?: string }) => r.commit === landed2.commit && r.incident !== undefined,
    );
  });
  hosts.outcome.github = "success";
  await eachView("E-deploy-history", toHistory);
  await eachView("C-rolled-back", async (p) => {
    await p.goto(`${url}/t/${two}`);
    await sleep(800);
  });
  await eachView("B-board-rolled-back", async (p) => {
    await p.goto(`${url}/`);
    await sleep(800);
  });
  await eachView("captain-log", async (p) => {
    await p.goto(`${url}/captain`);
    await sleep(800);
  });
  console.log(`shots in ${OUT}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await proof.stop();
  process.exit(process.exitCode ?? 0);
}
