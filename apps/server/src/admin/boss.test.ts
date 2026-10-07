import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { PROPOSED_TEXT } from "./proposals.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const say = (text: string) => w.h.cmd("room.send", { task: w.chat.id, text });
const idle = () => w.h.majhi.services.runs.idle(w.chat.id);
const cards = async () =>
  (await w.items()).filter((i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval");
const orgIds = async () =>
  (await w.h.cmd("orgs.list")).body.map((o: { id: string }) => o.id).filter((id: string) => id !== "private");
const ORG_CALL =
  'call: majhi_orgs_create {"id":"acme2","name":"Acme Two","ownerAsked":false,"reason":"the owner wants a second company"}';

describe("the captain through the fake adapter", () => {
  it("logs a rejection, and changes nothing", async () => {
    w = await bossWorld();
    expect((await say(ORG_CALL)).status).toBe(200);
    await idle();
    const [card] = await cards();
    const rejected = await w.h.cmd("room.approve", { task: w.chat.id, item: card?.id, decision: "reject" });
    expect(rejected.body.item).toMatchObject({ state: "rejected" });
    expect(await orgIds()).toEqual(["acme"]);
    expect(w.h.majhi.services.store.permissions.audit(w.chat.id)).toMatchObject([
      { kind: "orgs.create", decision: "deny", by: "owner" },
    ]);
  });

  it("revokes the token when the session ends", async () => {
    w = await bossWorld();
    const tokens = w.h.majhi.services.adminTokens;
    await say("hello");
    await idle();
    expect(tokens.size).toBe(1);
    await w.h.majhi.services.runs.stop(w.chat.id);
    expect(tokens.size).toBe(0);
  });
});

describe("the captain proposes what it may not do alone", () => {
  const MERGE = { orgs: { acme: { authority: { merge: "decide" as const } } } };

  async function lane() {
    w = await bossWorld();
    const { h } = w;
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await h.majhi.services.autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const caller = { task: chat, agent: "boss" };
    const call = (tool: string, args: Record<string, unknown>) =>
      h.majhi.services.admin.call(caller, tool, { ...args, ownerAsked: false, reason: "test" });
    const merge = async () => (await h.cmd("settings.get")).body.autonomy.orgs.acme.authority.merge;
    const proposals = async () =>
      (await w!.items(chat)).filter((i) => i.type === "approval") as Extract<
        RoomItem,
        { type: "approval" }
      >[];
    const decisions = async () =>
      (await h.cmd("decisions.list")).body.decisions as {
        id: string;
        options: { id: string; label: string }[];
        blocked?: string;
      }[];
    return { h, chat, call, merge, proposals, decisions };
  }

  it("becomes a card with a plain diff, and changes nothing", async () => {
    const { call, merge, proposals, decisions } = await lane();
    const before = await merge();
    const result = await call("majhi_autonomy_configure", MERGE);
    expect(result).toEqual({ text: PROPOSED_TEXT, isError: false });
    expect(await merge()).toBe(before);
    const [card] = await proposals();
    expect(card).toMatchObject({ state: "pending", command: "autonomy.configure" });
    expect(card?.proposal?.changes).toEqual(["Merge: You → Captain"]);
    expect(JSON.parse(card?.input ?? "{}")).toEqual(MERGE);
    // The same call again is the same card.
    await call("majhi_autonomy_configure", MERGE);
    expect(await proposals()).toHaveLength(1);
    const mine = (await decisions()).find((d) => d.id.includes(card?.id ?? "?"));
    expect(mine?.options.map((o) => o.label)).toEqual(["Apply", "Reject"]);
  });

  it("refuses another workspace and the global settings, and other agents entirely", async () => {
    const { call, proposals } = await lane();
    expect(
      (await call("majhi_autonomy_configure", { orgs: { globex: { authority: { merge: "decide" } } } }))
        .isError,
    ).toBe(true);
    expect((await call("majhi_autonomy_configure", { day: { cost: 500 } })).isError).toBe(true);
    expect(await proposals()).toHaveLength(0);
    const other = await w!.h.majhi.services.admin.call(
      { task: "ACM-1", agent: "acme-builder" },
      "majhi_autonomy_configure",
      { ...MERGE, ownerAsked: true, reason: "test" },
    );
    expect(other.isError).toBe(true);
  });

  it("applies exactly the stored input when the owner clicks Apply", async () => {
    const { h, call, merge, proposals, decisions } = await lane();
    await call("majhi_autonomy_configure", MERGE);
    const [card] = await proposals();
    const id = (await decisions()).find((d) => d.id.includes(card?.id ?? "?"))?.id ?? "";
    expect((await h.cmd("decisions.answer", { id, option: "approve" })).status).toBe(200);
    expect(await merge()).toBe("decide");
    expect((await proposals())[0]).toMatchObject({ state: "applied" });
    // Only that row moved: the rest of the workspace's table is as the owner left it.
    const authority = (await h.cmd("settings.get")).body.autonomy.orgs.acme.authority;
    expect(authority).toEqual({ ...RUNS, merge: "decide" });
  });

  it("is never applied by a non-owner, a rule or the captain's own upkeep", async () => {
    const { h, chat, call, merge, proposals } = await lane();
    await call("majhi_autonomy_configure", MERGE);
    const [card] = await proposals();
    const admin = h.majhi.services.admin;
    const agent = { actor: { kind: "agent", id: "boss" }, task: chat };
    expect(
      (await h.cmd("room.approve", { task: chat, item: card?.id, decision: "approve" }, agent)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await h.cmd("decisions.answer", { id: `room:${chat}:${card?.id}`, option: "approve" }, agent)).status,
    ).toBeGreaterThanOrEqual(400);
    await expect(
      admin.decide(chat as never, card?.id ?? "", "approve", undefined, { by: "captain" }),
    ).rejects.toThrow(/owner/);
    expect(admin.cardCall(chat, card?.id ?? "")).toBeUndefined();
    expect(
      await admin.captainDecide(chat, card?.id ?? "", { decision: "approved", why: "x" }, "boss"),
    ).toMatchObject({ ok: false });
    // No always-allow rule can answer it, even for the owner.
    await expect(
      admin.decide(chat as never, card?.id ?? "", "approve", {
        scope: "task",
        change: { command: "room.approve", meta: { actor: { kind: "owner" } }, summary: "x" },
      }),
    ).rejects.toThrow(/never with a saved rule/);
    expect(await merge()).toBe("ask");
    expect((await proposals())[0]).toMatchObject({ state: "pending" });
  });

  it("stays a proposal under auto policy, full access and an always rule", async () => {
    const { h, call, merge, proposals } = await lane();
    expect(
      (
        await h.cmd("policy.set", {
          change: "auto",
          destructive: "auto",
          outbound: "auto",
          commands: { "autonomy.configure": "auto" },
        })
      ).status,
    ).toBe(200);
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { fullAccess: true } } })).status).toBe(200);
    const before = await merge();
    expect(
      await call("majhi_autonomy_configure", {
        orgs: { acme: { authority: { deployProduction: "decide" } } },
      }),
    ).toEqual({
      text: PROPOSED_TEXT,
      isError: false,
    });
    expect(await merge()).toBe(before);
    const card = (await proposals()).find((i) => i.proposal !== undefined);
    expect(card?.state).toBe("pending");
    const settings = (await h.cmd("settings.get")).body.autonomy.orgs.acme;
    expect(settings.authority?.deployProduction ?? "ask").toBe("ask");
  });

  it("cannot be applied once the setting changed after it was proposed", async () => {
    const { h, chat, call, merge, proposals, decisions } = await lane();
    await call("majhi_autonomy_configure", MERGE);
    const [card] = await proposals();
    // The owner moves the same workspace's table by hand: the diff no longer describes what would happen.
    expect(
      (await h.cmd("autonomy.configure", { orgs: { acme: { authority: { push: "decide" } } } })).status,
    ).toBe(200);
    const listed = (await decisions()).find((d) => d.id.includes(card?.id ?? "?"));
    expect(listed?.options.map((o) => o.label)).toEqual(["Reject"]);
    expect(listed?.blocked).toContain("changed");
    expect((await h.cmd("room.approve", { task: chat, item: card?.id, decision: "approve" })).status).toBe(
      409,
    );
    expect(await merge()).toBe("ask");
    expect((await proposals())[0]).toMatchObject({ state: "pending" });
  });

  it("proposes an environment change its own rail refuses, and runs one it allows", async () => {
    const { h, call, proposals } = await lane();
    const envs = async () => (await h.cmd("projects.deployView", { project: "acme-api" })).body.environments;
    const allowed = await call("majhi_projects_setEnvironments", {
      project: "acme-api",
      environments: [{ env: "production", tier: "production" }],
    });
    expect(allowed.isError).toBe(false);
    expect(allowed.text).not.toBe(PROPOSED_TEXT);
    const before = await envs();
    const staged = await call("majhi_projects_setEnvironments", {
      project: "acme-api",
      environments: [{ env: "production", tier: "staging" }],
    });
    expect(staged).toEqual({ text: PROPOSED_TEXT, isError: false });
    expect(await envs()).toEqual(before);
    const card = (await proposals()).find((i) => i.proposal !== undefined);
    expect(card?.proposal?.changes).toEqual(["production: production → staging"]);
    const mine = (await h.cmd("decisions.list")).body.decisions.find((d: { id: string }) =>
      d.id.includes(card?.id ?? "?"),
    );
    expect((await h.cmd("decisions.answer", { id: mine.id, option: "approve" })).status).toBe(200);
    expect(JSON.stringify(await envs())).toContain("staging");
  });
});
