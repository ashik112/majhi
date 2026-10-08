// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The journeys. Stage names are the ones in the report. Run: node --import tsx e2e/incident-walk/journey.ts
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOST_HOME } from "../paths.ts";
import { boot, cmd, DB_PORT, GITLAB_PORT, results, setReplies, shot, sleep, stage, until, type World } from "./walk.ts";

const REPO = join(HOST_HOME, "Work", "storefront");

const TRIAGE_OUTAGE =
  '{"action":"task","reason":"The client says the server is down","incident":null,"outage":true}';
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
  await cmd("chat.channelLink", { connection: "slack", channel: "C0CLIENT", org: "acme" });
  setReplies([
    { when: "You triage one message", say: TRIAGE_OUTAGE },
    { when: "Write a short title", say: TITLE },
  ]);
  void w;
  return "Acme: Start, Tell, Merge, Push are the captain's; Auto-pilot on; soak 1 min; Slack channel linked";
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
  return `the claim joined ${task.id} (evidence: the firing watch); client was told: "${sent.text}"`;
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
  await cmd("incident.cause", {
    task: id,
    text: "The orders report query scanned the whole table and kept the database busy",
    client: "A slow query on the orders page was keeping the database busy",
  });
  return `lead committed the fix in ${tree}; cause recorded`;
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
  const task = await cmd("tasks.get", { id });
  if (task.status !== "done") throw new Error(`task is ${task.status}, not done`);
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
    { when: "You triage one message", say: TRIAGE_OUTAGE },
    { when: "Write a short title", say: TITLE },
    {
      when: "Rewrite this incident report",
      say: JSON.stringify({
        internal: { summary: "Database usage hit 95% and was fixed by indexing the orders query.", impact: "Orders page slow for the client.", cause: "The orders report query scanned the whole table.", fix: "Added a limit and an index; deployed to production.", followUps: "None." },
        client: { summary: "The orders page was slow because of a database problem, and it is fixed.", impact: "Your orders page was affected.", cause: "A slow query was keeping the database busy.", fix: "We shipped a fix to production.", followUps: "None." },
      }),
    },
  ]);
  const view = await until("the report", async () => {
    const v = await cmd("incident.view", { task: id });
    return v?.report ? v : false;
  }, 120_000);
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
  git("-c", "user.name=owner", "-c", "user.email=o@a.example", "commit", "--allow-empty", "-q", "-m", "chore: a change that breaks the deploy");
  w.hosts.branches.set("gitlab:acme/storefront:main", git("rev-parse", "main"));
  w.hosts.outcome.gitlab = "failed";
  const before = (await incidentTasks()).length;
  const out = await cmd("projects.deploy", { project: "storefront", env: "production", runs: GL_RUNS });
  const failed = await until("the failed deploy", async () => {
    const v = await cmd("projects.deployView", { project: "storefront" });
    const r = v.history.find((h: any) => h.id === out.record.id);
    return r && ["failed", "rolled-back"].includes(r.state) && r.incident ? r : false;
  }, 120_000);
  const card = await until("the Needs you card", async () => {
    const d = (await cmd("decisions.list", {})).decisions.find((x: any) => x.id.startsWith("iask:deploy:"));
    return d ?? false;
  }, 60_000);
  const tasks = await incidentTasks();
  if (tasks.length !== before + 1) throw new Error(`expected one new incident task, saw ${tasks.length - before}`);
  const mine = tasks.find((t: any) => t.id === failed.incident);
  if (!mine) throw new Error("the deploy has no incident task");
  console.log(await shot(w, "07-deploy-failed-needs-you", "/decisions"));
  console.log(await shot(w, "07-deploy-failed-board"));
  // The owner presses Roll back (the fake pipeline succeeds again), through the card.
  w.hosts.outcome.gitlab = "success";
  if (card.options.some((o: any) => o.id === "rollback")) await cmd("decisions.answer", { id: card.id, option: "rollback" });
  const v = await cmd("projects.deployView", { project: "storefront" });
  const rec = v.history.find((h: any) => h.id === out.record.id);
  return `deploy ${failed.state} ("${card.title}"); incident ${mine.id} is ${mine.status}; after the card: ${rec.state}, rollback ${JSON.stringify(rec.rollback?.ok)}`;
}

async function refireAndRecover(w: World): Promise<string> {
  const before = (await incidentTasks()).map((t: any) => t.id).toSorted();
  w.db.usage = 96;
  const reopened = await until("ACM-1 reopened by the re-fire", async () => {
    const t = await cmd("tasks.get", { id: "ACM-1" });
    return t.status !== "done" ? t : false;
  }, 240_000);
  const after = (await incidentTasks()).map((t: any) => t.id).toSorted();
  if (after.length !== before.length) throw new Error(`a duplicate incident appeared: ${before} -> ${after}`);
  console.log(await shot(w, "08-refire", "/t/ACM-1"));
  w.db.usage = 40;
  const card = await until("the recovered-on-its-own card", async () => {
    const d = (await cmd("decisions.list", {})).decisions.find((x: any) => x.id === "iask:recovered:ACM-1");
    return d ?? false;
  }, 300_000);
  console.log(await shot(w, "08-recovered", "/t/ACM-1"));
  await cmd("decisions.answer", { id: card.id, option: "close" });
  const done = await cmd("tasks.get", { id: "ACM-1" });
  return `re-fire reopened ACM-1 (${reopened.status}) with no new task; recovery card "${card.title}"; closed -> ${done.status}`;
}

const w = await boot();
const only = process.argv.slice(2);
const run = (name: string) => only.length === 0 || only.includes(name);
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
  void [execFileSync, until, sleep, results, REPO, run];
} finally {
  await w.close();
}
process.exit(0);
