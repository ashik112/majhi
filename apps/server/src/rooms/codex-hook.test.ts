import type { CodexHookPayload } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { RoomAccess, type ToolCaller } from "./access.ts";
import { type RoomMcpDeps, roomMcpRoutes } from "./mcp.ts";

const payload: CodexHookPayload = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "pnpm test" },
  cwd: "/Users/owner/tasks/ACM-1",
};

function setup() {
  const access = new RoomAccess(
    () => "http://majhi-server:7070/mcp",
    () => true,
  );
  const asked: ToolCaller[] = [];
  const codexHook: NonNullable<RoomMcpDeps["codexHook"]> = {
    decide: async (caller) => {
      asked.push(caller);
      return { decision: "allow" };
    },
  };
  const app = roomMcpRoutes({ access, codexHook } as unknown as RoomMcpDeps);
  const post = (token: string | undefined, body: unknown = payload) =>
    app.request("/mcp/codex-hook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  return { access, asked, post };
}

describe("the Codex hook endpoint", () => {
  it("answers only a session's own token: not none, a wrong one, another server's, or one of a session that ended", async () => {
    const { access, asked, post } = setup();
    const acme = access.attachCodexHook({ task: "ACM-1", agent: "dev" });
    const globex = access.attachCodexHook({ task: "GLX-1", agent: "dev" });
    const docker = access.attachDocker({ task: "ACM-1", agent: "dev" });
    expect((await post(undefined)).status).toBe(401);
    expect((await post("not-a-token")).status).toBe(401);
    expect((await post(docker?.entry.token)).status).toBe(401);
    expect(asked).toEqual([]);

    // Each token asks for its own task and agent, whatever the payload says.
    expect(await (await post(acme.entry.token, { ...payload, session_id: "GLX-1" })).json()).toEqual({
      decision: "allow",
    });
    await post(globex.entry.token);
    expect(asked).toEqual([
      { task: "ACM-1", agent: "dev" },
      { task: "GLX-1", agent: "dev" },
    ]);

    access.revoke([acme.entry]);
    expect((await post(acme.entry.token)).status).toBe(401);
    expect(asked).toHaveLength(2);
  });
});
