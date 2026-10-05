import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_ASK } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { answerKey, answerOnce, once, shipState, tellKey } from "./keys.ts";
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

  it("builds a different key for each state", () => {
    expect(answerKey("ACM-1", "i1")).not.toBe(answerKey("ACM-1", "i2"));
    expect(tellKey("ACM-1", "lead", 3)).not.toBe(tellKey("ACM-1", "lead", 4));
    expect(shipState({ heads: "api@a", bases: "api@b" })).not.toBe(
      shipState({ heads: "api@a", bases: "api@c" }),
    );
    expect(shipState({ heads: "api@a" })).toBe("api@a");
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

  it("makes one answer of ten calls at once, and the rest say it is running", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    let answers = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        answerOnce(repo, NOW, { task: "ACM-1", item: "i1" }, async () => {
          await tick();
          answers += 1;
        }),
      ),
    );
    expect(answers).toBe(1);
    expect(results.filter((r) => r.answered)).toHaveLength(1);
    expect(results.filter((r) => !r.answered && r.why === "in-flight")).toHaveLength(9);
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

  it("still holds the answered card after a restart", async () => {
    const db = await dbFile();
    expect(await answerOnce(db.open(), NOW, { task: "ACM-1", item: "i1" }, async () => undefined)).toEqual({
      answered: true,
    });
    stores.pop()?.close();
    let again = 0;
    const second = await answerOnce(db.open(), NOW, { task: "ACM-1", item: "i1" }, async () => {
      again += 1;
    });
    expect(second).toEqual({ answered: false, why: "repeat" });
    expect(again).toBe(0);
  });

  it("runs a once-step with its own kind and returns its value", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    const r = await once(repo, NOW, { kind: "x", key: "x:1" }, async () => 42);
    expect(r).toEqual({ done: true, value: 42 });
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

  it("sends one note when two calls come at once with the same lead turn", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    const t = tellSetup(repo, { turn: 1 });
    const results = await Promise.all([
      t.tell.tell({ id: "ACM-1", text: "a" }, lane),
      t.tell.tell({ id: "ACM-1", text: "b" }, lane),
    ]);
    expect(t.sent).toHaveLength(1);
    expect(results.filter((r) => r.told)).toHaveLength(1);
    expect(results.find((r) => !r.told)).toMatchObject({ told: false, refused: "in-flight" });
  });

  it("refuses the repeat after a restart too: the key is in the database", async () => {
    const db = await dbFile();
    const state = { turn: 9 };
    const before = tellSetup(db.open(), state);
    expect(await before.tell.tell({ id: "ACM-1", text: "first" }, lane)).toMatchObject({ told: true });
    stores.pop()?.close();
    const after = tellSetup(db.open(), state);
    expect(await after.tell.tell({ id: "ACM-1", text: "again" }, lane)).toMatchObject({
      told: false,
      refused: "already-told",
    });
    expect(after.sent).toEqual([]);
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
      newRepos: async () => [],
    } as unknown as Pick<CaptainPorts, "reviewTasks" | "shipCheck" | "newRepos">;
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

  it("makes one ship of two calls at once, and the second is told it is running", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    const t = shipSetup(repo);
    const refusals = await Promise.all([
      t.gate.check("acme", "tasks.merge", merge),
      t.gate.check("acme", "tasks.merge", merge),
    ]);
    expect(refusals.filter((r) => r === undefined)).toHaveLength(1);
    expect(t.gate.claim(keyOf(t.state), "ACM-1")).toBe("in-flight");
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

  it("acts on a new head commit and on a new base", async () => {
    const repo = new CaptainRepo(new Store(":memory:").raw);
    const t = shipSetup(repo);
    expect(await t.gate.check("acme", "tasks.merge", merge)).toBeUndefined();
    await t.gate.ran("acme", "tasks.merge", merge, "", { ok: true });
    t.state.heads = "acme-api@def456";
    expect(await t.gate.check("acme", "tasks.merge", merge)).toBeUndefined();
    await t.gate.ran("acme", "tasks.merge", merge, "", { ok: true });
    // The same head onto a base that moved is another state.
    t.state.bases = "acme-api@base2";
    expect(await t.gate.check("acme", "tasks.merge", merge)).toBeUndefined();
  });
});
