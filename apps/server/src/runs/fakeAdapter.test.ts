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

describe("the run manager with the fake ACP adapter", () => {
  it("starts the agent without the SSH agent socket, even when the server has one", async () => {
    const before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/run/ssh-agent.sock";
    try {
      await realWorld();
      w.h.env.runtime.base = baseEnv({ ...process.env, SSH_AUTH_SOCK: "/run/ssh-agent.sock" });
      await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true });
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

});
