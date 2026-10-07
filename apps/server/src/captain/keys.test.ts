import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_ASK } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { planOf } from "./authority-fixtures.ts";
import { answerOnce, shipState } from "./keys.ts";
import { LaneGate } from "./lane-gate.ts";
import type { CaptainPorts, ShipCheck } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { CaptainTell } from "./tell.ts";

/**
 * G1: every captain action is keyed by the state it acts on, and a repeat with the same key does
 * nothing. A ship (task, heads, bases), an answer (card) and a tell (task, the lead's last turn) each
 * take their key in one insert; a store reopened (a restart) still holds it. Results are typed.
 */

const DAY = "2026-10-03";
const NOW = new Date(`${DAY}T12:00:00.000Z`);

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A database file the test can close and open again, as a restart does. */
async function dbFile(): Promise<{ open: () => CaptainRepo }> {
  const dir = await mkdtemp(join(tmpdir(), "majhi-keys-"));
  dirs.push(dir);
  const file = join(dir, "majhi.db");
  return {
    open: () => {
      const store = new Store(file);
      stores.push(store);
      return new CaptainRepo(store.raw);
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("the key claim", () => {
  it("gives one of two calls with the same key the action, and the other a typed reason", () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    expect(repo.claimKey("tell", "k1", "ACM-1", NOW.toISOString())).toBe("taken");
    expect(repo.claimKey("tell", "k1", "ACM-1", NOW.toISOString())).toBe("in-flight");
    repo.settleKey("k1");
    expect(repo.claimKey("tell", "k1", "ACM-1", NOW.toISOString())).toBe("repeat");
    expect(repo.claimKey("tell", "k2", "ACM-1", NOW.toISOString())).toBe("taken");
  });

  it("lets two connections to one database race: one wins on the unique key", async () => {
    const db = await dbFile();
    const a = db.open();
    const b = db.open();
    const results = [
      a.claimKey("answer", "answer:ACM-1:i1", "ACM-1", NOW.toISOString()),
      b.claimKey("answer", "answer:ACM-1:i1", "ACM-1", NOW.toISOString()),
    ];
    expect(results.filter((r) => r === "taken")).toHaveLength(1);
  });

  it("takes a claim over when the call that held it never finished, and gives it back on release", () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    expect(repo.claimKey("ship", "k", undefined, NOW.toISOString())).toBe("taken");
    const later = new Date(NOW.getTime() + 61 * 60_000).toISOString();
    expect(repo.keyState("k", later)).toBe("free");
    expect(repo.claimKey("ship", "k", undefined, later)).toBe("taken");
    repo.releaseKey("k");
    expect(repo.claimKey("ship", "k", undefined, later)).toBe("taken");
  });

  it("holds a key that settled across a reopened database", async () => {
    const db = await dbFile();
    const first = db.open();
    expect(first.claimKey("tell", "tell:ACM-1:lead:7", "ACM-1", NOW.toISOString())).toBe("taken");
    first.settleKey("tell:ACM-1:lead:7");
    stores.pop()?.close();
    const second = db.open();
    expect(second.claimKey("tell", "tell:ACM-1:lead:7", "ACM-1", NOW.toISOString())).toBe("repeat");
    expect(second.claimKey("tell", "tell:ACM-1:lead:8", "ACM-1", NOW.toISOString())).toBe("taken");
  });
});

describe("answering a card", () => {
  it("answers once: the same card twice is one answer and a typed repeat", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    let answers = 0;
    const answer = async () => {
      answers += 1;
    };
    expect(await answerOnce(repo, NOW, { task: "ACM-1", item: "i1" }, answer)).toEqual({ answered: true });
    expect(await answerOnce(repo, NOW, { task: "ACM-1", item: "i1" }, answer)).toEqual({
      answered: false,
      why: "repeat",
    });
    expect(answers).toBe(1);
    // Another card is another key.
    expect(await answerOnce(repo, NOW, { task: "ACM-1", item: "i2" }, answer)).toEqual({ answered: true });
    expect(answers).toBe(2);
  });

  it("gives the key back when the answer fails, so the card can be answered again", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    await expect(
      answerOnce(repo, NOW, { task: "ACM-1", item: "i1" }, async () => {
        throw new Error("the agent is gone");
      }),
    ).rejects.toThrow("the agent is gone");
    expect(await answerOnce(repo, NOW, { task: "ACM-1", item: "i1" }, async () => undefined)).toEqual({
      answered: true,
    });
  });
});

