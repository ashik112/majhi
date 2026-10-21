import type { CodexHookPayload } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { HookBinding } from "../rooms/access.ts";
import { CodexHookGate } from "./codex-hook.ts";
import { flow } from "./permission-flow.fixture.ts";
import type { AgentRun } from "./run.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const caller: HookBinding = { kind: "run", caller: { task: "ACM-8", agent: "acme-codex" } };

/** The gate over the real permission flow, for runs that hold Acme's connections. */
function gateOf(level = "routine") {
  const t = flow({ acme: level });
  const prod = { id: "acme-prod", type: "kubectl" as const, context: "acme-prod", allow: [] as string[] };
  const obs = {
    id: "acme-obs",
    type: "mcp" as const,
    server: "acme-obs",
    readTools: ["execute-query"],
    writeTools: ["reset-alerts"],
    allow: [] as string[],
  };
  const run = (gate: object[]): AgentRun =>
    t.runOf("ACM-8", {
      agent: "acme-codex",
      session: {},
      tools: ["majhi-room", "acme-obs"],
      connections: {
        gate,
        uses: gate.map((g) => ({ id: (g as { id: string }).id, name: "Acme" })),
        secrets: [],
      },
    });
  const open = (r: AgentRun) =>
    new CodexHookGate({ run: () => r, ask: (run2, ask, signal) => t.permissions.ask(run2, ask, signal) });
  const bash = (command: string): CodexHookPayload => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: "/Users/owner/tasks/ACM-8",
    tool_use_id: "call-1",
  });
  const mcp = (name: string): CodexHookPayload => ({
    hook_event_name: "PreToolUse",
    tool_name: name,
    tool_input: { alert: "a1" },
    cwd: "/Users/owner/tasks/ACM-8",
  });
  return { t, prod, obs, run, open, bash, mcp };
}

describe("a Codex tool call through the hook", () => {
  it.each([
    ["a shell write to a held cluster", "bash", "kubectl rollout restart deployment/api"],
    ["an MCP write, in Codex's spelling of the server and tool", "mcp", "mcp__acme_obs__reset_alerts"],
  ])("asks the owner for %s, and is denied when the owner refuses", async (_name, kind, call) => {
    const g = gateOf();
    const run = g.run([g.prod, g.obs]);
    const gate = g.open(run);
    const asking = gate.decide(caller, kind === "bash" ? g.bash(call) : g.mcp(call));
    await tick();
    expect(run.pending.size).toBe(1);
    expect(g.t.items.get("perm:4:1")).toMatchObject({ state: "pending", risk: "client-server-write" });
    g.t.permissions.answer(run, "ACM-8", "perm:4:1", "deny");
    expect(await asking).toEqual({ decision: "deny", reason: "The owner denied this in majhi." });
  });

  it("asks for a destructive command even when the connection allows it and the level is Full", async () => {
    const g = gateOf("full");
    const line = "kubectl delete pod api-7d9";
    const run = g.run([{ ...g.prod, allow: [line] }]);
    const gate = g.open(run);
    void gate.decide(caller, g.bash(line));
    await tick();
    expect(run.pending.size).toBe(1);
    expect(g.t.items.get("perm:4:1")).toMatchObject({ state: "pending", connection: { destructive: true } });
  });
});
