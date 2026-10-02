import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

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
const AGENT_CALL =
  'call: majhi_agents_create {"id":"acme-reviewer","frontmatter":{"scope":"acme","role":"Reviewer","account":"claude-acme"},"instructions":"Review.\\n","ownerAsked":false,"reason":"a reviewer for Acme"}';

describe("the captain through the fake adapter", () => {
  it("creates an org and an agent after the owner approves, and tells the captain", async () => {
    w = await bossWorld();
    expect((await say(ORG_CALL)).status).toBe(200);
    await idle();

    // The tool call reached majhi with the session's token, and came back waiting.
    let items = await w.items();
    const tool = items.find((i) => i.type === "tool");
    expect(tool).toMatchObject({ title: "majhi_orgs_create", status: "completed" });
    expect(tool?.type === "tool" && tool.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Waiting for the owner"),
    });
    expect(await orgIds()).toEqual(["acme"]);
    const [card] = await cards();
    expect(card).toMatchObject({ state: "pending", summary: "Create org Acme Two", agent: "boss" });

    const approved = await w.h.cmd("room.approve", { task: w.chat.id, item: card?.id, decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.body.item).toMatchObject({ state: "applied" });
    await idle();
    expect(await orgIds()).toEqual(["acme", "acme2"]);
    expect(w.h.majhi.services.store.permissions.audit(w.chat.id)).toMatchObject([
      { kind: "orgs.create", agent: "boss", decision: "allow", by: "owner", title: "Create org Acme Two" },
    ]);

    // The room says it in words; the captain got the decision with the result in its session and answered it.
    items = await w.items();
    expect(items.filter((i) => i.type === "system").map((i) => i.type === "system" && i.text)).toContain(
      "You approved: create org Acme Two",
    );
    expect(items.some((i) => i.type === "owner" && i.text.includes("Result:"))).toBe(false);
    expect(items.filter((i) => i.type === "agent").at(-1)).toMatchObject({
      text: expect.stringContaining('echo: The owner approved: Create org Acme Two. Result: {"id":"acme2"'),
    });

    // The agent, the same way.
    await say(AGENT_CALL);
    await idle();
    const pending = (await cards()).find((c) => c.command === "agents.create");
    expect(pending?.state).toBe("pending");
    await w.h.cmd("room.approve", { task: w.chat.id, item: pending?.id, decision: "approve" });
    await idle();
    const agents = await w.h.cmd("agents.list");
    expect(
      agents.body.map((a: { agent: { frontmatter: { id: string } } }) => a.agent.frontmatter.id),
    ).toContain("acme-reviewer");
    const log = await w.h.log("%an|%s");
    expect(log.slice(0, 2)).toEqual([
      "boss|agents.create: a reviewer for Acme",
      "boss|orgs.create: the owner wants a second company",
    ]);
  });

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
