import { type WatchDef, WatchDefSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { MIN, type OpsWorld, opsWorld } from "../testing.ts";

/** A paused watch says who paused it and why, and one the owner did not choose resumes once it reads fine. */

function world(): OpsWorld {
  const w = opsWorld();
  w.conns.set("acme-prod", {
    org: "acme",
    type: "env",
    name: "acme-prod",
    fields: {},
    vars: { DATABASE_URL: "postgres://app:pw@db.acme.example:5432/shop" },
  });
  return w;
}

const def: WatchDef = WatchDefSchema.parse({
  name: "Postgres acme-prod: memory",
  spec: { kind: "database", connection: "acme-prod", engine: "postgres", query: "SELECT 1", label: "memory" },
  condition: { type: "above", value: 90, forMin: 10 },
  everyMin: 5,
  fire: { alert: { on: true, phone: false }, investigate: false, fix: { mode: "off", allowed: [] } },
});

const only = async (w: OpsWorld) => {
  const [v] = (await w.ops.engine.overview("acme")).watches;
  if (v === undefined) throw new Error("no watch");
  return v;
};

describe("a paused watch", () => {
  it("shows the owner's pause and keeps it however long it reads fine", async () => {
    const w = world();
    w.backend.sqlAnswer = () => "10";
    const saved = await w.ops.engine.save({ org: "acme", def });
    await w.ops.engine.pause(saved.id, true, "owner", "planned move");
    expect((await only(w)).paused).toEqual({ by: "owner", why: "You paused it: planned move" });
    for (let i = 0; i < 6; i += 1) {
      w.advance(5 * MIN);
      await w.ops.engine.tick();
    }
    expect((await only(w)).status).toBe("paused");
  });

  it("an agent's pause carries its reason and resumes by itself once the watch reads fine", async () => {
    const w = world();
    w.backend.sqlAnswer = () => "10";
    const saved = await w.ops.engine.save({ org: "acme", def });
    await w.ops.engine.pause(saved.id, true, "agent", "the database tool was missing");
    const paused = await only(w);
    expect(paused.status).toBe("paused");
    expect(paused.paused).toMatchObject({ by: "agent" });
    expect(paused.paused?.why).toContain("the database tool was missing");

    // Still unreadable: it stays paused, and keeps its reason.
    w.backend.sqlAnswer = () => {
      throw new Error("no client");
    };
    w.advance(5 * MIN);
    await w.ops.engine.tick();
    expect((await only(w)).status).toBe("paused");

    // The cause clears: the next look reads, and the watch is back.
    w.backend.sqlAnswer = () => "12";
    w.advance(5 * MIN);
    await w.ops.engine.tick();
    const back = await only(w);
    expect(back.paused).toBeUndefined();
    expect(back.status).toBe("ok");
  });
});
