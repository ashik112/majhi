/**
 * Fills the memory of a running e2e server (`MAJHI_E2E_SEED=ui`) so the Memory screens have something
 * to show: two tasks in alpha-api and facts in every state, with the log lines curation would leave.
 * Run it after the server is up: `MAJHI_E2E_PORT=7075 pnpm exec tsx e2e/memory-seed.ts`.
 * The facts are written through the memory service without a model, so no tokens and no download.
 */
import { join } from "node:path";
import { openMemoryDb } from "../apps/server/src/memory/db.ts";
import { MemoryService } from "../apps/server/src/memory/service.ts";
import { MemoryStore } from "../apps/server/src/memory/store.ts";
import { E2E_PORT, MAJHI_HOME } from "./fixture.ts";

const base = `http://127.0.0.1:${E2E_PORT}`;

async function cmd<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}/api/cmd/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const done = await cmd<{ id: string }>("tasks.create", {
  text: "document the install steps in alpha-api",
  start: false,
});
const open = await cmd<{ id: string }>("tasks.create", {
  text: "add a health endpoint to alpha-api",
  start: false,
});
await cmd("tasks.close", { id: done.id });

const db = openMemoryDb(join(MAJHI_HOME, "memory", "memory.db"));
const memory = new MemoryService({ store: new MemoryStore(db) });
const owner = { kind: "owner" } as const;
const agent = "globex-builder";
const from = (task: string, text: string, scope: string) => memory.propose({ text, scope, task, agent });

// Kept on its own, and pinned by the owner.
const pnpm = await from(done.id, "Use pnpm, not npm, to install packages in alpha-api", "project:alpha-api");
memory.keep(pnpm.id, {
  reason: "A lasting convention for this repo, not task chatter.",
  confidence: 0.93,
  provider: "laya",
});
// Approved by the owner.
const env = await from(
  done.id,
  "Integration tests need DATABASE_URL to point at the test database",
  "project:alpha-api",
);
memory.approve(env.id, owner);
memory.pin(env.id, true, owner);
// Waits: the rules cannot tell, and a global fact always waits.
await from(done.id, "Deploys to staging are cut from a release/* branch", "org:globex");
await from(done.id, "Answers and commit messages are written in British English", "global");
// Dropped on its own.
const flaky = await from(done.id, "Skip the flaky login test until the fix is in", "project:alpha-api");
memory.drop(flaky.id, {
  reason: "Task chatter: it is only true until this task's fix lands.",
  confidence: 0.91,
  provider: "laya",
});
// A newer fact retires an older one.
const node20 = await from(done.id, "Node 20 is required to build alpha-api", "project:alpha-api");
memory.approve(node20.id, owner);
const node22 = await from(done.id, "Node 22 is required to build alpha-api", "project:alpha-api");
memory.keep(node22.id, {
  reason: `Lasting, and it contradicts fact ${node20.id}.`,
  confidence: 0.88,
  provider: "laya",
});
memory.retire(node20.id, {
  reason: `Contradicted by fact ${node22.id}: Node 22 is required to build alpha-api.`,
  confidence: 0.88,
  provider: "laya",
});
// Owner facts in other scopes, for the filters. One is already in AGENTS.md.
await memory.add(
  { text: "beta-web builds need bun 1.2 or newer", scope: "project:beta-web", pinned: false },
  owner,
);
await memory.add(
  { text: "Acme reviews every change with two people", scope: "org:acme", pinned: false },
  owner,
);
const releases = await memory.add(
  { text: "Releases are cut from develop", scope: "project:alpha-api", pinned: false },
  owner,
);
memory.setPromoted(releases.id, open.id, owner);
// A proposal from the task that is still open.
await from(open.id, "The api serves /health without a login", "project:alpha-api");

