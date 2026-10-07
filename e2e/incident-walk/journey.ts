// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The journeys. Stage names are the ones in the report. Run: node --import tsx e2e/incident-walk/journey.ts
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOST_HOME } from "../paths.ts";
import { boot, cmd, results, setReplies, shot, sleep, stage, until, type World } from "./walk.ts";

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
      { env: "production", tier: "production", check: "http://127.0.0.1:7492/health/production" },
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
      spec: { kind: "website", url: "http://127.0.0.1:7493/", jsonPath: "db.usage" },
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
  const told = w.slack.sent.map((m) => m.text);
  if (task.status !== "done") throw new Error(`task is ${task.status}, not done`);
  if (!told.some((t) => t.includes("resolved")))
    throw new Error(`the client was never told Resolved: ${JSON.stringify(told)}`);
  return `monitoring (${view.facts}), then Resolved; task ${task.status}; client was told ${told.length} messages, the last: "${told.at(-1)}"`;
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
  void [execFileSync, until, sleep, results, REPO, run];
} finally {
  await w.close();
}
process.exit(0);
