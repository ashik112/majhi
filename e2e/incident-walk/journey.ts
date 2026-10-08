// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The journeys. Stage names are the ones in the report. Run: node --import tsx e2e/incident-walk/journey.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_HOME } from "../paths.ts";
import {
  boot,
  cmd,
  DB_PORT,
  GITLAB_PORT,
  PORT,
  results,
  setReplies,
  shot,
  sleep,
  stage,
  until,
  type World,
} from "./walk.ts";

const REPO = join(HOST_HOME, "Work", "storefront");

let room = "";
const TITLE = "Database usage over 90% on storefront";

async function setup(w: World): Promise<string> {
  await cmd("autonomy.configure", {
    orgs: {
      acme: {
        authority: {
          start: "decide",
          questions: "decide",
          approvals: "decide",
          upkeep: "decide",
          merge: "decide",
          push: "decide",
          deployStaging: "decide",
          deployProduction: "ask",
          tell: "decide",
          own: "ask",
        },
        incident: { soakMin: 1, cadenceMin: 5 },
        holds: { firstContact: false },
      },
    },
  });
  await cmd("autonomy.start", {});
  await cmd("ops.settings", { escalateMin: 10, resolveMin: 1 });
  await cmd("projects.setEnvironments", {
    project: "storefront",
    environments: [
      { env: "production", tier: "production", check: `http://127.0.0.1:${GITLAB_PORT}/health/production` },
    ],
  });
  const row = await cmd("chat.channelLink", { connection: "slack", channel: "C0CLIENT", org: "acme" });
  room = row.id;
  setReplies([{ when: "Write a short title", say: TITLE }]);
  void w;
  return "Acme: Start, Tell, Merge, Push are the captain's; Auto-pilot on; soak 1 min; Slack channel linked";
}

const FLAGS = { promisedTime: false, money: false, security: false, severalClients: false };
const WATCH_NAME = "Storefront up or down";

/**
 * The captain is the fake agent, scripted: it does what a person on call would do. A client message: read the chat,
 * look at the watches, open the incident with what it found, tell the client, and add a watch that only alerts. A status
 * change of the incident: tell the chat. The script is read from the lane's folder on every turn.
 */
async function scriptCaptain(room: string): Promise<void> {
  const findLane = async () =>
    ((await cmd("autonomy.status")).lanes as any[]).find((l) => l.org === "acme" && l.chat !== undefined);
  // The lane is made on the captain's first turn: the owner asking it about the incident makes it.
  if ((await findLane()) === undefined) await cmd("incident.askCaptain", { task: "ACM-1" });
  const lane = await until("the captain's lane", findLane);
  // Reacting work runs in the on-call lane, backlog work in the main one: both read the same script.
  const lanes = [lane.chat as string];
  const onCall = await until("the on-call lane", async () => {
    const l = ((await cmd("autonomy.status")).lanes as any[]).find((x) => x.org === "acme");
    return l?.onCall;
  });
  lanes.push(onCall as string);
  const folders = await Promise.all(
    lanes.map(async (id) => (await cmd("tasks.get", { id })).folder as string),
  );
  const reply = (text: string) => ({ tool: "majhi_chat_reply", args: { room, text, ...FLAGS } });
  const script = JSON.stringify({
    rules: [
      {
        when: "refund",
        flags: "",
        steps: [
          {
            tool: "majhi_chat_reply",
            args: { room, text: "We will refund the order within two days.", ...FLAGS, money: true },
          },
        ],
      },
      {
        when: "Status now: it is resolved",
        flags: "",
        steps: [reply("This is resolved. Tell us here if you see it again.")],
      },
      {
        when: "<message ",
        flags: "",
        steps: [
          { tool: "majhi_chat_history", args: { room } },
          { tool: "majhi_watch_overview", args: { org: "acme" } },
          {
            tool: "majhi_chat_openIncident",
            args: {
              room,
              found:
                "The live check answers and no deploy failed lately, but a watch is firing on the database.",
            },
          },
          reply(
            "I checked our watches and recent deploys and found a database problem. I opened an incident and we are on it.",
          ),
          {
            tool: "majhi_watch_save",
            args: {
              reason: "No watch covers the live check address",
              org: "acme",
              def: {
                name: WATCH_NAME,
                spec: { kind: "website", url: `http://127.0.0.1:${GITLAB_PORT}/health/production` },
                condition: { type: "down" },
                everyMin: 5,
                fire: { alert: { on: true, phone: false }, investigate: true },
                project: "storefront",
              },
            },
          },
          {
            tool: "majhi_autonomy_note",
            args: { text: `Added a watch: ${WATCH_NAME}`, org: "acme" },
          },
        ],
      },
      {
        when: "<event>",
        flags: "",
        steps: [reply("Update on the incident: we are working on it and will tell you here as it moves.")],
      },
    ],
  });
  for (const folder of folders) writeFileSync(join(folder, "CAPTAIN_SCRIPT.json"), script);
}