// Task records, the brief and its history, and open threads, as the Housekeeper leaves them.
const route = await cmd<{ id: string }>("tasks.create", {
  text: "move the health check of alpha-api to its own route",
  start: false,
});
const logging = await cmd<{ id: string }>("tasks.create", {
  text: "add request logging to alpha-api with a request id on every line",
  start: false,
});
await cmd("tasks.close", { id: route.id });
await cmd("tasks.close", { id: logging.id });
const project = memory.project;
const merged = (head: string, commits: number) => [
  { project: "alpha-api", branch: "task/x", base: "main", merged: true, head, commits },
];
await project.putRecord({
  task: done.id,
  title: "Document the install steps in alpha-api",
  org: "globex",
  projects: ["alpha-api"],
  asked: "Write down how to install and run alpha-api locally, for new people on the team.",
  done: "Added an Install section to README.md: Node 22, `pnpm install`, `pnpm dev`, and the DATABASE_URL the integration tests need. Removed the old npm steps from docs/setup.md.",
  decisions:
    "Kept the steps in the README instead of a separate guide, so they are the first thing people see.",
  outcome: "Merged into main at 4c1e9a2. `pnpm test` passed.",
  left: "The Docker steps are still missing.",
  repos: merged("4c1e9a2", 2),
  agent: "globex-builder",
});
await project.putRecord({
  task: route.id,
  title: "Move the health check of alpha-api to its own route",
  org: "globex",
  projects: ["alpha-api"],
  asked:
    "Serve the health check on /health instead of the root route, so the load balancer stops logging it as traffic.",
  done: "Moved the handler to src/routes/health.ts and registered it in src/server.ts. The root route now returns 404. Updated the load balancer probe in deploy/lb.yaml.",
  decisions:
    "The check answers without a login, since the load balancer has no token. It reports the database as up only after one query answers.",
  outcome: "Merged into main at 9b27d40 with 3 commits. Unit tests and `pnpm e2e health` passed.",
  left: "The readiness probe in deploy/k8s.yaml still points at the root route (thread opened). Old dashboards query the root route.",
  repos: merged("9b27d40", 3),
  agent: "globex-builder",
});
await project.putRecord({
  task: logging.id,
  title: "Add request logging to alpha-api with a request id on every line",
  org: "globex",
  projects: ["alpha-api"],
  asked: "Log every request with a request id, so one request can be followed through the logs.",
  done: "Added src/middleware/request-id.ts, which reads X-Request-Id or makes one, and a pino child logger per request in src/log.ts. Every handler now logs through `req.log`.",
  decisions:
    "pino over winston: it was already a dependency of the worker. Health checks are not logged, to keep the noise down.",
  outcome:
    "Not merged yet: waiting on the merge request https://github.com/acme/alpha-api/pull/42. Tests passed.",
  left: "",
  repos: [
    {
      project: "alpha-api",
      branch: "task/y",
      base: "main",
      merged: false,
      head: "e71a03c",
      commits: 4,
      mr: "https://github.com/acme/alpha-api/pull/42",
    },
  ],
  agent: "globex-builder",
});
project.patchBrief(
  "alpha-api",
  {
    "What it is":
      "The Globex orders api: a Node 22 service that takes orders from the web shop and hands them to the worker.",
    Architecture:
      "- src/server.ts: the HTTP server and routes.\n- src/routes/: one file per route.\n- src/db/: the Postgres client and migrations.\n- deploy/: load balancer and Kubernetes files.",
    "Current state": "Installs with pnpm. The health check is on the root route.",
    "Plans and next steps": "Move the health check to its own route.",
    "Known problems": "The load balancer logs every health check as traffic.",
  },
  { task: done.id, agent: "globex-builder" },
);
project.patchBrief(
  "alpha-api",
  {
    "Current state": "Installs with pnpm. The health check is on /health and needs no login.",
    "Plans and next steps": "Point the readiness probe at /health. Add request logging.",
    "Known problems": "Old dashboards still query the root route.",
  },
  { task: route.id, agent: "globex-builder" },
);
project.patchBrief(
  "alpha-api",
  {
    "Current state":
      "Installs with pnpm. The health check is on /health and needs no login. Requests are logged with a request id (merge request open).",
    "Plans and next steps": "Point the readiness probe at /health. Write the Docker steps.",
  },
  { task: logging.id, agent: "globex-builder" },
);
project.openThread({
  text: "Write the Docker steps in the README",
  project: "alpha-api",
  org: "globex",
  task: done.id,
});
project.openThread({
  text: "Point the readiness probe in deploy/k8s.yaml at /health",
  project: "alpha-api",
  org: "globex",
  task: route.id,
});
const dashboards = project.openThread({
  text: "Old dashboards query the root route for uptime; move them to /health",
  project: "alpha-api",
  org: "globex",
  task: route.id,
});
project.closeThread(dashboards.id, "owner", "Dashboards were moved by hand.");
project.openThread({
  text: "beta-web shows a blank page when the api is down",
  project: "beta-web",
  org: "acme",
  task: open.id,
});

console.log(`Seeded memory: done task ${done.id}, open task ${open.id}`);
await memory.close();
