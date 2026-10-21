import type { CodexHookPayload } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { readOnlyDecider } from "../memory/read-only.ts";
import { CodexHookGate } from "../runs/codex-hook.ts";
import { FILES_SERVER_NAME, RoomAccess, type ToolCaller } from "./access.ts";
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
    decide: async (binding) => {
      if (binding.kind === "run") asked.push(binding.caller);
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

describe("the Codex hook endpoint for a session that has no run", () => {
  it("denies a shell and a patch to a read-only Housekeeper session with the reason, and allows its files tools", async () => {
    const access = new RoomAccess(
      () => "http://majhi-server:7070/mcp",
      () => true,
    );
    // The gate has no run to ask: a session's token is answered by the session's own rule.
    const gate = new CodexHookGate({
      run: () => undefined,
      ask: () => Promise.reject(new Error("a session without a run never asks the owner")),
    });
    const codexHook: NonNullable<RoomMcpDeps["codexHook"]> = {
      decide: (binding, body, signal) => gate.decide(binding, body, signal),
    };
    const app = roomMcpRoutes({ access, codexHook } as unknown as RoomMcpDeps);
    const root = "/Users/owner/tasks/.wiki/acme-api";
    const wiki = access.attachSession({
      decide: readOnlyDecider(root, [], FILES_SERVER_NAME),
      files: { root, also: [] },
      hook: true,
    });
    const token = wiki.env.MAJHI_HOOK_TOKEN ?? "";
    const verdict = async (tool_name: string, tool_input: unknown) =>
      (
        await app.request("/mcp/codex-hook", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...payload, cwd: root, tool_name, tool_input }),
        })
      ).json();

    const noShell = "No shell in this session. Read with the files tools: read, list, search.";
    expect(await verdict("Bash", { command: "sed -n 1,40p src/app.ts" })).toEqual({
      decision: "deny",
      reason: noShell,
    });
    expect(await verdict("Bash", { command: "cat /proc/self/environ" })).toEqual({
      decision: "deny",
      reason: noShell,
    });
    expect(
      await verdict("apply_patch", { command: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" }),
    ).toEqual({
      decision: "deny",
      reason: "A read-only session may not use edit tools. Read with the files tools: read, list, search.",
    });
    // Codex's own tools and another server's are not the session's files tools.
    expect(
      (await verdict("view_image", { path: "/Users/owner/.codex/auth.json" })) as { decision: string },
    ).toMatchObject({ decision: "deny" });
    expect((await verdict("mcp__majhi_room__post", {})) as { decision: string }).toMatchObject({
      decision: "deny",
    });

    // Codex spells `majhi-files` as `majhi_files`.
    for (const tool of ["read", "list", "search"]) {
      expect(await verdict(`mcp__majhi_files__${tool}`, { path: "src" })).toEqual({ decision: "allow" });
    }
  });
});
