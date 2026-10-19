import { rm } from "node:fs/promises";
import type { Actor } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDb } from "./db.ts";
import { type Embedder, HashEmbedder } from "./embedder.ts";
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
  it("refuses facts that hold a secret", async () => {
    const m = service();
    const text = "The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await expect(m.propose({ text, scope: "org:acme", task: "ACM-1", agent: "b" })).rejects.toThrow();
    await expect(m.add({ text, scope: "org:acme", pinned: false }, owner)).rejects.toThrow();
    expect(m.list({})).toHaveLength(0);
  });
});
