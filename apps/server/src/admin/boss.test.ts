import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const say = (text: string) => w.h.cmd("room.send", { task: w.chat.id, text });
const idle = () => w.h.majhi.services.runs.idle(w.chat.id);
const cards = async () =>
  (await w.items()).filter((i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval");
const orgIds = async () => (await w.h.cmd("orgs.list")).body.map((o: { id: string }) => o.id);
const ORG_CALL =
  'call: majhi_orgs_create {"id":"acme2","name":"Acme Two","ownerAsked":false,"reason":"the owner wants a second company"}';
const AGENT_CALL =
  'call: majhi_agents_create {"id":"acme-reviewer","frontmatter":{"scope":"acme","role":"Reviewer","account":"claude-acme"},"instructions":"Review.\\n","ownerAsked":false,"reason":"a reviewer for Acme"}';

describe("the boss through the fake adapter", () => {
  it("creates an org and an agent after the owner approves, and tells the boss", async () => {
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

    // The boss got the decision as a message in its session and answered it.
    items = await w.items();
    const followUp = items.find((i) => i.type === "owner" && i.text.startsWith("The owner approved:"));
    expect(followUp).toMatchObject({
      text: expect.stringContaining("The owner approved: Create org Acme Two. Result:"),
    });
    expect(items.filter((i) => i.type === "agent").at(-1)).toMatchObject({
      text: expect.stringContaining("echo: The owner approved"),
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

  it("tells the boss when the owner rejects, and changes nothing", async () => {
    w = await bossWorld();
    await say(ORG_CALL);
    await idle();
    const [card] = await cards();
    const rejected = await w.h.cmd("room.approve", { task: w.chat.id, item: card?.id, decision: "reject" });
    expect(rejected.body.item).toMatchObject({ state: "rejected" });
    await idle();
    expect(await orgIds()).toEqual(["acme"]);
    const items = await w.items();
    expect(
      items.some((i) => i.type === "owner" && i.text === "The owner rejected: Create org Acme Two."),
    ).toBe(true);
    // Deciding twice is refused.
    const again = await w.h.cmd("room.approve", { task: w.chat.id, item: card?.id, decision: "approve" });
    expect(again.status).toBe(409);
  });

  it("runs a call at once when the owner asked, and undoes it from the card", async () => {
    w = await bossWorld();
    await say(ORG_CALL.replace('"ownerAsked":false', '"ownerAsked":true'));
    await idle();
    expect(await orgIds()).toEqual(["acme", "acme2"]);
    const [card] = await cards();
    expect(card).toMatchObject({ state: "applied" });
    expect(card?.commit).toMatch(/^[0-9a-f]{40}$/);

    const undo = await w.h.cmd("history.undo", { commit: card?.commit });
    expect(undo.status).toBe(200);
    expect(await orgIds()).toEqual(["acme"]);
    expect((await cards())[0]).toMatchObject({ state: "undone" });
    const history = await w.h.cmd("history.list", { limit: 2 });
    expect(history.body.map((e: { command: string; undone: boolean }) => [e.command, e.undone])).toEqual([
      ["history.undo", false],
      ["orgs.create", true],
    ]);
    // A second undo of the same change is refused.
    expect((await w.h.cmd("history.undo", { commit: card?.commit })).status).toBe(409);
  });

  it("puts the preamble before the boss's first prompt only", async () => {
    w = await bossWorld();
    await say("hello there");
    await idle();
    await say("and again");
    await idle();
    const dir = join(w.chat.folder, ".fake-sessions");
    const [file] = await readdir(dir);
    const stored = JSON.parse(await readFile(join(dir, file ?? ""), "utf8")) as {
      messages: { role: string; text: string }[];
    };
    const prompts = stored.messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(prompts[0]).toContain("You are the boss of majhi");
    expect(prompts[0]).toContain("majhi_request_secret");
    expect(prompts[0]).toContain("hello there");
    expect(prompts[1]).toBe("and again");
    // No brief item: the chat starts with the owner's own words.
    expect((await w.items()).find((i) => i.type === "owner")).toMatchObject({ text: "hello there" });
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

  it("reuses the boss chat, and starts a new one when the boss changes", async () => {
    w = await bossWorld();
    expect((await w.h.cmd("boss.chat")).body.id).toBe(w.chat.id);
    expect(w.chat).toMatchObject({ kind: "chat", team: ["boss"], title: "Boss chat" });
    expect(w.chat.id.startsWith("LOCAL-")).toBe(true);
    await w.h.cmd("agents.create", {
      id: "boss-two",
      frontmatter: { scope: "root", role: "Lead", account: "claude-acme" },
      instructions: "x\n",
    });
    await w.h.cmd("boss.set", { id: "boss-two" });
    const next = await w.h.cmd("boss.chat");
    expect(next.body.id).not.toBe(w.chat.id);
    expect(next.body.team).toEqual(["boss-two"]);
  });
});
