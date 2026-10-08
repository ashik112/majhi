import type { CommandMeta, WatchDef } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../commands/handlers.ts";
import { opsHandlers } from "./handlers.ts";

// Only the name and what it does on firing matter to the rule.
const def = (fire: Record<string, unknown> = {}): WatchDef =>
  ({
    name: "crm droplet up",
    fire: { alert: { on: true, phone: false }, fix: { mode: "off" }, ...fire },
  }) as never;
const saved: string[] = [];
const engine = {
  save: async (input: { def: WatchDef }) => {
    saved.push(input.def.name);
    return { id: "wch-1" };
  },
  show: async () => ({ def: def({ fix: { mode: "auto", allowed: [] } }) }),
};
const handlers = opsHandlers({
  engine,
  watch: {},
  phone: {},
  playbooks: {},
  lanes: { boss: async () => "majhi-captain", orgOf: () => undefined },
  store: { tasks: { get: () => undefined } },
} as never);
const as = (kind: "agent" | "owner"): CommandContext =>
  ({
    command: "watch.save",
    meta: (kind === "agent"
      ? { actor: { kind: "agent", id: "majhi-captain" } }
      : { actor: { kind: "owner" } }) as CommandMeta,
  }) as never;

describe("watches an agent may change", () => {
  it("saves an alert-only watch from an agent, refuses one that acts, and leaves the owner free", async () => {
    await handlers["watch.save"]({ org: "acme", def: def() }, as("agent"));
    expect(saved).toEqual(["crm droplet up"]);
    await expect(
      handlers["watch.save"]({ org: "acme", def: def({ fix: { mode: "auto", allowed: [] } }) }, as("agent")),
    ).rejects.toThrow();
    await expect(
      handlers["watch.save"]({ org: "acme", def: def({ alert: { on: true, phone: true } }) }, as("agent")),
    ).rejects.toThrow();
    await expect(handlers["watch.pause"]({ id: "wch-2", paused: true }, as("agent"))).rejects.toThrow();
    await handlers["watch.save"](
      { org: "acme", def: def({ fix: { mode: "auto", allowed: [] } }) },
      as("owner"),
    );
    expect(saved).toHaveLength(2);
  });
});
