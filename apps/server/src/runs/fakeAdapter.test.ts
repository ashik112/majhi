import { startSession } from "@majhi/acp";
import { fakeAdapter } from "@majhi/acp/testing";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { baseEnv } from "../env.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

/** A world whose sessions run the real ACP engine against the fake adapter. */
async function realWorld(slowMs = 0): Promise<World> {
  w = await taskWorld();
  w.h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true, slowMs }) };
  w.h.runtime.startSession = (start) => startSession(start);
  return w;
}

async function items(): Promise<RoomItem[]> {
  const page = await w.h.cmd("room.items", { task: "ACM-1", limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}

const live = () => w.h.majhi.services.room.getLive("ACM-1", "acme-builder");

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

describe("the run manager with the fake ACP adapter", () => {
  it("starts the agent without the SSH agent socket, even when the server has one", async () => {
    const before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/run/ssh-agent.sock";
    try {
      await realWorld();
      w.h.env.runtime.base = baseEnv({ ...process.env, SSH_AUTH_SOCK: "/run/ssh-agent.sock" });
      await w.h.cmd("tasks.create", { text: "fix api", start: true });
      await w.h.majhi.services.runs.idle();
      await w.h.cmd("room.send", { task: "ACM-1", text: "report-env" });
      await w.h.majhi.services.runs.idle();
      const said = (await items()).flatMap((i) => (i.type === "agent" ? [i.text] : [])).join("");
      expect(said).toContain("SSH_AUTH_SOCK=unset.");
      expect(said).not.toContain("/run/ssh-agent.sock");
    } finally {
      if (before === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = before;
    }
  });

  it("asks the owner when the agent has no shell permission", async () => {
    w = await taskWorld({ agent: { perms: ["edit"] } });
    w.h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true }) };
    w.h.runtime.startSession = (start) => startSession(start);
    await w.h.cmd("tasks.create", { text: "fix api", start: true });
    await until(() => live()?.status === "waiting", "the permission prompt");
    const pending = (await items()).find((i) => i.type === "permission") as Extract<
      RoomItem,
      { type: "permission" }
    >;
    expect(pending).toMatchObject({ state: "pending", title: "Run npm test" });
    expect(pending.options.map((o) => o.id)).toEqual(["allow", "allow_always", "reject"]);
    const answered = await w.h.cmd("room.permission", { task: "ACM-1", item: pending.id, option: "reject" });
    expect(answered.body.item).toMatchObject({ state: "answered", chosen: "reject" });
    await w.h.majhi.services.runs.idle();
    const tools = (await items()).filter((i) => i.type === "tool") as Extract<RoomItem, { type: "tool" }>[];
    expect(tools.find((t) => t.toolCallId === "t-exec")?.status).toBe("failed");
  });
});
