import type { SessionEvent } from "@majhi/acp";
import { describe, expect, it } from "vitest";
import { ItemMapper } from "./items.ts";

type ToolEvent = Extract<SessionEvent, { type: "tool" }>;

function tool(id: string, title: string, text?: string): ToolEvent {
  return {
    type: "tool",
    toolCallId: id,
    title,
    status: "completed",
    ...(text === undefined ? {} : { content: [{ type: "terminal" as const, output: text }] }),
  };
}

describe("a long run's tool calls", () => {
  it("keeps every finished call's output in the room, and never overwrites it with nothing", () => {
    const posted = new Map<string, unknown>();
    const mapper = new ItemMapper("acme-lead", 1, {
      post: (id, payload) => {
        posted.set(id, payload);
      },
    });
    mapper.beginTurn();
    for (let i = 0; i < 100; i++) mapper.apply(tool(`call-${i}`, `Run call-${i}`, `output ${i}`));

    // A late update with no output for a call that finished 99 calls ago is not posted at all.
    mapper.apply(tool("call-0", "Run call-0 again"));
    expect(posted.get("tool:acme-lead:1:call-0")).toMatchObject({
      title: "Run call-0",
      content: [{ type: "terminal", output: "output 0" }],
    });

    // The same update for a call that just finished still merges with the output it has.
    mapper.apply(tool("call-99", "Run call-99 again"));
    expect(posted.get("tool:acme-lead:1:call-99")).toMatchObject({
      title: "Run call-99 again",
      content: [{ type: "terminal", output: "output 99" }],
    });

    // A late update that brings output replaces it, whatever the age of the call.
    mapper.apply(tool("call-0", "Run call-0", "late output"));
    expect(posted.get("tool:acme-lead:1:call-0")).toMatchObject({
      content: [{ type: "terminal", output: "late output" }],
    });
  });
});
