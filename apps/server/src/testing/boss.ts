import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { startSession } from "@majhi/acp";
import { fakeAdapter } from "@majhi/acp/testing";
import type { RoomItem, Task } from "@majhi/shared";
import { until } from "./until.ts";
import { taskWorld, type World, type WorldOptions } from "./world.ts";

export interface BossWorld extends World {
  /** The captain chat task. */
  chat: Task;
  /** The MCP URL agents reach, on a real port. */
  mcpUrl: string;
  items(task?: string): Promise<RoomItem[]>;
  /** Waits until `check` is true, or fails. */
  until(check: () => boolean | Promise<boolean>, what: string): Promise<void>;
}

/**
 * A world with a root agent that is the captain, its chat task, a real listening server (so agent
 * processes can reach `/mcp`), and sessions that run the fake ACP adapter.
 */
export async function bossWorld(
  options: {
    real?: boolean;
    runClock?: () => Date;
    opsProbes?: WorldOptions["opsProbes"];
    ntfyFetch?: WorldOptions["ntfyFetch"];
  } = {},
): Promise<BossWorld> {
  const w = await taskWorld({
    ...(options.runClock === undefined ? {} : { runClock: options.runClock }),
    ...(options.opsProbes === undefined ? {} : { opsProbes: options.opsProbes }),
    ...(options.ntfyFetch === undefined ? {} : { ntfyFetch: options.ntfyFetch }),
  });
  const { h } = w;
  if (options.real !== false) {
    h.env.runtime.adapters = { claude: fakeAdapter("claude", { signedIn: true }) };
    h.runtime.startSession = (start) => startSession(start);
  }
  const made = await h.cmd("agents.create", {
    id: "boss",
    frontmatter: {
      scope: "root",
      role: "Lead",
      account: "claude-acme",
      model: "sonnet",
      effort: "high",
      perms: ["edit", "shell"],
    },
    instructions: "You are the captain.\n",
  });
  if (made.status !== 200) throw new Error(`boss create failed: ${JSON.stringify(made.body)}`);
  const set = await h.cmd("boss.set", { id: "boss" });
  if (set.status !== 200) throw new Error(`boss.set failed: ${JSON.stringify(set.body)}`);

  // Plain HTTP/1 server, so the type is node's.
  const server = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${port}/mcp`;

  const chat = await h.cmd("boss.chat");
  if (chat.status !== 200) throw new Error(`boss.chat failed: ${JSON.stringify(chat.body)}`);
  const inner = w.cleanup;
  const world: BossWorld = {
    ...w,
    chat: chat.body as Task,
    mcpUrl: h.majhi.services.adminTokens.mcpUrl,
    async items(task = (chat.body as Task).id) {
      const page = await h.cmd("room.items", { task, limit: 500 });
      return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
    },
    until,
    cleanup: async () => {
      server.closeAllConnections?.();
      server.close();
      await inner();
    },
  };
  return world;
}