async function incidentTasks(): Promise<any[]> {
  const list = await cmd("tasks.list", { includeDone: true });
  return (Array.isArray(list) ? list : (list.tasks ?? [])).filter((t: any) => t.typing?.type === "incident");
}

async function watchFires(w: World): Promise<string> {
  w.db.usage = 95;
  await cmd("watch.save", {
    org: "acme",
    def: {
      name: "Database usage",
      spec: { kind: "website", url: `http://127.0.0.1:${DB_PORT}/`, jsonPath: "db.usage" },
      condition: { type: "above", value: 90 },
      everyMin: 1,
      fire: { alert: { on: true, phone: false }, investigate: true },
      project: "storefront",
    },
  });
  const task = await until("the incident task", async () => (await incidentTasks())[0], 120_000);
  return `watch fired, incident task ${task.id} (${task.title}) on ${JSON.stringify(task.repos?.map((r: any) => r.project))}, status ${task.status}`;
}

async function clientSaysDown(w: World): Promise<string> {
  await scriptCaptain(room);
  w.slack.post({
    channel: "C0CLIENT",
    user: "U0SARA",
    text: "Hi, the server is down! Our orders page does not load.",
  });
  const sent = await until("the first reply in Slack", async () => w.slack.sent[0], 120_000);
  const tasks = await incidentTasks();
  if (tasks.length !== 1) throw new Error(`expected one incident task, saw ${tasks.length}`);
  const task = await cmd("tasks.get", { id: tasks[0].id });
  const linked = (task.links ?? []).filter((l: any) => l.type === "client");
  if (linked.length === 0) throw new Error("the chat is not linked to the incident task");
  const watches = JSON.stringify(await cmd("watch.overview", { org: "acme" }));
  if (!watches.includes(WATCH_NAME)) throw new Error("the captain did not add the watch");
  return `the captain opened or joined ${task.id}, told the client: "${sent.text}", and added the watch "${WATCH_NAME}"`;
}

async function leadFixes(w: World, id: string): Promise<string> {
  const task = await cmd("tasks.get", { id });
  const tree = task.repos[0]?.worktree as string;
  if (!tree) throw new Error("the task has no worktree yet");
  // The lead, scripted: it edits the slow query and commits, the way the fake agent runs a shell step.
  await cmd("room.send", {
    task: id,
    text: `Fix the slow orders query.\nrun: sh -c 'cd storefront && echo "orders: select * from orders limit 100 (indexed)" > orders.txt && git add -A && git commit -q -m "fix(orders): index and limit the slow orders query"'`,
    attachments: [],
    mode: "interrupt",
  });
  await until(
    "the permission card or the commit",
    async () => {
      const asks = (await cmd("decisions.list", {})).decisions.filter(
        (d: any) => d.task === id && d.kind === "approval",
      );
      for (const d of asks) await cmd("decisions.answer", { id: d.id, option: d.options[0].id });
      const log = execFileSync("git", ["log", "--oneline", "-3"], { cwd: tree }).toString();
      return log.includes("fix(orders)") ? log : false;
    },
    120_000,
  );
  const toldBefore = w.slack.sent.length;
  await cmd("incident.cause", {
    task: id,
    text: "The orders report query scanned the whole table and kept the database busy",
    client: "A slow query on the orders page was keeping the database busy",
  });
  await until(
    "the client to get a reply for Identified",
    async () => w.slack.sent.length > toldBefore,
    90_000,
  );
  return `lead committed the fix in ${tree}; cause recorded; the client got a reply after the status change`;
}

const GL_RUNS = [{ kind: "gitlab-pipeline", remote: "origin", ref: "base" }];
const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO }).toString().trim();

async function ship(w: World, id: string): Promise<string> {
  await until(
    "the task in review",
    async () => ["review", "mr"].includes((await cmd("tasks.get", { id })).status),
    120_000,
  );
  await cmd("tasks.merge", { id, done: false });
  const sha = git("rev-parse", "main");
  // The fake GitLab has no git over http: its main branch is moved to the merged commit, which is what a push does.
  w.hosts.branches.set("gitlab:acme/storefront:main", sha);
  const out = await cmd("projects.deploy", {
    project: "storefront",
    env: "production",
    runs: GL_RUNS,
    task: id,
  });
  const done = await until(
    "the deploy to go live",
    async () => {
      const v = await cmd("projects.deployView", { project: "storefront" });
      const r = v.history.find((h: any) => h.id === out.record.id);
      if (r?.state === "failed") throw new Error(`deploy failed: ${r.reason}`);
      return r?.state === "live" ? r : false;
    },
    120_000,
  );
  return `merged ${sha.slice(0, 7)} into main, pushed (fake GitLab main moved), deploy ${done.id} live`;
}