describe("a note to a lead", () => {
  function tellSetup(repo: CaptainRepo, state: { turn: number }) {
    const sent: string[] = [];
    const tell = new CaptainTell({
      tasks: {
        captainTell: async (input: { task: string; agent?: string | undefined; text: string }) => {
          await tick();
          sent.push(input.text);
          return { id: input.task, agent: input.agent ?? "acme-builder" };
        },
      },
      lanes: { boss: async () => "boss", orgOf: () => "acme" },
      store: { tasks: { get: (id: string) => ({ id, org: "acme", team: ["acme-builder"] }) } },
      keys: repo,
      lastTurn: () => state.turn,
      now: () => NOW,
    } as unknown as ConstructorParameters<typeof CaptainTell>[0]);
    return { sent, tell };
  }
  const lane = { kind: "agent", id: "boss", task: "LOCAL-1" } as const;

  it("sends one note per turn of the lead, and refuses the next with a typed reason", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    const state = { turn: 5 };
    const t = tellSetup(repo, state);
    expect(await t.tell.tell({ id: "ACM-1", text: "first" }, lane)).toEqual({
      id: "ACM-1",
      agent: "acme-builder",
      told: true,
    });
    expect(await t.tell.tell({ id: "ACM-1", text: "second" }, lane)).toEqual({
      id: "ACM-1",
      agent: "acme-builder",
      told: false,
      refused: "already-told",
    });
    expect(t.sent).toEqual(["first"]);
    // The lead took a new turn: a new key, so a new note goes.
    state.turn = 6;
    expect(await t.tell.tell({ id: "ACM-1", text: "third" }, lane)).toMatchObject({ told: true });
    expect(t.sent).toEqual(["first", "third"]);
  });

  it("gives the key back when the send fails, so the note can be sent again", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    let fail = true;
    const tell = new CaptainTell({
      tasks: {
        captainTell: async (input: { task: string }) => {
          if (fail) throw new Error("ACM-1 is paused");
          return { id: input.task, agent: "acme-builder" };
        },
      },
      lanes: { boss: async () => "boss", orgOf: () => "acme" },
      store: { tasks: { get: (id: string) => ({ id, org: "acme", team: ["acme-builder"] }) } },
      keys: repo,
      lastTurn: () => 1,
      now: () => NOW,
    } as unknown as ConstructorParameters<typeof CaptainTell>[0]);
    await expect(tell.tell({ id: "ACM-1", text: "x" }, lane)).rejects.toThrow("paused");
    fail = false;
    expect(await tell.tell({ id: "ACM-1", text: "x" }, lane)).toMatchObject({ told: true });
  });
});

describe("a ship", () => {
  function shipSetup(repo: CaptainRepo) {
    const state = {
      heads: "acme-api@abc123",
      bases: "acme-api@base1",
      check: {
        ready: true,
        evidence: "committed, merges cleanly into main",
        targets: [{ project: "acme-api", into: "main", base: "main" }],
      } as ShipCheck,
    };
    const ports = {
      reviewTasks: async () => [{ id: "ACM-1", title: "Fix", heads: state.heads, bases: state.bases }],
      shipCheck: async () => state.check,
      shipPlan: async () => planOf({ ...ALL_ASK, merge: "decide" }),
      newRepos: async () => [],
    } as unknown as Pick<CaptainPorts, "reviewTasks" | "shipCheck" | "newRepos" | "shipPlan">;
    const gate = new LaneGate({
      repo,
      ports,
      workspace: async (org) => ({
        org,
        name: "Acme",
        mode: "on",
        authority: { ...ALL_ASK, merge: "decide" },
        rules: undefined,
        tz: "UTC",
        day: DAY,
      }),
      now: () => NOW,
    });
    return { state, gate };
  }
  const merge = { id: "ACM-1", into: "main" };
  const keyOf = (s: { heads: string; bases: string }) => `ship:ACM-1:${shipState(s)}`;

  it("ships a state once: the same task, head and base twice is one ship", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    const t = shipSetup(repo);
    expect(await t.gate.check("acme", "tasks.merge", merge)).toBeUndefined();
    await t.gate.ran("acme", "tasks.merge", merge, "ready", { ok: true });
    expect(repo.hasAction(keyOf(t.state))).toBe(true);
    expect(t.gate.claim(keyOf(t.state), "ACM-1")).toBe("repeat");
    expect(await t.gate.check("acme", "tasks.merge", merge)).toContain("already");
  });

  it("holds the ship's key after a restart, but not a failed ship's", async () => {
    const db = await dbFile();
    const first = shipSetup(db.open());
    expect(await first.gate.check("acme", "tasks.merge", merge)).toBeUndefined();
    await first.gate.ran("acme", "tasks.merge", merge, "", { ok: true });
    stores.pop()?.close();
    const second = shipSetup(db.open());
    expect(second.gate.claim(keyOf(second.state), "ACM-1")).toBe("repeat");

    // A failed ship takes no key: the same state may be tried again.
    second.state.heads = "acme-api@other";
    expect(await second.gate.check("acme", "tasks.merge", merge)).toBeUndefined();
    await second.gate.ran("acme", "tasks.merge", merge, "", { ok: false, error: "conflicts" });
    expect(await second.gate.check("acme", "tasks.merge", merge)).toBeUndefined();
  });
});
