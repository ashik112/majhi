import { AGENT_BLOCKED_COMMANDS } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { toolName } from "../admin/tools.ts";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { CONN, envelope } from "./testing/world.ts";

/**
 * Test 5: a client room of one workspace is never visible to another workspace's agents. Globex has a client chat
 * with a message in it; Acme's captain lane reads every way it can.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function must(cmd: Promise<{ status: number; body: unknown }>): Promise<unknown> {
  const res = await cmd;
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body;
}

describe("a client room of another workspace", () => {
  it("is not read, listed, found or described to a captain lane of this workspace", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    await must(h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" }));
    await must(h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } }));
    const services = h.majhi.services;
    const parts = services.chatParts;
    const conn = { ...CONN, org: "globex" };
    await parts.ingest.deliver(
      conn,
      envelope({ chatId: "-900", message: "1", chat: { title: "Acme ops", kind: "group" } }),
    );
    const found = parts.rooms.find("telegram", conn.account, "-900");
    if (found === undefined) throw new Error("no room");
    await parts.rooms.link(found.id, "globex");
    await parts.ingest.deliver(
      conn,
      envelope({ chatId: "-900", message: "2", text: "Quarterly pricing sheet is wrong" }),
    );
    expect(parts.rooms.list().clients.map((r) => r.org)).toEqual(["globex"]);

    const lane = (await services.lanes.ensure("acme")).id;
    const call = (command: string, input: Record<string, unknown>) =>
      services.admin.call({ task: lane, agent: "boss" }, toolName(command), { reason: "reading", ...input });

    for (const [command, input] of [
      ["tasks.get", { id: found.id }],
      ["room.items", { task: found.id }],
      ["room.around", { task: found.id, item: "x" }],
    ] as const) {
      const res = await call(command, input);
      expect(res.isError, command).toBe(true);
      expect(res.text, command).toMatch(/^Refused: /);
      expect(res.text).not.toContain("pricing");
    }
    for (const [command, input] of [
      ["tasks.list", {}],
      ["room.search", { query: "pricing" }],
      ["findings.list", {}],
    ] as const) {
      const res = await call(command, input);
      expect(res.text, command).not.toMatch(/pricing|Acme|Quarterly/);
      expect(res.text, command).not.toContain(found.id);
    }
    // What clients wrote and who they are are never an agent's tools.
    for (const command of [
      "chat.list",
      "chat.send",
      "chat.link",
      "contacts.list",
      "contacts.merge",
    ] as const) {
      expect(AGENT_BLOCKED_COMMANDS.has(command), command).toBe(true);
    }
    const blocked = await call("chat.list", {}).catch((err: unknown) => ({
      isError: true,
      text: String(err),
    }));
    expect(blocked.isError).toBe(true);
    // Its proposal for another workspace is refused too.
    const proposal = await call("chat.proposeRules", { org: "globex", tell: "decide", why: "try" });
    expect(proposal.isError).toBe(true);
    expect(proposal.text).toMatch(/Refused|own workspace/);
  });

  it("is not changed by the captain's own proposal about Tell: a card waits, and only the owner's click applies it", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const services = h.majhi.services;
    const lane = (await services.lanes.ensure("acme")).id;
    const call = (command: string, input: Record<string, unknown>) =>
      services.admin.call({ task: lane, agent: "boss" }, toolName(command), { reason: "reading", ...input });
    const res = await call("chat.proposeRules", {
      org: "acme",
      tell: "decide",
      why: "Replies are always fine.",
    });
    expect(res.isError).toBe(false);
    const cards = (await w.items(lane)).filter((i) => i.type === "approval");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: "approval", command: "autonomy.configure", state: "pending" });
    const settings = await must(h.cmd("settings.get"));
    expect(JSON.stringify(settings)).not.toContain('"tell":"decide"');
    // The captain cannot apply it itself.
    const direct = await call("autonomy.configure", { orgs: { acme: { authority: { tell: "decide" } } } });
    expect(direct.isError).toBe(true);
    const approved = await h.cmd("room.approve", {
      task: lane,
      item: cards[0]?.id ?? "",
      decision: "approve",
    });
    expect(approved.status).toBe(200);
    expect(JSON.stringify(await must(h.cmd("settings.get")))).toContain('"tell":"decide"');
  });
});
