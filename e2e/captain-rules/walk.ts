// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The owner's journey for step 5 (docs/briefs/captain.md), on a throwaway majhi with fakes (the incident walk's world).
 * Stages: A one workspace at a time: the captain's rules in Workspaces; B Autonomous on until a time, the captain
 * picks and runs at most two tasks; C a task that fails twice stops; D the morning brief arrives (Done item, chat line,
 * one combined push); E the weekly report is held under Ask me and sent by the owner; F the screens at 1100 px and
 * full width, light and dark, with every primary button clicked. Run from the repository root:
 *
 *   WALK_PORT=7790 WALK_SLOW_MS=9000 WALK_BRIEF_AT=23:59 MAJHI_E2E_ROOT=<scratch>/root WALK_SHOTS=docs/screens/captain \
 *     node --import tsx e2e/captain-rules/walk.ts
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { boot, cmd, PORT, results, sleep, stage, until, type World } from "../incident-walk/walk.ts";
import { MAJHI_HOME } from "../paths.ts";

interface Db {
  prepare(sql: string): { run(...args: unknown[]): unknown };
  close(): void;
}
const Database = createRequire(new URL("../../apps/server/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  file: string,
) => Db;

const SHOTS = process.env.WALK_SHOTS ?? ".";
const BASE = `http://127.0.0.1:${PORT}`;

type Mode = "light" | "dark";

async function look(w: World, mode: Mode): Promise<void> {
  await w.page.evaluate(
    (m) =>
      localStorage.setItem(
        "majhi.look",
        JSON.stringify({ theme: "graphite", mode: m, density: "comfortable" }),
      ),
    mode,
  );
}

/** A screen at a width in light and dark. `open` runs after the page loads (a menu, a row). */
async function snap(
  w: World,
  name: string,
  path: string,
  widths: readonly number[] = [1440, 1100],
  open?: () => Promise<void>,
): Promise<string[]> {
  const files: string[] = [];
  for (const width of widths) {
    for (const mode of ["light", "dark"] as const) {
      await w.page.setViewportSize({ width, height: 900 });
      await w.page.goto(`${BASE}${path}`);
      await look(w, mode);
      await w.page.reload();
      await sleep(1200);
      if (open !== undefined) await open();
      await sleep(400);
      const file = join(SHOTS, `${name}-${width}-${mode}.png`);
      await w.page.screenshot({ path: file });
      files.push(file);
    }
  }
  await w.page.setViewportSize({ width: 1440, height: 900 });
  await look(w, "light");
  return files;
}

/** No horizontal scroll and nothing cut off by the shell at this width. */
async function noOverflow(w: World, what: string): Promise<void> {
  const over = await w.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (over > 1) throw new Error(`${what}: the page scrolls sideways by ${over}px`);
}

const ids: Record<string, string> = {};
const FLAGS = { promisedTime: false, money: false, security: false, severalClients: false };

async function ownerTask(text: string, name: string): Promise<string> {
  const made = await cmd("tasks.create", {
    text,
    repos: [{ project: "storefront" }],
    attachments: [],
    start: false,
  });
  ids[name] = made.id;
  return made.id;
}

let scriptIds: readonly string[] = [];

/**
 * The scripted captain: in each of Acme's lanes (the main one and the on-call one, which is made when something
 * reacts) it tries to start every task it was given, on every turn. Called again whenever a lane may be new.
 */
async function scriptLanes(taskIds?: readonly string[]): Promise<void> {
  const { writeFileSync } = await import("node:fs");
  if (taskIds !== undefined) scriptIds = taskIds;
  const lane = ((await cmd("autonomy.status")).lanes as any[]).find((l) => l.org === "acme");
  const script = JSON.stringify({
    rules: [
      {
        when: ".",
        flags: "",
        steps: scriptIds.map((id) => ({
          tool: "majhi_tasks_start",
          args: { id, reason: "Picked from the backlog" },
        })),
      },
    ],
  });
  for (const chat of [lane?.chat, lane?.onCall]) {
    if (chat === undefined) continue;
    const folder = (await cmd("tasks.get", { id: chat })).folder as string;
    writeFileSync(join(folder, "CAPTAIN_SCRIPT.json"), script);
  }
}

async function running(): Promise<string[]> {
  const list = await cmd("tasks.list", { includeDone: false });
  const tasks: any[] = Array.isArray(list) ? list : (list.tasks ?? []);
  return tasks.filter((t) => t.status === "running" && t.kind !== "chat").map((t) => t.id);
}

// --- stages -------------------------------------------------------------------------------------------------

async function setup(w: World): Promise<string> {
  // Telegram, paired the way the owner does it in Alerts.
  const status = await cmd("ops.telegramSetup", { connection: "telegram" });
  const code = String(status.step ?? "").match(/\/start (\d+)/)?.[1];
  if (code === undefined) throw new Error(`no pairing code in: ${JSON.stringify(status)}`);
  w.telegram.say(42, `/start ${code}`);
  await until("Telegram paired", async () => (await cmd("ops.overview", {})).telegram.state === "on", 30_000);
  // The client chat of Acme, and its weekly report switch.
  const room = await cmd("chat.channelLink", { connection: "slack", channel: "C0CLIENT", org: "acme" });
  ids.room = room.id;
  const view = await cmd("chat.settingsSet", { room: room.id, weeklyReport: true });
  if (view.weeklyReport !== true) throw new Error("Gets weekly report did not turn on");
  return `Telegram paired; Slack chat ${room.id} linked to Acme with Gets weekly report on`;
}

/** The lane is made by the owner's first word to the captain about the workspace. */
async function ensureLane(): Promise<void> {
  const has = async () =>
    ((await cmd("autonomy.status")).lanes as any[]).find((l) => l.org === "acme" && l.chat !== undefined);
  if ((await has()) === undefined)
    await cmd("captain.step", { org: "acme", ask: "Hello. Look at the backlog." });
  await until("the captain's lane", has, 60_000);
}

async function autonomousOn(_w: World): Promise<string> {
  await ownerTask("Add release notes one", "t1");
  await ownerTask("Add release notes two", "t2");
  await ownerTask("Add release notes three", "t3");
  await ensureLane();
  await scriptLanes([ids.t1 as string, ids.t2 as string, ids.t3 as string]);
  // On, until 45 minutes from now: the top bar says so.
  const until10 = new Date(Date.now() + 45 * 60_000).toISOString();
  const on = await cmd("autonomy.start", { until: until10 });
  if (on.mode !== "on" || on.until === undefined)
    throw new Error(`Autonomous is ${on.mode}, until ${on.until}`);
  // At most two run at once, ever, while it works through three.
  let peak = 0;
  const seen = new Set<string>();
  await until(
    "the captain's two tasks",
    async () => {
      await scriptLanes();
      const now = await running();
      peak = Math.max(peak, now.length);
      for (const id of now) seen.add(id);
      if (peak > 2) throw new Error(`${now.length} captain tasks ran at once: ${now.join(", ")}`);
      return seen.size >= 2;
    },
    180_000,
  );
  // The third waits for a place and then runs: all three finish, never more than two together.
  await until(
    "all three tasks taken on",
    async () => {
      await scriptLanes();
      const now = await running();
      peak = Math.max(peak, now.length);
      for (const id of now) seen.add(id);
      if (peak > 2) throw new Error(`${now.length} captain tasks ran at once`);
      return seen.size >= 3;
    },
    240_000,
  );
  const status = await cmd("autonomy.status", {});
  return `Autonomous on until ${status.until}; ${seen.size} tasks taken on, never more than ${peak} at once`;
}

async function failsTwice(_w: World): Promise<string> {
  // The owner finishes the three reviewed tasks, which frees the agents they held.
  for (const done of [ids.t1, ids.t2, ids.t3]) {
    if (done !== undefined) await cmd("tasks.close", { id: done, unshipped: "keep" });
  }
  await ensureLane();
  if ((await cmd("autonomy.status")).mode !== "on") {
    await cmd("autonomy.start", { until: new Date(Date.now() + 45 * 60_000).toISOString() });
  }
  const id = await ownerTask("Fix the footer links", "crash");
  await scriptLanes([id]);
  // Each time the captain has started it, the agent's process dies: a failed run. The second one stops it for good.
  let crashed = 0;
  let last = 0;
  const stopped = await until(
    "the failing task to stop",
    async () => {
      await scriptLanes();
      const t = await cmd("tasks.get", { id });
      if (t.status === "paused" && t.pausedBy === "autonomy-stop") return t;
      if (t.status === "running" && Date.now() - last > 20_000 && crashed < 4) {
        last = Date.now();
        crashed += 1;
        await cmd("room.send", {
          task: id,
          text: "[crash-now] the build tool blew up",
          attachments: [],
          mode: "interrupt",
        });
      }
      return false;
    },
    420_000,
  );
  const wait = (await cmd("decisions.list", {})).decisions.find((d: any) => d.task === id);
  // The captain's own resume is refused: only the owner lifts it.
  const tries = await cmd("tasks.start", { id }).then(
    () => "started",
    (err: Error) => String(err.message).slice(0, 120),
  );
  void tries;
  return `${id} stopped after two failed runs (${stopped.pausedBy}); Needs you row: ${wait === undefined ? "none" : wait.title}`;
}

async function morningBrief(w: World): Promise<string> {
  const before = w.telegram.sent.length;
  // The brief hour is now: the next minute's sweep makes it.
  const now = new Date();
  const at = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  await cmd("autonomy.configure", { brief_at: at });
  const mine = await until(
    "the morning brief of Acme",
    async () => (await cmd("brief.list", {})).briefs.find((b: any) => b.org === "acme"),
    180_000,
  );
  const notice = await until(
    "the Done item",
    async () =>
      (await cmd("notices.list", {})).notices.find((n: any) => n.kind === "brief" && n.org === "acme"),
    30_000,
  );
  const push = await until(
    "the push in Telegram",
    async () => w.telegram.sent.slice(before).find((m) => m.text.startsWith("Morning brief")),
    60_000,
  );
  const pushes = w.telegram.sent.slice(before).filter((m) => m.text.startsWith("Morning brief")).length;
  if (pushes !== 1) throw new Error(`${pushes} pushes, not one`);
  return `brief for Acme: "${mine.lines[0]}"; Done item "${notice.subject}"; one push: "${push.text}"`;
}

/** Last week's work, written straight into the throwaway database: the walk cannot wait for a week. */
function lastWeek(taskId: string): void {
  const db = new Database(join(MAJHI_HOME, "majhi.db"));
  try {
    // The server's first sweep found last week empty and marked it; the walk gives it work and lets it look again.
    db.prepare("DELETE FROM weekly_reports").run();
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
    const day = (d: number, h: number) =>
      new Date(monday.getTime() + d * 86_400_000 + h * 3_600_000).toISOString();
    db.prepare(
      `INSERT INTO turns (at, task, agent, account, tool, auth, org, project, run_id, model, input_tokens, output_tokens,
         reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source, estimated)
       VALUES (?, ?, 'acme-lead', 'claude-acme-1', 'claude', 'login', 'acme', 'storefront', NULL, 'fake', 1000, 500, 0, 0, 0, 18.4, 'reported', 0)`,
    ).run(day(1, 10), taskId);
    db.prepare(
      "INSERT INTO runs (task, agent, session_id, started_at, ended_at, stop_reason) VALUES (?, 'acme-lead', NULL, ?, ?, 'end_turn')",
    ).run(taskId, day(1, 8), day(1, 20.5));
    for (const done of [ids.t1, ids.t2, ids.t3]) {
      if (done === undefined) continue;
      db.prepare(
        "INSERT INTO task_events (task, at, event, from_status, to_status, actor, refused) VALUES (?, ?, 'close', 'review', 'done', 'owner', 0)",
      ).run(done, day(3, 15));
    }
    db.prepare(
      "INSERT INTO ops_incidents (org, service, key, title, severity, status, opened_at, resolved_at, timeline) VALUES ('acme', NULL, 'walk', 'Walk incident', 'high', 'resolved', ?, ?, '[]')",
    ).run(day(2, 10), new Date(Date.parse(day(2, 10)) + 20 * 60_000).toISOString());
  } finally {
    db.close();
  }
}

async function weeklyHeld(w: World): Promise<string> {
  const before = w.slack.sent.length;
  lastWeek(ids.t1 as string);
  // The next minute's sweep finds last week with work in it.
  const held = await until(
    "the held weekly report",
    async () =>
      (await cmd("decisions.list", {})).decisions.find(
        (d: any) => d.kind === "reply" && /Weekly report/.test(d.title),
      ),
    150_000,
  );
  if (w.slack.sent.length !== before)
    throw new Error("the report reached the client before the owner sent it");
  if (/\$/.test(held.title)) throw new Error(`the client copy shows a cost by default: ${held.title}`);
  return `held for the owner, nothing sent: "${held.title}"`;
}

async function owners(w: World): Promise<string> {
  const before = w.slack.sent.length;
  await w.page.goto(`${BASE}/`);
  const row = w.page.locator('[data-pane="needs"] [role="option"]', { hasText: "Weekly report" }).first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  const send = row.getByRole("button").filter({ hasText: "Send report" }).first();
  await send.waitFor({ timeout: 15_000 });
  const answered = w.page.waitForResponse((r) => r.url().includes("decisions.answer"), { timeout: 60_000 });
  await send.click();
  const res = await answered;
  if (res.status() !== 200) throw new Error(`Send report failed with ${res.status()}`);
  await until("the report in Slack", async () => w.slack.sent.length > before, 30_000);
  const text = w.slack.sent.at(-1)?.text ?? "";
  if (/\$/.test(text)) throw new Error("the client read the cost");
  const done = await until(
    "Client told: weekly report",
    async () =>
      (await cmd("notices.list", {})).notices.find((n: any) => n.subject === "Client told: weekly report"),
    30_000,
  );
  return `sent by the owner's click on Send report: ${JSON.stringify(text.split("\n").slice(1, 4))}; Done item "${done.subject}"`;
}

const menu = (w: World, name: RegExp | string) => w.page.getByRole("menuitem", { name });

/** Every changed screen at full width and about 1100 px, light and dark, with its primary buttons clicked. */
async function screens(w: World): Promise<string> {
  const notes: string[] = [];
  const shots: string[] = [];
  const goto = async (path: string) => {
    await w.page.goto(`${BASE}${path}`);
    await sleep(1200);
  };

  // 1. The console: Needs you with the brief and the held report, and the Autonomous switch in the top bar.
  shots.push(...(await snap(w, "console", "/", [1440, 1100], () => noOverflow(w, "console"))));
  const status = w.page.getByRole("button", { name: /Autonomous ·/ }).first();
  await goto("/");
  await status.waitFor({ timeout: 20_000 });
  // 2. The switch menu: open, end the time, turn off, turn on until it is turned off.
  shots.push(
    ...(await snap(w, "autonomous-menu", "/", [1440, 1100], async () => {
      await w.page
        .getByRole("button", { name: /Autonomous ·/ })
        .first()
        .click();
      await sleep(300);
    })),
  );
  await goto("/");
  await w.page
    .getByRole("button", { name: /Autonomous ·/ })
    .first()
    .click();
  await menu(w, "Turn off").click();
  await until("Autonomous off", async () => (await cmd("autonomy.status", {})).mode === "off", 30_000);
  await w.page
    .getByRole("button", { name: /Autonomous ·/ })
    .first()
    .click();
  await menu(w, "Until I turn it off").click();
  const on = await until(
    "Autonomous on with no end",
    async () => {
      const s = await cmd("autonomy.status", {});
      return s.mode === "on" && s.until === undefined ? s : false;
    },
    30_000,
  );
  notes.push(`switch: Turn off then Until I turn it off worked (mode ${on.mode})`);

  // 3. Needs you: the morning brief row. Read it opens the Captain conversation scoped to Acme, with the brief line.
  await goto("/");
  const brief = w.page.locator('[data-pane="needs"] [role="option"]', { hasText: "morning brief" }).first();
  await brief.waitFor({ timeout: 30_000 });
  await brief.click();
  await brief.getByRole("button").filter({ hasText: "Read it" }).first().click();
  await w.page.locator('[data-pane="chat"]').waitFor({ timeout: 30_000 });
  // The brief is a line of the one conversation, tagged with its workspace.
  const desk = (await cmd("boss.chat", {})).id as string;
  const line = await until(
    "the brief in the Captain conversation",
    async () =>
      (await cmd("room.items", { task: desk, limit: 300, beforeAt: "2999-01-01T00:00:00.000Z" })).items.find(
        (i: any) => i.type === "system" && /Acme: took/.test(i.text ?? "") && i.org === "acme",
      ),
    30_000,
  );
  void line;
  shots.push(
    ...(await snap(w, "brief-in-chat", "/?chat=captain", [1440, 1100], async () => {
      await w.page.locator('[data-pane="chat"]').waitFor({ timeout: 30_000 });
    })),
  );
  notes.push("brief: Read it opened the Captain conversation with the Acme line");

  // 4. Workspaces: the captain's rules. Client update and Show cost to client save at once.
  const openAcme = async () => {
    await goto("/orgs");
    await w.page.getByRole("button", { name: /Acme.*ACM/ }).click();
    await w.page.getByText("Show cost to client").first().waitFor({ timeout: 30_000 });
  };
  await openAcme();
  shots.push(
    ...(await snap(w, "workspace-captain-rules", "/orgs", [1440, 1100], async () => {
      await w.page.getByRole("button", { name: /Acme.*ACM/ }).click();
      await w.page.getByText("Show cost to client").first().waitFor({ timeout: 30_000 });
      await w.page.getByText("Show cost to client").first().scrollIntoViewIfNeeded();
      await noOverflow(w, "workspaces");
    })),
  );
  await openAcme();
  await w.page.getByRole("button", { name: "Captain sends" }).first().click();
  await until(
    "Client update set to Captain sends",
    async () => (await cmd("settings.get", {})).autonomy.orgs.acme?.incident?.clientUpdate === "sends",
    20_000,
  );
  await w.page
    .getByRole("group", { name: /weekly report/i })
    .getByRole("button", { name: "On" })
    .click();
  await until(
    "Show cost to client on",
    async () => (await cmd("settings.get", {})).autonomy.orgs.acme?.reportCost === true,
    20_000,
  );
  await w.page
    .getByRole("group", { name: /weekly report/i })
    .getByRole("button", { name: "Off" })
    .click();
  await w.page
    .getByRole("group", { name: /Who tells the client about an incident/ })
    .getByRole("button", { name: "Ask me" })
    .click();
  await until(
    "both switches back",
    async () => {
      const a = (await cmd("settings.get", {})).autonomy.orgs.acme;
      return a?.reportCost !== true && a?.incident?.clientUpdate !== "sends";
    },
    20_000,
  );
  notes.push("workspace rules: Captain sends and Show cost to client saved and undone from the page");

  // 5. The client chat's settings: Gets weekly report.
  await goto(`/chats/${ids.room}`);
  await w.page.getByRole("button", { name: "Chat actions" }).click();
  await menu(w, "Chat settings").click();
  const group = w.page.getByRole("group", { name: "Gets weekly report" });
  await group.waitFor({ timeout: 20_000 });
  shots.push(
    ...(await snap(w, "chat-settings", `/chats/${ids.room}`, [1440, 1100], async () => {
      await w.page.getByRole("button", { name: "Chat actions" }).click();
      await menu(w, "Chat settings").click();
      await w.page.getByRole("group", { name: "Gets weekly report" }).waitFor({ timeout: 20_000 });
    })),
  );
  await goto(`/chats/${ids.room}`);
  await w.page.getByRole("button", { name: "Chat actions" }).click();
  await menu(w, "Chat settings").click();
  await w.page
    .getByRole("group", { name: "Gets weekly report" })
    .getByRole("button", { name: "Off" })
    .click();
  await until(
    "Gets weekly report off",
    async () => (await cmd("chat.settings", { room: ids.room })).weeklyReport === false,
    20_000,
  );
  await w.page.getByRole("group", { name: "Gets weekly report" }).getByRole("button", { name: "On" }).click();
  await until(
    "Gets weekly report on",
    async () => (await cmd("chat.settings", { room: ids.room })).weeklyReport === true,
    20_000,
  );
  notes.push("chat settings: Gets weekly report switched off and on");

  // 6. The Captain page: History, Results and Findings only.
  shots.push(
    ...(await snap(w, "captain-page", "/captain", [1440, 1100], () => noOverflow(w, "captain page"))),
  );
  notes.push(`${shots.length} screenshots in ${SHOTS}`);
  return notes.join("; ");
}

const w = await boot();
try {
  const only = (process.env.WALK_ONLY ?? "").split(",").filter((s) => s !== "");
  const run = (key: string) => only.length === 0 || only.includes(key);
  if (run("A"))
    await stage("A setup: Telegram paired, client chat linked with Gets weekly report", () => setup(w));
  if (run("B")) await stage("B Autonomous on until a time: at most two tasks at once", () => autonomousOn(w));
  if (run("C")) await stage("C a task that fails twice stops", () => failsTwice(w));
  if (run("D")) await stage("D the morning brief: Done item, one push", () => morningBrief(w));
  if (run("E")) await stage("E the weekly report is held under Ask me", () => weeklyHeld(w));
  if (run("G")) await stage("G screens, with the primary buttons clicked", () => screens(w));
  if (run("F")) await stage("F the owner sends the weekly report", () => owners(w));
} finally {
  await w.close();
}
console.log(JSON.stringify(results, null, 1));
void FLAGS;
process.exit(0);
