import { afterEach, describe, expect, it } from "vitest";
import { adminTools } from "../admin/tools.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("the authority level of a workspace", () => {
  it("is set by the owner alone: an agent's actor is refused, no tool exists for it, and autonomy.configure does not take it", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const level = async () => (await h.cmd("settings.get")).body.autonomy.orgs.acme;

    const set = await h.cmd("authority.set", { org: "acme", level: "full", fix: "ships" });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ org: "acme", level: "full", fix: "ships", clientUpdate: "ask" });
    expect(await level()).toEqual({ level: "full", incident: { fix: "ships" } });

    // The captain's and every agent's actor is refused at the command itself.
    const captain = { actor: { kind: "agent", id: "boss" } };
    expect((await h.cmd("authority.set", { org: "acme", level: "ask" }, captain)).status).toBe(409);
    expect((await h.cmd("authority.set", { org: "acme", fix: "ask" }, captain)).status).toBe(409);
    // It is no tool of the captain or of any agent.
    expect(adminTools().some((tool) => tool.command === "authority.set")).toBe(false);

    // autonomy.configure takes neither the level nor the two switches, and clearing the incident
    // settings keeps what the owner chose for them.
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { level: "ask" } } })).status).toBe(400);
    expect(
      (await h.cmd("autonomy.configure", { orgs: { acme: { incident: { clientUpdate: "sends" } } } })).status,
    ).toBe(400);
    expect(
      (await h.cmd("autonomy.configure", { orgs: { acme: { incident: { soakMin: 30 } } } })).status,
    ).toBe(200);
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { incident: null } } })).status).toBe(200);
    expect(await level()).toEqual({ level: "full", incident: { fix: "ships" } });

    // The owner can take it back.
    expect((await h.cmd("authority.set", { org: "acme", level: "ask", fix: "ask" })).status).toBe(200);
    expect((await level()).level).toBe("ask");
  });
});
