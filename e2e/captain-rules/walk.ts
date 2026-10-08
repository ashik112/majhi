// biome-ignore-all lint/suspicious/noExplicitAny: a proof script reading untyped JSON from the API
/**
 * The captain-rules walk on a throwaway majhi with fakes (the incident walk's world). Four journeys of the one rule
 * set: Auto-pilot off and an incident (it investigates), Merge on Captain with Auto-pilot off (it merges), Undo of that
 * merge (the Merge line drops and the owner is told), and Stop everything (nothing moves). Run from the repository root:
 *
 *   WALK_PORT=7790 MAJHI_E2E_ROOT=<scratch>/root WALK_SHOTS=<scratch>/shots node --import tsx e2e/captain-rules/walk.ts
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOST_HOME } from "../paths.ts";
import { boot, cmd, results, shot, sleep, stage, until, type World } from "../incident-walk/walk.ts";
import { DB_PORT } from "../incident-walk/walk.ts";

void HOST_HOME;
void join;

const ROWS = {
  start: "decide",
  questions: "decide",
  approvals: "decide",
  upkeep: "decide",
  merge: "decide",
  push: "ask",
  deployStaging: "ask",
  deployProduction: "ask",
  tell: "ask",
  own: "ask",
} as const;

async function incidentTasks(): Promise<any[]> {
  const list = await cmd("tasks.list", { includeDone: true });
  return (Array.isArray(list) ? list : (list.tasks ?? [])).filter((t: any) => t.typing?.type === "incident");
}

async function autopilotOffIncident(w: World): Promise<string> {
  await cmd("autonomy.configure", { orgs: { acme: { authority: ROWS, incident: { soakMin: 1, cadenceMin: 5 } } } });
  const mode = (await cmd("autonomy.status", {})).mode;
  if (mode !== "off") throw new Error(`Auto-pilot should be off, it is ${mode}`);
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
  const running = await until("the investigation running", async () => {
    const t = await cmd("tasks.get", { id: task.id });
    return ["running", "review"].includes(t.status) ? t : false;
  }, 90_000);
  const cap = (await cmd("captain.status", {})) as any;
  return `Auto-pilot ${mode}, stopped ${cap.stopped}; incident ${task.id} is ${running.status} (it investigates without Auto-pilot)`;
}

async function leadCommits(id: string, file: string): Promise<void> {
  const task = await cmd("tasks.get", { id });
  const tree = task.repos[0]?.worktree as string;
  if (!tree) throw new Error("the task has no worktree yet");
  await cmd("room.send", {
    task: id,
    text: `Change the notes.\nrun: sh -c 'cd storefront && echo "${file}" > ${file}.txt && git add -A && git commit -q -m "feat(notes): ${file}"'`,
    attachments: [],
    mode: "interrupt",
  });
  await until("the commit", async () => {
    const asks = (await cmd("decisions.list", {})).decisions.filter((d: any) => d.task === id && d.kind === "approval");
    for (const d of asks) await cmd("decisions.answer", { id: d.id, option: d.options[0].id });
    return execFileSync("git", ["log", "--oneline", "-3"], { cwd: tree }).toString().includes(file) ? true : false;
  }, 120_000);
}

async function ownerTask(text: string): Promise<string> {
  const made = await cmd("tasks.create", { text, repos: [{ project: "storefront" }], attachments: [], start: true });
  await sleep(3000);
  return made.id;
}

const merged = async (id: string) => {
  const t = await cmd("tasks.get", { id });
  return (t.repos ?? []).some((r: any) => r.landed !== undefined) || t.status === "done";
};

async function captainMerges(w: World): Promise<string> {
  const id = await ownerTask("Add release notes @acme-lead");
  await leadCommits(id, "notes-one");
  const log = await until("the captain's merge in its log", async () => {
    const out = (await cmd("captain.log", { limit: 50 })) as any;
    return out.actions.find((a: any) => a.task === id && a.text.toLowerCase().includes("shipped")) ?? false;
  }, 180_000);
  const mode = (await cmd("autonomy.status", {})).mode;
  console.log(await shot(w, "10-merged", `/t/${id}`));
  if (!(await merged(id))) throw new Error(`${id} was not merged`);
  (w as any).mergedAction = log;
  (w as any).mergedTask = id;
  return `Merge = Captain, Auto-pilot ${mode}: ${id} merged by the captain ("${log.text}", undo ${log.undo})`;
}

async function undoDropsLine(w: World): Promise<string> {
  const action = (w as any).mergedAction;
  if (action.undo !== "yes") throw new Error(`the merge cannot be undone: ${action.undoNote}`);
  await cmd("captain.undo", { id: action.id });
  const row = await until("Merge dropped to You", async () => {
    const s = (await cmd("captain.status", {})) as any;
    const acme = s.orgs.find((o: any) => o.org === "acme");
    return acme.authority.merge === "ask" ? acme : false;
  }, 60_000);
  const notice = await until("the notice for the owner", async () => {
    const d = (await cmd("decisions.list", {})).decisions.find((x: any) => x.kind === "trust");
    return d ?? false;
  }, 60_000);
  console.log(await shot(w, "11-undo-notice", "/"));
  return `Merge is ${row.authority.merge}; notice: "${notice.title}"`;
}

async function stopEverything(w: World): Promise<string> {
  await cmd("autonomy.configure", { orgs: { acme: { authority: { merge: "decide" } } } });
  await cmd("captain.stop", {});
  const cap = (await cmd("captain.status", {})) as any;
  if (!cap.stopped) throw new Error("captain.status.stopped is false after Stop everything");
  const id = await ownerTask("Add more notes @acme-lead");
  await leadCommits(id, "notes-two");
  await until("the task in review", async () => ["review", "mr"].includes((await cmd("tasks.get", { id })).status), 120_000);
  await sleep(25_000);
  const t = await cmd("tasks.get", { id });
  if (await merged(id)) throw new Error(`${id} merged while Stop everything was on`);
  w.db.usage = 40;
  w.db.usage = 96;
  await sleep(5_000);
  console.log(await shot(w, "12-stopped", "/captain"));
  await cmd("captain.resume", {});
  const after = await until("the captain merges after Resume", async () => ((await merged(id)) ? true : false), 180_000);
  return `stopped: ${id} stayed ${t.status} for 25 s and was not merged; after Resume merged=${after}`;
}

const w = await boot();
try {
  await stage("A Auto-pilot off, incident investigates", () => autopilotOffIncident(w));
  console.log(await shot(w, "09-incident", "/"));
  await stage("B Merge = Captain, Auto-pilot off, ready task merges", () => captainMerges(w));
  await stage("D undo the captain's merge: line drops, owner told", () => undoDropsLine(w));
  await stage("C Stop everything: nothing moves", () => stopEverything(w));
} finally {
  await w.close();
}
console.log(JSON.stringify(results, null, 1));
process.exit(0);
