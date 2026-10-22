// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The case flow, walked end to end on a throwaway majhi (port 7520, never 7070) with fakes: a fake Slack with a client
 * chat, a scripted captain (the fake ACP agent) and a fake `ssh` whose celery worker is stuck until it is restarted.
 * Home is photographed at each stage and the buttons are clicked. Run from the repository root:
 *
 *   WALK_PORT=7520 WALK_SHOTS=/path node --import tsx e2e/case-walk/walk.ts
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { boot, cmd, PORT, results, shot, sleep, stage, until, type World } from "../incident-walk/walk.ts";
import { E2E_ROOT } from "../paths.ts";

const SHOTS = process.env.WALK_SHOTS ?? ".";
const SHIM = join(E2E_ROOT, "..", `majhi-walk-ssh-${PORT}`);
const STATE = join(SHIM, "restarted");
const FLAGS = { promisedTime: false, money: false, security: false, severalClients: false };

/** A fake `ssh`: the last word is the command. The worker is stuck until `docker restart` ran. */
function fakeSsh(): void {
  rmSync(SHIM, { recursive: true, force: true });
  mkdirSync(SHIM, { recursive: true });
  const file = join(SHIM, "ssh");
  writeFileSync(
    file,
    `#!/bin/sh
for last; do :; done
case "$last" in
  "docker restart"*) : > "${STATE}"; echo acme-worker ;;
  "docker ps"*)
    if [ -f "${STATE}" ]; then echo "acme-worker  Up 2 seconds (healthy)"; else echo "acme-worker  Up 3 days (unhealthy)"; fi ;;
  "docker logs"*)
    sleep 6
    if [ -f "${STATE}" ]; then echo "celery@worker ready."; else echo "all 3 slots busy: courier.status_sweep x3"; fi ;;
  "curl"*)
    if [ -f "${STATE}" ]; then echo ok; else echo "curl: (22) HTTP 500"; exit 22; fi ;;
  *) echo "not found"; exit 127 ;;
esac
`,
  );
  chmodSync(file, 0o755);
  process.env.PATH = `${SHIM}:${process.env.PATH ?? ""}`;
}

const ssh = (command: string) => ({
  server: "majhi-connections",
  tool: "ssh",
  args: { connection: "acme-host", command },
});

async function script(tasksDir: string, rooms: { slips: string; invoices: string }): Promise<void> {
  const reply = (room: string, text: string) => ({
    tool: "majhi_chat_reply",
    args: { room, text, ...FLAGS },
  });
  const rules = [
    {
      when: "The owner answered a card",
      flags: "",
      steps: [{ tool: "majhi_case_status", args: { now: "Holding the deploy until you say so" } }],
    },
    {
      when: "invoices",
      flags: "",
      steps: [
        {
          tool: "majhi_chat_openIncident",
          args: { room: rooms.invoices, found: "The invoice export fails." },
        },
        { tool: "majhi_case_status", args: { now: "Reading the export logs" } },
        ssh("docker ps"),
        reply(rooms.invoices, "We found the cause in our code. A fix is being worked on."),
        {
          tool: "majhi_case_ask",
          args: {
            question: "Deploy fix X to Acme?",
            options: [
              { id: "deploy", label: "Deploy" },
              { id: "wait", label: "Not now" },
            ],
          },
        },
        {
          tool: "majhi_case_followUp",
          args: { text: "Add a check for the invoice export so it shows before the client sees it" },
        },
        { tool: "majhi_case_status", args: { now: "Waiting for your answer on the deploy" } },
      ],
    },
    {
      when: "slips",
      flags: "",
      steps: [
        {
          tool: "majhi_chat_openIncident",
          args: { room: rooms.slips, found: "Slips fail and the courier call is not made." },
        },
        { tool: "majhi_case_status", args: { now: "Reading the order worker on the host" } },
        ssh("docker ps"),
        ssh("docker logs --tail 50 acme-worker"),
        reply(rooms.slips, "We found it: the order worker is jammed. We are fixing it now."),
        { tool: "majhi_case_status", args: { now: "Restarting the order worker" } },
        ssh("docker restart acme-worker"),
        ssh("docker ps"),
        ssh("curl -sf localhost:8000/slips/health"),
        {
          tool: "majhi_case_followUp",
          args: { text: "Stop the courier status sweep from filling every slot of the worker" },
        },
        {
          tool: "majhi_case_close",
          args: {
            summary: [
              "Slips and courier orders failed for Acme.",
              "The courier status sweep held all 3 slots of the order worker.",
              "Restarted the worker once; it took new work at once.",
              "The slips check answers again.",
              "Follow-up: keep the sweep from filling every slot.",
            ].join("\n"),
            tell: { text: "Fixed, please try again.", ...FLAGS },
          },
        },
      ],
    },
  ];
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "CAPTAIN_SCRIPT.json"), JSON.stringify({ rules }));
}

