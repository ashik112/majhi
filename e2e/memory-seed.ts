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

console.log(`Seeded memory: done task ${done.id}, open task ${open.id}`);
await memory.close();
