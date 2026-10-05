import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { openMemoryDb } from "./db.ts";
import { type Embedder, HashEmbedder } from "./embedder.ts";
import { agentScopes, recallScopes } from "./scopes.ts";
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

const owner: Actor = { kind: "owner" };
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));

function service(embedder: Embedder | undefined = new HashEmbedder(), file = ":memory:") {
  const db = openMemoryDb(file);
  return new MemoryService({ store: new MemoryStore(db), embedder, now, embedWaitMs: 200 });
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("memory store", () => {
  it("applies its migrations once and keeps facts across a reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "majhi-mem-"));
    dirs.push(dir);
    const file = join(dir, "memory", "memory.db");
    const first = service(new HashEmbedder(), file);
    const fact = await first.add(
      { text: "Use pnpm for installs", scope: "project:acme-api", pinned: false },
      owner,
    );
    await first.close();
    const again = service(new HashEmbedder(), file);
    expect(again.get(fact.id)?.text).toBe("Use pnpm for installs");
    expect(await again.search("pnpm", { scopes: ["project:acme-api"] })).toHaveLength(1);
    await again.close();
  });

  it("moves a fact through pending, active, retired and rejected, and logs each step on its task", async () => {
    const m = service();
    const fact = await m.propose({
      text: "Deploys need the staging tag",
      scope: "org:acme",
      task: "ACM-1",
      agent: "builder",
    });
    expect(fact).toMatchObject({ status: "pending", task: "ACM-1", agent: "builder" });
    // Pending facts are not recalled.
    expect(await m.search("staging", { scopes: ["org:acme"] })).toHaveLength(0);

    const active = m.approve(fact.id, owner);
    expect(active).toMatchObject({ status: "active", decided_by: "owner" });
    expect(active.valid_from).toBeDefined();
    expect(await m.search("staging", { scopes: ["org:acme"] })).toHaveLength(1);

    const retired = m.forget(fact.id, owner, "no longer true");
    expect(retired.status).toBe("retired");
    expect(retired.valid_to).toBeDefined();
    expect(await m.search("staging", { scopes: ["org:acme"] })).toHaveLength(0);
    expect(() => m.approve(fact.id, owner)).toThrow(UserError);

    const dropped = await m.propose({
      text: "Tabs, not spaces",
      scope: "org:acme",
      task: "ACM-1",
      agent: "builder",
    });
    expect(m.reject(dropped.id, owner).status).toBe("rejected");
    // A rejected fact can still be approved, which is what undo relies on.
    expect(m.approve(dropped.id, owner).status).toBe("active");
    expect(() => m.reject(dropped.id, owner)).toThrow(UserError);

    const log = m.events({ task: "ACM-1" });
    expect(log.map((e) => e.action).reverse()).toEqual([
      "proposed",
      "approved",
      "retired",
      "proposed",
      "rejected",
      "approved",
    ]);
  });

  it("refuses facts that hold a secret", async () => {
    const m = service();
    const text = "The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await expect(m.propose({ text, scope: "org:acme", task: "ACM-1", agent: "b" })).rejects.toThrow();
    await expect(m.add({ text, scope: "org:acme", pinned: false }, owner)).rejects.toThrow();
    expect(m.list({})).toHaveLength(0);
  });

  it("stops one task from proposing more than 20 facts", async () => {
    const m = service();
    for (let i = 0; i < 20; i++) {
      await m.propose({
        text: `Fact number ${i} about builds`,
        scope: "org:acme",
        task: "ACM-1",
        agent: "b",
      });
    }
    await expect(
      m.propose({ text: "One more fact", scope: "org:acme", task: "ACM-1", agent: "b" }),
    ).rejects.toThrow();
  });
});

describe("scope isolation", () => {
  it("never returns a fact from a scope that was not asked for", async () => {
    const m = service();
    await m.add({ text: "Acme builds run on the blue cluster", scope: "org:acme", pinned: true }, owner);
    await m.add({ text: "Globex builds run on the red cluster", scope: "org:globex", pinned: true }, owner);
    await m.add({ text: "Globex web builds use bun", scope: "project:globex-web", pinned: false }, owner);
    const seen = async (scopes: string[]) =>
      (await m.search("builds cluster bun", { scopes })).map((h) => h.fact.scope).sort();
    expect(await seen(["org:acme"])).toEqual(["org:acme"]);
    expect(await seen(["global", "org:acme", "project:acme-api"])).toEqual(["org:acme"]);
    expect(await seen([])).toEqual([]);
  });

  it("recalls global, the org and the task's repos of that org; agents may also use the org's other projects", () => {
    const projects = new Map([
      ["acme-api", "acme"],
      ["acme-web", "acme"],
      ["globex-web", "globex"],
    ]);
    const task = { org: "acme", repos: [{ project: "acme-api" }, { project: "globex-web" }] };
    expect(recallScopes(task, projects)).toEqual(["global", "org:acme", "project:acme-api"]);
    expect(agentScopes(task, projects)).toEqual([
      "global",
      "org:acme",
      "project:acme-api",
      "project:acme-web",
    ]);
    expect(recallScopes({ repos: task.repos }, projects)).toEqual(["global"]);
    expect(agentScopes({ repos: task.repos }, projects)).toEqual(["global"]);
  });
});