async function main(): Promise<void> {
  fakeSsh();
  // Who a sign-in belongs to is asked of Anthropic in a real run: here a fake answers, the same person every time.
  const profile = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ account: { uuid: "walk-owner", email: "owner@acme.example" } }));
  });
  await new Promise<void>((r) => profile.listen(PORT + 5, "127.0.0.1", r));
  process.env.MAJHI_CLAUDE_PROFILE_URL = `http://127.0.0.1:${PORT + 5}/profile`;
  const w: World = await boot();
  const hold = (check: string) => w.page.locator(check);
  /** The Work pane says this text now: what the owner reads. */
  const workSays = (text: string, ms = 20_000) =>
    w.page.waitForFunction(
      (t) =>
        (document.querySelector('[data-pane="work"]') as HTMLElement | null)?.innerText.includes(t) === true,
      text,
      { timeout: ms },
    );
  /** Done today is open: the rail is pressed until its rows show. */
  const openDone = async (text: string) => {
    const rail = hold('[data-pane="work"] button.cs-rail:has-text("Done today")');
    await rail.waitFor({ timeout: 20_000 });
    for (let i = 0; i < 4; i++) {
      if (
        await workSays(text, 3_000).then(
          () => true,
          () => false,
        )
      )
        return;
      await rail.click();
    }
    await workSays(text, 5_000);
  };
  /** A stage, and a picture of the page when it fails. */
  const step = async (name: string, run: () => Promise<string>): Promise<void> => {
    if (await stage(name, run)) return;
    console.log(
      `PAGE ${(
        await w.page
          .locator('[data-pane="work"]')
          .innerText({ timeout: 3000 })
          .catch(() => "no work pane")
      ).replace(/\n+/g, " | ")}`,
    );
    await w.page
      .screenshot({ path: join(process.env.WALK_SHOTS ?? ".", `fail-${name.replace(/ /g, "-")}.png`) })
      .catch(() => undefined);
  };
  try {
    let rooms = { slips: "", invoices: "" };
    await step("setup", async () => {
      await cmd("authority.set", { org: "acme", level: "routine" });
      await cmd("connections.create", {
        org: "acme",
        id: "acme-host",
        type: "ssh",
        name: "Host",
        fields: { alias: "deploy@10.0.0.5" },
      });
      w.slack.addChannel({ id: "C0INVOICES", name: "acme-invoices" });
      rooms = {
        slips: (await cmd("chat.channelLink", { connection: "slack", channel: "C0CLIENT", org: "acme" })).id,
        invoices: (await cmd("chat.channelLink", { connection: "slack", channel: "C0INVOICES", org: "acme" }))
          .id,
      };
      for (const room of Object.values(rooms)) await cmd("chat.settingsSet", { room, replyWhen: "every" });
      const config = await cmd("config.get");
      await script(config.config.tasksDir, rooms);
      return `Acme at Routine, a host, two client chats, the scripted captain in ${config.config.tasksDir}`;
    });

    await step("case opens", async () => {
      // The page is open before the messages come, and watches the case line appear.
      await w.page.goto(`http://127.0.0.1:${PORT}/`);
      await hold('[data-pane="work"]').waitFor({ timeout: 30_000 });
      w.slack.post({
        channel: "C0CLIENT",
        user: "U0SARA",
        text: "print slips are not generated and orders cannot be sent to the courier",
      });
      await sleep(1200);
      w.slack.post({ channel: "C0CLIENT", user: "U0SARA", text: "still no slips, two orders are stuck" });
      // The slow log read keeps the case open long enough to look at it.
      const row = hold('[data-pane="work"] .cs-case-line:has-text("Reading")').first();
      await row.waitFor({ timeout: 90_000 });
      await sleep(300);
      console.log(await shot(w, "01-case-open"));
      const text = await row.innerText();
      const tasks = (await cmd("tasks.list", { includeDone: true })) as any[];
      const cases = tasks.filter((t) => t.case !== undefined);
      if (cases.length !== 1) throw new Error(`expected one case, saw ${cases.length}`);
      return `one case ${cases[0].id}, its line says "${text.replace(/\s+/g, " ")}"`;
    });

    await step("case closes", async () => {
      await until("the client's two messages", async () => w.slack.sent.length >= 2, 120_000);
      const done = await until(
        "the case closed",
        async () => {
          const tasks = (await cmd("tasks.list", { includeDone: true })) as any[];
          return tasks.find((t) => t.case?.summary !== undefined && t.status === "done");
        },
        120_000,
      );
      const decisions = ((await cmd("decisions.list", {})).decisions as any[]).filter(
        (d) => d.task !== undefined,
      );
      if (decisions.length !== 0)
        throw new Error(`a case left a card: ${JSON.stringify(decisions.map((d) => d.title))}`);
      const others = ((await cmd("tasks.list", { includeDone: true })) as any[]).filter(
        (t) => t.case === undefined && t.lane !== true && t.chat !== true,
      );
      if (others.length > 0) throw new Error(`other tasks exist: ${others.map((t) => t.id).join(", ")}`);
      await w.page.goto(`http://127.0.0.1:${PORT}/`);
      // The first done row opens in place: its whole summary, its follow-up and Make it a task.
      await openDone("Slips and courier orders failed");
      await sleep(300);
      await w.page.screenshot({ path: join(SHOTS, "02-case-closed-done-today.png") });
      return `${done.id} is closed with its summary in Done today; the client heard: ${JSON.stringify(w.slack.sent.map((m) => m.text))}`;
    });

    await step("a case that needs a deploy", async () => {
      w.slack.post({
        channel: "C0INVOICES",
        user: "U0SARA",
        text: "the invoices export fails with an error",
      });
      const card = await until(
        "the one card",
        async () => {
          const list = ((await cmd("decisions.list", {})).decisions as any[]).filter(
            (d) => d.task !== undefined,
          );
          return list.find((d) => d.title.includes("Deploy fix X to Acme?"));
        },
        120_000,
      );
      const list = ((await cmd("decisions.list", {})).decisions as any[]).filter((d) => d.task !== undefined);
      if (list.length !== 1) throw new Error(`expected one card, saw ${list.length}`);
      await w.page.goto(`http://127.0.0.1:${PORT}/`);
      await hold('[data-pane="work"] .cs-case-line[data-needs="true"]').first().waitFor({ timeout: 20_000 });
      await sleep(300);
      console.log(await shot(w, "03-card-waits"));
      return `one card "${card.title}" with ${card.options.map((o: any) => o.label).join(" / ")}`;
    });

    await step("the owner answers the card", async () => {
      await w.page.goto(`http://127.0.0.1:${PORT}/`);
      const row = w.page.locator('[data-pane="needs"] [role="option"]', { hasText: "Deploy fix X" }).first();
      await row.waitFor({ timeout: 30_000 });
      await row.click();
      const sent = w.page.waitForResponse((r) => r.url().includes("decisions.answer"), { timeout: 60_000 });
      await row.getByRole("button").filter({ hasText: "Not now" }).first().click();
      const res = await sent;
      if (res.status() !== 200) throw new Error(`the answer failed with ${res.status()}`);
      await until(
        "the card to go",
        async () =>
          ((await cmd("decisions.list", {})).decisions as any[]).filter((d) => d.task !== undefined)
            .length === 0,
        30_000,
      );
      await sleep(1000);
      console.log(await shot(w, "04-card-answered"));
      return "the Not now button answered it and the card is gone";
    });

    await step("Make it a task", async () => {
      // The open case shows its follow-up with Make it a task: nothing becomes a task until it is pressed.
      await w.page.goto(`http://127.0.0.1:${PORT}/`);
      const row = w.page
        .locator('[data-pane="work"] [role="option"]', { hasText: "Invoices export" })
        .first();
      await row.waitFor({ timeout: 20_000 });
      await row.click();
      await workSays("Make it a task");
      const before = ((await cmd("tasks.list", { includeDone: true })) as any[]).length;
      await row.getByRole("button", { name: "Make it a task" }).first().click();
      await until(
        "the new task",
        async () => ((await cmd("tasks.list", { includeDone: true })) as any[]).length > before,
        20_000,
      );
      await sleep(800);
      await w.page.screenshot({ path: join(SHOTS, "05-made-a-task.png") });
      return "the follow-up became one task, and only after the click";
    });
  } finally {
    await w.close();
    profile.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS" : `FAILED: ${failed.map((f) => f.stage).join(", ")}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