async function recovers(w: World, id: string): Promise<string> {
  w.db.usage = 40;
  const view = await until(
    "the watch to go green",
    async () => {
      const v = await cmd("incident.view", { task: id });
      return v?.status === "monitoring" ? v : false;
    },
    240_000,
  );
  const resolved = await until(
    "Resolved after the soak",
    async () => {
      const v = await cmd("incident.view", { task: id });
      return v?.status === "resolved" ? v : false;
    },
    300_000,
  );
  // The incident sweep closes the task a moment after the status flips.
  const task = await until(
    "the task to be done",
    async () => {
      const t = await cmd("tasks.get", { id });
      return t.status === "done" ? t : false;
    },
    90_000,
  );
  // The client hears of it on the next incident sweep (every 20 s), not at the instant the status flips.
  await until(
    "the client to be told Resolved",
    async () => w.slack.sent.some((m) => m.text.includes("resolved")),
    60_000,
  ).catch(() => {
    throw new Error(`the client was never told Resolved: ${JSON.stringify(w.slack.sent.map((m) => m.text))}`);
  });
  const told = w.slack.sent.map((m) => m.text);
  return `monitoring (${view.facts}), then Resolved; task ${task.status}; client was told ${told.length} messages, the last: "${told.at(-1)}"`;
}

async function rcaSent(w: World, id: string): Promise<string> {
  setReplies([
    { when: "Write a short title", say: TITLE },
    {
      when: "Rewrite this incident report",
      say: JSON.stringify({
        internal: {
          summary: "Database usage hit 95% and was fixed by indexing the orders query.",
          impact: "Orders page slow for the client.",
          cause: "The orders report query scanned the whole table.",
          fix: "Added a limit and an index; deployed to production.",
          followUps: "None.",
        },
        client: {
          summary: "The orders page was slow because of a database problem, and it is fixed.",
          impact: "Your orders page was affected.",
          cause: "A slow query was keeping the database busy.",
          fix: "We shipped a fix to production.",
          followUps: "None.",
        },
      }),
    },
  ]);
  const view = await until(
    "the report",
    async () => {
      const v = await cmd("incident.view", { task: id });
      return v?.report ? v : false;
    },
    120_000,
  );
  const room = view.rooms[0].room;
  const sentBefore = w.slack.sent.length;
  const out = await cmd("incident.sendReport", { task: id, room });
  const after = await cmd("incident.view", { task: id });
  if (after.report.sent.length !== 1) throw new Error("the report is not marked sent");
  const msg = w.slack.sent[sentBefore];
  if (!msg) throw new Error("nothing reached Slack");
  if (msg.text.includes("# ")) throw new Error(`markdown headings reached Slack: ${msg.text}`);
  return `RCA sent (${out.state}); Slack got: ${JSON.stringify(msg.text).slice(0, 200)}`;
}

async function failedDeploy(w: World): Promise<string> {
  git(
    "-c",
    "user.name=owner",
    "-c",
    "user.email=o@a.example",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "chore: a change that breaks the deploy",
  );
  w.hosts.branches.set("gitlab:acme/storefront:main", git("rev-parse", "main"));
  w.hosts.outcome.gitlab = "failed";
  const before = (await incidentTasks()).length;
  const out = await cmd("projects.deploy", { project: "storefront", env: "production", runs: GL_RUNS });
  const failed = await until(
    "the failed deploy",
    async () => {
      const v = await cmd("projects.deployView", { project: "storefront" });
      const r = v.history.find((h: any) => h.id === out.record.id);
      return r && ["failed", "rolled-back"].includes(r.state) && r.incident ? r : false;
    },
    120_000,
  );
  const card = await until(
    "the Needs you card",
    async () => {
      const d = (await cmd("decisions.list", {})).decisions.find((x: any) => x.id.startsWith("iask:deploy:"));
      return d ?? false;
    },
    60_000,
  );
  const tasks = await incidentTasks();
  if (tasks.length !== before + 1)
    throw new Error(`expected one new incident task, saw ${tasks.length - before}`);
  const mine = tasks.find((t: any) => t.id === failed.incident);
  if (!mine) throw new Error("the deploy has no incident task");
  console.log(await shot(w, "07-deploy-failed-needs-you", "/decisions"));
  console.log(await shot(w, "07-deploy-failed-board"));
  // The owner presses Roll back (the fake pipeline succeeds again), through the card.
  w.hosts.outcome.gitlab = "success";
  if (card.options.some((o: any) => o.id === "rollback"))
    await cmd("decisions.answer", { id: card.id, option: "rollback" });
  const v = await cmd("projects.deployView", { project: "storefront" });
  const rec = v.history.find((h: any) => h.id === out.record.id);
  return `deploy ${failed.state} ("${card.title}"); incident ${mine.id} is ${mine.status}; after the card: ${rec.state}, rollback ${JSON.stringify(rec.rollback?.ok)}`;
}

