import { CHAT_BRIEF } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { namesTask, reachFromChat } from "./chat-link.ts";

/** Who may act on a task from a chat: a task the chat made, one the owner named, in the chat's workspace, and nothing else. */

interface Row {
  id: string;
  kind: "chat" | "code";
  brief: string;
  org?: string;
  team: string[];
  origin?: { kind: "chat"; room: string };
}

function world(owner: Record<string, string[]> = {}) {
  const rows: Row[] = [
    { id: "LOCAL-1", kind: "chat", brief: CHAT_BRIEF, org: "acme", team: ["acme-dev"] },
    { id: "LOCAL-2", kind: "chat", brief: CHAT_BRIEF, org: "acme", team: ["acme-dev"] },
    {
      id: "ACM-1",
      kind: "code",
      brief: "x",
      org: "acme",
      team: ["acme-dev"],
      origin: { kind: "chat", room: "LOCAL-1" },
    },
    { id: "ACM-2", kind: "code", brief: "x", org: "acme", team: ["acme-dev"] },
    { id: "ACM-10", kind: "code", brief: "x", org: "acme", team: ["acme-dev"] },
    {
      id: "GLX-1",
      kind: "code",
      brief: "x",
      org: "globex",
      team: ["acme-dev"],
      origin: { kind: "chat", room: "LOCAL-1" },
    },
  ];
  const store = {
    tasks: { get: (id: string) => rows.find((r) => r.id === id) },
    room: { ofType: (task: string) => (owner[task] ?? []).map((text) => ({ type: "owner", text })) },
  };
  return store as unknown as Parameters<typeof reachFromChat>[0];
}

const dev = { task: "LOCAL-1", agent: "acme-dev" };

describe("what a chat's agent may reach", () => {
  it("reaches a task its chat made", () => {
    expect(reachFromChat(world(), dev, "ACM-1")).toMatchObject({ ok: true, how: "created" });
  });

  it("reaches a task the owner named in that chat, and no other", () => {
    const store = world({ "LOCAL-1": ["can you check ACM-2 for me?"] });
    expect(reachFromChat(store, dev, "ACM-2")).toMatchObject({ ok: true, how: "named" });
    expect(reachFromChat(store, dev, "ACM-10")).toMatchObject({ ok: false });
    // The name must be a word of its own: ACM-1 is not named by "ACM-10".
    expect(reachFromChat(world({ "LOCAL-1": ["see ACM-10"] }), dev, "ACM-1")).toMatchObject({
      ok: true,
      how: "created",
    });
    expect(namesTask("see ACM-10", "ACM-1")).toBe(false);
    expect(namesTask("(ACM-1).", "ACM-1")).toBe(true);
  });

  it("refuses a task it has no link to", () => {
    expect(reachFromChat(world(), dev, "ACM-2")).toMatchObject({
      ok: false,
      why: expect.stringContaining("not a task this chat made"),
    });
  });

  it("refuses a task in another workspace, even one its chat made", () => {
    expect(reachFromChat(world(), dev, "GLX-1")).toMatchObject({
      ok: false,
      why: expect.stringContaining("another workspace"),
    });
  });

  it("refuses what another chat made, and a name the owner said in another chat", () => {
    const other = { task: "LOCAL-2", agent: "acme-dev" };
    expect(reachFromChat(world({ "LOCAL-1": ["ACM-2"] }), other, "ACM-1")).toMatchObject({ ok: false });
    expect(reachFromChat(world({ "LOCAL-1": ["ACM-2"] }), other, "ACM-2")).toMatchObject({ ok: false });
  });

  it("refuses an agent that is not in the chat, a chat as a target, and a task as the caller", () => {
    expect(reachFromChat(world(), { task: "LOCAL-1", agent: "stranger" }, "ACM-1")).toMatchObject({
      ok: false,
    });
    expect(reachFromChat(world(), dev, "LOCAL-2")).toMatchObject({ ok: false });
    expect(reachFromChat(world(), { task: "ACM-2", agent: "acme-dev" }, "ACM-1")).toMatchObject({
      ok: false,
    });
  });

  it("lets the lead of a promoted chat reach its own task, and nobody else", () => {
    expect(reachFromChat(world(), { task: "ACM-2", agent: "acme-dev" }, "ACM-2")).toMatchObject({
      ok: true,
      how: "self",
    });
    expect(reachFromChat(world(), { task: "ACM-2", agent: "other" }, "ACM-2")).toMatchObject({ ok: false });
  });
});
