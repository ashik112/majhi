import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { MessageRuns, normalizeUpdate } from "./normalize.ts";
import type { SessionEvent } from "./session.ts";

type Update = SessionNotification["update"];

function run(updates: Update[]): SessionEvent[] {
  const runs = new MessageRuns("p");
  const logs: string[] = [];
  return updates.flatMap((u) => normalizeUpdate(u, runs, (m) => logs.push(m)));
}

const chunk = (
  kind: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
  messageId?: string,
): Update => ({
  sessionUpdate: kind,
  content: { type: "text", text },
  ...(messageId ? { messageId } : {}),
});

describe("message ids", () => {
  it("shares an id across a contiguous run and starts a new one after another event", () => {
    const events = run([
      chunk("agent_message_chunk", "a"),
      chunk("agent_message_chunk", "b"),
      { sessionUpdate: "usage_update", used: 1, size: 2 },
      chunk("agent_message_chunk", "c"),
      chunk("agent_thought_chunk", "t"),
      chunk("agent_message_chunk", "d"),
    ]);
    expect(events).toEqual([
      { type: "text", messageId: "p-1", text: "a" },
      { type: "text", messageId: "p-1", text: "b" },
      { type: "usage", used: 1, size: 2 },
      { type: "text", messageId: "p-2", text: "c" },
      { type: "thought", messageId: "p-3", text: "t" },
      { type: "text", messageId: "p-4", text: "d" },
    ]);
  });

  it("uses the id the agent sends", () => {
    expect(run([chunk("agent_message_chunk", "a", "srv-9")])).toEqual([
      { type: "text", messageId: "srv-9", text: "a" },
    ]);
  });
});

describe("tools", () => {
  it("maps a create and a patch", () => {
    const events = run([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Edit a.ts",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/w/a.ts" }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "diff", path: "/w/a.ts", oldText: "x", newText: "y" },
          { type: "diff", path: "/w/b.ts", newText: "z" },
          { type: "content", content: { type: "text", text: "ok" } },
          { type: "content", content: { type: "image", data: "AA", mimeType: "image/png" } },
        ],
      },
    ]);
    expect(events).toEqual([
      {
        type: "tool",
        toolCallId: "t1",
        title: "Edit a.ts",
        kind: "edit",
        status: "pending",
        locations: ["/w/a.ts"],
      },
      {
        type: "tool",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "diff", path: "/w/a.ts", oldText: "x", newText: "y" },
          { type: "diff", path: "/w/b.ts", newText: "z" },
          { type: "text", text: "ok" },
        ],
      },
      // The image is kept, as its own message beside the tool row.
      { type: "media", messageId: "tool-t1", block: { kind: "image", mime: "image/png", data: "AA" } },
    ]);
  });

  it("reads terminal output from meta", () => {
    const events = run([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        content: [{ type: "terminal", terminalId: "x" }],
        _meta: { terminal_output: { terminal_id: "x", data: "hi\n" }, terminal_exit: { exit_code: 0 } },
      },
    ]);
    expect(events).toEqual([
      { type: "tool", toolCallId: "t2", content: [{ type: "terminal", output: "hi\n", exitCode: 0 }] },
    ]);
  });
});

describe("other updates", () => {
  it("maps plan, plan_update, usage, commands and notices", () => {
    const events = run([
      { sessionUpdate: "plan", entries: [{ content: "one", priority: "high", status: "in_progress" }] },
      {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "p",
          entries: [{ content: "one", priority: "low", status: "completed" }],
        },
      },
      { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p", markdown: "# x" } as never },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "" },
          { name: "review", description: "Review" },
        ],
      },
      { sessionUpdate: "notice", severity: "warning", title: "Slow", description: "network" },
      { sessionUpdate: "notice", severity: "error", title: "Boom" },
    ]);
    expect(events).toEqual([
      { type: "plan", entries: [{ content: "one", status: "in_progress" }] },
      { type: "plan", entries: [{ content: "one", status: "completed" }] },
      {
        type: "commands",
        commands: [{ name: "compact" }, { name: "review", description: "Review" }],
      },
      { type: "notice", level: "warn", text: "Slow: network" },
      { type: "notice", level: "error", text: "Boom" },
    ]);
  });

  it("ignores unknown updates and non-text chunks without throwing", () => {
    const logs: string[] = [];
    const runs = new MessageRuns("p");
    const out = [
      { sessionUpdate: "brand_new_thing" } as never,
      { sessionUpdate: "current_mode_update", currentModeId: "x" } as never,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "", mimeType: "image/png" },
      } as never,
      { sessionUpdate: "tool_call" } as never,
    ].flatMap((u: Update) => normalizeUpdate(u, runs, (m) => logs.push(m)));
    expect(out).toEqual([]);
    expect(logs).toHaveLength(4);
  });
});

describe("media", () => {
  it("keeps an image and a link from a message, in the same message as its text", () => {
    const events = run([
      chunk("agent_message_chunk", "Here it is. "),
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "aGk=", mimeType: "image/png" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "resource_link",
          uri: "https://example.com/docs",
          name: "Docs",
          mimeType: "text/html",
        },
      },
    ]);
    expect(events).toEqual([
      { type: "text", messageId: "p-1", text: "Here it is. " },
      { type: "media", messageId: "p-1", block: { kind: "image", mime: "image/png", data: "aGk=" } },
      {
        type: "media",
        messageId: "p-1",
        block: { kind: "link", uri: "https://example.com/docs", name: "Docs", mime: "text/html" },
      },
    ]);
  });

  it("keeps an image with only a uri as a link, and never keeps images from thoughts", () => {
    const events = run([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "", mimeType: "image/png", uri: "file:///t/a.png" },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "image", data: "aGk=", mimeType: "image/png" },
      },
    ]);
    expect(events).toEqual([
      {
        type: "media",
        messageId: "p-1",
        block: { kind: "link", uri: "file:///t/a.png", name: "file:///t/a.png" },
      },
    ]);
  });

  it("takes images out of tool content into their own message", () => {
    const events = run([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "ok" } },
          { type: "content", content: { type: "image", data: "aGk=", mimeType: "image/png" } },
        ],
      },
    ]);
    expect(events).toEqual([
      {
        type: "tool",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "text", text: "ok" }],
      },
      { type: "media", messageId: "tool-t1", block: { kind: "image", mime: "image/png", data: "aGk=" } },
    ]);
  });
});