async function refireAndRecover(w: World): Promise<string> {
  const before = (await incidentTasks()).map((t: any) => t.id).toSorted();
  w.db.usage = 96;
  const reopened = await until(
    "ACM-1 reopened by the re-fire",
    async () => {
      const t = await cmd("tasks.get", { id: "ACM-1" });
      return t.status !== "done" ? t : false;
    },
    240_000,
  );
  const after = (await incidentTasks()).map((t: any) => t.id).toSorted();
  if (after.length !== before.length) throw new Error(`a duplicate incident appeared: ${before} -> ${after}`);
  console.log(await shot(w, "08-refire", "/t/ACM-1"));
  w.db.usage = 40;
  const card = await until(
    "the recovered-on-its-own card",
    async () => {
      const d = (await cmd("decisions.list", {})).decisions.find((x: any) => x.id === "iask:recovered:ACM-1");
      return d ?? false;
    },
    300_000,
  );
  console.log(await shot(w, "08-recovered", "/t/ACM-1"));
  await cmd("decisions.answer", { id: card.id, option: "close" });
  const done = await cmd("tasks.get", { id: "ACM-1" });
  return `re-fire reopened ACM-1 (${reopened.status}) with no new task; recovery card "${card.title}"; closed -> ${done.status}`;
}

const laneItems = async (task: string): Promise<any[]> =>
  (await cmd("room.items", { task, limit: 200 })).items;
const cardFor = async (task: string, fragment: string) =>
  (await laneItems(task)).find((i) => i.type === "permission" && String(i.title).includes(fragment));

/**
 * The captain's two lanes: a backlog lane stuck on a card for the owner, and a client who says the site is down.
 * Read-only commands run without a card; a command that is not read-only (or reaches an unknown host) asks. The
 * client's message goes to the on-call lane and is answered while the first lane still waits. A second message that
 * waits behind a card in the on-call lane shows that card in the chat with Allow, and Allow answers it. A held reply
 * can be discarded.
 */
