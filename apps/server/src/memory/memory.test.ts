import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { openMemoryDb } from "./db.ts";
import { type Embedder, HashEmbedder } from "./embedder.ts";
import { capFacts, RECALL_CHARS } from "./recall.ts";
import { agentScopes, recallScopes } from "./scopes.ts";
import { fuse } from "./search.ts";
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
    expect(log.find((e) => e.action === "retired")?.reason).toBe("no longer true");
  });

  it("only pins an active fact", async () => {
    const m = service();
    const pending = await m.propose({
      text: "Run lint before push",
      scope: "org:acme",
      task: "ACM-1",
      agent: "b",
    });
    expect(() => m.pin(pending.id, true, owner)).toThrow(UserError);
    expect(m.pin(m.approve(pending.id, owner).id, true, owner).pinned).toBe(true);
  });

  it("refuses facts that hold a secret", async () => {
    const m = service();
    const text = "The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await expect(m.propose({ text, scope: "org:acme", task: "ACM-1", agent: "b" })).rejects.toThrow(/secret/);
    await expect(m.add({ text, scope: "org:acme", pinned: false }, owner)).rejects.toThrow(/secret/);
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
    ).rejects.toThrow(/20 facts/);
  });
});

describe("hybrid search", () => {
  it("fuses keyword and vector ranks: a fact both lists rank high beats one only one list has", () => {
    const scores = fuse([
      [1, 2, 3],
      [2, 4, 1],
    ]);
    const order = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(order.slice(0, 2)).toEqual([2, 1]);
    expect(scores.get(4)).toBeLessThan(scores.get(2) ?? 0);
  });

  it("merges keyword and vector matches, leaves out unrelated facts, and puts pinned facts first", async () => {
    const m = service();
    const scope = "project:acme-api";
    await m.add({ text: "Install packages with pnpm", scope, pinned: false }, owner);
    const pinned = await m.add({ text: "Never install packages as root", scope, pinned: true }, owner);
    await m.add({ text: "The office is closed on Fridays", scope, pinned: false }, owner);
    await m.add({ text: "Run pnpm install before the tests", scope, pinned: false }, owner);
    const hits = await m.search("pnpm install packages", { scopes: [scope] });
    expect(hits.map((h) => h.fact.text)[0]).toBe("Never install packages as root");
    expect(hits[0]?.fact.id).toBe(pinned.id);
    // Among the unpinned, the fact with more of the query's words ranks first.
    expect(hits[1]?.fact.text).toBe("Install packages with pnpm");
    expect(hits.map((h) => h.fact.text)).not.toContain("The office is closed on Fridays");
    expect(hits).toHaveLength(3);
  });

  it("keeps working with keywords when the model does not load, and fills vectors later", async () => {
    let up = false;
    const hash = new HashEmbedder();
    const flaky: Embedder = {
      embed: async (texts) => {
        if (!up) throw new Error("model not downloaded");
        return hash.embed(texts);
      },
    };
    const m = service(flaky);
    const scope = "org:acme";
    const fact = await m.add({ text: "Staging deploys use the blue cluster", scope, pinned: false }, owner);
    expect((await m.search("blue cluster", { scopes: [scope] })).map((h) => h.fact.id)).toEqual([fact.id]);

    up = true;
    expect(await m.fillVectors()).toBe(1);
    expect(await m.fillVectors()).toBe(0);
    expect((await m.search("blue cluster", { scopes: [scope] })).map((h) => h.fact.id)).toEqual([fact.id]);
  });

  it("gives up on a model that is still loading instead of holding the caller", async () => {
    const stuck: Embedder = { embed: () => new Promise(() => {}) };
    const m = service(stuck);
    const fact = await m.add({ text: "Use the internal registry", scope: "org:acme", pinned: false }, owner);
    expect((await m.search("registry", { scopes: ["org:acme"] })).map((h) => h.fact.id)).toEqual([fact.id]);
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

describe("recall", () => {
  it("cuts at about 500 tokens, keeps ranking order, and counts a task's use of a fact once", async () => {
    const m = service();
    const scope = "org:acme";
    for (let i = 0; i < 40; i++) {
      await m.add(
        { text: `Build rule ${i}: ${"keep the build green ".repeat(4)}`, scope, pinned: false },
        owner,
      );
    }
    const task = { id: "ACM-2", brief: "fix the build" };
    const first = await m.recall(task, [scope]);
    const chars = first.facts.reduce((n, f) => n + f.text.length, 0);
    expect(first.facts.length).toBeGreaterThan(5);
    expect(first.facts.length).toBeLessThan(40);
    expect(chars).toBeLessThanOrEqual(RECALL_CHARS);
    expect(capFacts(first.facts)).toHaveLength(first.facts.length);
    expect(m.recalled("ACM-2").map((f) => f.id)).toEqual(first.facts.map((f) => f.id));

    await m.recall(task, [scope]);
    for (const f of first.facts) expect(m.get(f.id)?.use_count).toBe(1);
    await m.recall({ id: "ACM-3", brief: "fix the build" }, [scope]);
    expect(m.get(first.facts[0]?.id ?? 0)?.use_count).toBe(2);
  });

  it("puts pinned facts of the scopes in even when the brief does not match them", async () => {
    const m = service();
    const pinned = await m.add(
      { text: "Always answer in British English", scope: "global", pinned: true },
      owner,
    );
    await m.add({ text: "Retry the flaky login test once", scope: "org:acme", pinned: false }, owner);
    const { facts } = await m.recall({ id: "ACM-2", brief: "the login test is flaky" }, [
      "global",
      "org:acme",
    ]);
    expect(facts.map((f) => f.id)[0]).toBe(pinned.id);
    expect(facts).toHaveLength(2);
  });
});
