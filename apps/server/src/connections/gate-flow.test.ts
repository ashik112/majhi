import type { PermissionAsk } from "@majhi/acp";
import { describe, expect, it } from "vitest";
import { connectionVerdict, mcpToolOf, withoutUnaskedModes } from "../runs/permissions.ts";
import type { GateConnection } from "./gate.ts";

const OPTIONS = [
  { id: "allow", name: "Allow", kind: "allow_once" },
  { id: "always", name: "Allow for this task", kind: "allow_always" },
  { id: "reject", name: "Deny", kind: "reject_once" },
] as const;

function ask(over: Partial<PermissionAsk>): PermissionAsk {
  return { title: "Run", kind: "execute", toolCallId: "t1", options: [...OPTIONS], ...over } as PermissionAsk;
}

describe("connectionVerdict", () => {
  const held: GateConnection[] = [
    { id: "acme-prod", type: "kubectl", context: "acme-prod", allow: [] },
    { id: "acme-newrelic", type: "mcp", server: "acme-newrelic", allow: [] },
  ];

  it("reads a shell command by its line, and an MCP call by its server and tool", () => {
    expect(connectionVerdict(ask({ command: "kubectl get pods" }), held, () => undefined).kind).toBe("read");
    expect(connectionVerdict(ask({ command: "kubectl delete pod x" }), held, () => undefined).kind).toBe(
      "write",
    );
    expect(
      connectionVerdict(
        ask({ kind: "other", title: "mcp__acme-newrelic__list_alerts" }),
        held,
        () => undefined,
      ).kind,
    ).toBe("read");
    // Codex asks about an MCP call without naming it; its tool call's title does.
    const codex = ask({ title: "Permission needed" });
    expect(
      connectionVerdict(codex, held, (id) => (id === "t1" ? "mcp.acme-newrelic.mute_alert" : undefined)).kind,
    ).toBe("write");
    expect(connectionVerdict(ask({ command: "npm test" }), held, () => undefined).kind).toBe("other");
    // A command request that came without its command line is read by its title.
    expect(connectionVerdict(ask({ title: "`kubectl delete pod x`" }), held, () => undefined).kind).toBe(
      "write",
    );
    expect(mcpToolOf("mcp__majhi-room__post")).toEqual({ server: "majhi-room", tool: "post" });
  });

  it("drops the choices that would make the CLI stop asking", () => {
    const options = withoutUnaskedModes([
      { id: "exit-plan-auto", name: "Auto", kind: "allow_always" },
      { id: "exit-plan-clear-bypass", name: "Bypass", kind: "allow_always" },
      { id: "exit-plan-accept-edits", name: "Edits", kind: "allow_always" },
      { id: "exit-plan-default", name: "Ask", kind: "allow_once" },
    ]);
    expect(options.map((o) => o.id)).toEqual(["exit-plan-accept-edits", "exit-plan-default"]);
  });
});