async function unblock(w: World): Promise<string> {
  await scriptCaptain(room);
  const main = ((await cmd("autonomy.status")).lanes as any[]).find((l) => l.org === "acme").chat as string;
  const onCall = ((await cmd("autonomy.status")).lanes as any[]).find((l) => l.org === "acme")
    .onCall as string;
  if (main === onCall) throw new Error("the two lanes are one chat");
  const notes: string[] = [];

  // 1. Read-only commands run without a card; one that is not read-only asks.
  await cmd("room.send", {
    task: main,
    text: `run: curl -s -o /dev/null -w %{http_code} http://127.0.0.1:${GITLAB_PORT}/health/production\nrun: ls -la\nrun: git log --oneline`,
  });
  const auto = await until("the read-only commands to run", async () => {
    const items = (await laneItems(main)).filter((i) => i.type === "permission");
    return items.length >= 3 ? items : false;
  });
  if (auto.some((i) => i.state === "pending"))
    throw new Error(`a read-only command asked: ${JSON.stringify(auto.map((i) => [i.title, i.state]))}`);
  notes.push(`${auto.length} read-only commands (curl to a known host, ls, git log) ran with no card`);

  // 2. The lane gets stuck on a command that is not read-only.
  await cmd("room.send", { task: main, text: "run: git push origin nothing" });
  const stuck = await until("the card for the push", () => cardFor(main, "push"));
  if (stuck.state !== "pending") throw new Error(`the push did not ask: ${stuck.state}`);
  notes.push(
    "a push (not read-only, the captain has no push of its own here) asked, and the main lane is stuck on it",
  );

  // 3. The client writes while the main lane waits: the on-call lane answers.
  const before = w.slack.sent.length;
  w.slack.post({ channel: "C0CLIENT", user: "U0SARA", text: "nbr is down, the site is down!" });
  await until("a reply from the on-call lane", async () => w.slack.sent.length > before, 120_000);
  const still = await cardFor(main, "push");
  if (still?.state !== "pending") throw new Error("the main lane's card was answered by something else");
  notes.push(`the client got "${w.slack.sent.at(-1)?.text.slice(0, 60)}" while the main lane still waited`);

  // 4. A message waiting behind a card in the on-call lane shows it, with Allow.
  await cmd("room.send", { task: onCall, text: "run: gh pr merge 99" });
  const card = await until("the on-call card", () => cardFor(onCall, "pr merge"));
  w.slack.post({ channel: "C0CLIENT", user: "U0SARA", text: "still down, please check again" });
  await w.page.goto(`http://127.0.0.1:${PORT}/chats`);
  await w.page.getByText("#acme-client").first().click();
  await w.page
    .getByText("still down, please check again")
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined);
  const line = w.page.getByText("The captain is waiting for your OK on").first();
  await line.waitFor({ timeout: 40_000 }).catch(async (err) => {
    console.log(
      await shotHere(w, "09-debug"),
      JSON.stringify((await cmd("captain.status", {})).orgs.map((o: any) => [o.org, o.blocker, o.lane])),
      JSON.stringify(
        (await cmd("room.items", { task: room, limit: 5 })).items.map((i: any) => [i.type, i.outcome]),
      ),
    );
    throw err;
  });
  console.log(await shotHere(w, "09-waiting-on-card"));
  await w.page.getByRole("button", { name: "Allow", exact: true }).first().click();
  await until(
    "the card to be answered",
    async () => (await cardFor(onCall, "pr merge"))?.state === "answered",
  );
  notes.push("the chat showed the pending card with Allow, and Allow answered it");
  void card;

  // 5. A held reply can be discarded.
  w.slack.post({ channel: "C0CLIENT", user: "U0SARA", text: "can I get a refund for my order?" });
  await w.page.reload();
  await w.page.getByText("#acme-client").first().click();
  await w.page.getByText("Reply waits for you").first().waitFor({ timeout: 120_000 });
  console.log(await shotHere(w, "09-held-reply"));
  await w.page.setViewportSize({ width: 1100, height: 800 });
  console.log(await shotHere(w, "09-held-reply-1100"));
  await w.page.setViewportSize({ width: 1440, height: 900 });
  await w.page.getByRole("button", { name: "Discard", exact: true }).first().click();
  await w.page.getByText("Reply discarded").first().waitFor({ timeout: 30_000 });
  console.log(await shotHere(w, "09-discarded"));
  notes.push("a held reply was discarded from the chat");
  return notes.join("; ");
}

async function shotHere(w: World, name: string): Promise<string> {
  const file = join(process.env.WALK_SHOTS ?? ".", `${name}.png`);
  await w.page.screenshot({ path: file });
  return file;
}

const w = await boot();
const only = process.argv.slice(2);
const run = (name: string) => (only.length === 0 && name !== "9") || only.includes(name);
try {
  await stage("0 setup", () => setup(w));
  console.log(await shot(w, "00-setup"));
  if (run("1")) {
    await stage("1 watch fires, incident task opens", () => watchFires(w));
    console.log(await shot(w, "01-watch-incident"));
  }
  if (run("2")) {
    await stage("2 client says server is down", () => clientSaysDown(w));
    console.log(await shot(w, "02-client-claim"));
  }
  if (run("3")) {
    await stage("3 lead fixes (scripted commit) and cause recorded", () => leadFixes(w, "ACM-1"));
    console.log(await shot(w, "03-lead-fix", "/t/ACM-1"));
  }
  if (run("4")) {
    await stage("4 ship: merge, push, deploy", () => ship(w, "ACM-1"));
    console.log(await shot(w, "04-shipped", "/t/ACM-1"));
  }
  if (run("5")) {
    await stage("5 watch green, soak, Resolved, client told", () => recovers(w, "ACM-1"));
    console.log(await shot(w, "05-resolved", "/t/ACM-1"));
  }
  if (run("6")) {
    await stage("6 RCA written, owner sends, card stays frozen", () => rcaSent(w, "ACM-1"));
    console.log(await shot(w, "06-rca-sent", "/t/ACM-1"));
  }
  if (run("7")) await stage("7 failed deploy journey", () => failedDeploy(w));
  if (run("8")) await stage("8 watch re-fire and recovery without a fix", () => refireAndRecover(w));
  if (only.includes("9")) await stage("9 two lanes, read-only commands, waiting line", () => unblock(w));
  void [execFileSync, until, sleep, results, REPO, run];
} finally {
  await w.close();
}
process.exit(0);
