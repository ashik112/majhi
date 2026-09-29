import type { AgentLive, RoomItem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  applyCompletion,
  collapseContext,
  composerKey,
  detectTrigger,
  diffLines,
  diffStats,
  emptyRoom,
  filesByRepo,
  filterCommands,
  isBusy,
  mergeItems,
  nearBottom,
  oldestSeq,
  parseRoomMessage,
  permissionOptionLabel,
  permissionSummary,
  pinnedPlans,
  roomReducer,
  shortPath,
  splitRows,
  toolTarget,
  touchedFiles,
  trimOutput,
} from "./model";

const base = { task: "LOCAL-1" };

function agentMsg(id: string, seq: number, at: string, text = id): RoomItem {
  return { ...base, id, seq, at, type: "agent", agent: "builder", text };
}

function tool(
  id: string,
  seq: number,
  extra: Partial<Extract<RoomItem, { type: "tool" }>> = {},
): Extract<RoomItem, { type: "tool" }> {
  return {
    ...base,
    id,
    seq,
    at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    type: "tool",
    agent: "builder",
    toolCallId: id,
    title: "Edit",
    kind: "edit",
    status: "completed",
    locations: [],
    content: [],
    ...extra,
  };
}

function plan(
  id: string,
  seq: number,
  statuses: ("pending" | "in_progress" | "completed")[],
  agent = "builder",
): RoomItem {
  return {
    ...base,
    id,
    seq,
    at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    type: "plan",
    agent,
    entries: statuses.map((status, i) => ({ content: `step ${i}`, status })),
  };
}

describe("mergeItems", () => {
  it("adds new items in time order", () => {
    const a = agentMsg("a", 1, "2026-01-01T00:00:01Z");
    const c = agentMsg("c", 3, "2026-01-01T00:00:03Z");
    const b = agentMsg("b", 2, "2026-01-01T00:00:02Z");
    expect(mergeItems([a, c], [b]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("replaces an item with the same id and a newer seq, keeping its place", () => {
    const a = agentMsg("a", 1, "2026-01-01T00:00:01Z", "he");
    const b = agentMsg("b", 2, "2026-01-01T00:00:02Z");
    const a2 = agentMsg("a", 5, "2026-01-01T00:00:01Z", "hello");
    const merged = mergeItems([a, b], [a2]);
    expect(merged.map((i) => i.id)).toEqual(["a", "b"]);
    expect(merged[0]).toMatchObject({ text: "hello", seq: 5 });
  });

  it("drops a stale update", () => {
    const a = agentMsg("a", 5, "2026-01-01T00:00:01Z", "hello");
    const stale = agentMsg("a", 2, "2026-01-01T00:00:01Z", "he");
    expect(mergeItems([a], [stale])[0]).toMatchObject({ text: "hello" });
  });

  it("does not mutate its input", () => {
    const list = [agentMsg("a", 1, "2026-01-01T00:00:01Z")];
    mergeItems(list, [agentMsg("b", 2, "2026-01-01T00:00:02Z")]);
    expect(list).toHaveLength(1);
  });
});

describe("oldestSeq", () => {
  it("is the lowest seq held", () => {
    expect(oldestSeq([agentMsg("a", 7, "x"), agentMsg("b", 3, "y")])).toBe(3);
    expect(oldestSeq([])).toBeUndefined();
  });
});

describe("roomReducer", () => {
  const live: AgentLive = { agent: "builder", status: "working", queued: 0, commands: [] };

  it("takes a snapshot, then upserts items and agents", () => {
    let state = roomReducer(emptyRoom, {
      type: "message",
      message: {
        type: "snapshot",
        items: [agentMsg("a", 1, "2026-01-01T00:00:01Z")],
        agents: [live],
        more: true,
      },
    });
    expect(state).toMatchObject({ loaded: true, more: true });
    state = roomReducer(state, {
      type: "message",
      message: { type: "item", item: agentMsg("a", 2, "2026-01-01T00:00:01Z", "more") },
    });
    state = roomReducer(state, {
      type: "message",
      message: { type: "agent", agent: { ...live, status: "idle" } },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: "more" });
    expect(state.agents).toEqual([{ ...live, status: "idle" }]);
  });

  it("keeps older pages when a reconnect sends a fresh snapshot", () => {
    const older = agentMsg("old", 1, "2026-01-01T00:00:01Z");
    const newer = agentMsg("new", 9, "2026-01-01T00:00:09Z");
    let state = roomReducer(emptyRoom, {
      type: "message",
      message: { type: "snapshot", items: [newer], agents: [], more: true },
    });
    state = roomReducer(state, { type: "older", items: [older], more: false });
    state = roomReducer(state, {
      type: "message",
      message: { type: "snapshot", items: [newer], agents: [], more: true },
    });
    expect(state.items.map((i) => i.id)).toEqual(["old", "new"]);
    expect(state.more).toBe(false);
  });
});

describe("parseRoomMessage", () => {
  it("accepts known messages and drops the rest", () => {
    expect(parseRoomMessage('{"type":"snapshot","items":[],"agents":[],"more":false}')).toMatchObject({
      type: "snapshot",
    });
    expect(parseRoomMessage('{"type":"item","item":{"id":"x"}}')).toBeNull();
    expect(parseRoomMessage("nope")).toBeNull();
    expect(parseRoomMessage(new ArrayBuffer(1))).toBeNull();
  });
});

describe("pinnedPlans", () => {
  it("pins the latest plan of an agent while it has open entries", () => {
    const items = [plan("p1", 1, ["completed", "pending"]), plan("p2", 5, ["completed", "in_progress"])];
    expect(pinnedPlans(items).map((p) => p.id)).toEqual(["p2"]);
  });

  it("stops pinning once every entry is done", () => {
    expect(
      pinnedPlans([plan("p1", 1, ["completed", "pending"]), plan("p1", 4, ["completed", "completed"])]),
    ).toEqual([]);
  });

  it("pins one plan per agent", () => {
    const items = [plan("a", 1, ["pending"], "one"), plan("b", 2, ["pending"], "two")];
    expect(pinnedPlans(items)).toHaveLength(2);
  });
});

describe("isBusy", () => {
  it("counts working, starting and waiting", () => {
    const of = (status: AgentLive["status"]): AgentLive => ({ agent: "a", status, queued: 0, commands: [] });
    expect(isBusy([of("working")])).toBe(true);
    expect(isBusy([of("waiting")])).toBe(true);
    expect(isBusy([of("idle"), of("stopped")])).toBe(false);
  });
});

describe("tools", () => {
  it("names the target from locations, else from a diff", () => {
    expect(toolTarget(tool("t", 1, { locations: ["/w/api/a.ts"] }))).toBe("/w/api/a.ts");
    expect(toolTarget(tool("t", 1, { content: [{ type: "diff", path: "b.ts", newText: "x" }] }))).toBe(
      "b.ts",
    );
    expect(toolTarget(tool("t", 1))).toBeUndefined();
  });

  it("trims long output from the end", () => {
    const text = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const trimmed = trimOutput(text, 10);
    expect(trimmed.hidden).toBe(40);
    expect(trimmed.text.split("\n")).toHaveLength(10);
    expect(trimOutput("a\nb\n", 10)).toEqual({ text: "a\nb", hidden: 0 });
  });
});

describe("permissionSummary", () => {
  const options = [
    { id: "yes", name: "Allow once", kind: "allow_once" as const },
    { id: "always", name: "Allow for this task", kind: "allow_always" as const },
    { id: "no", name: "Deny", kind: "reject_once" as const },
  ];
  const item = (
    state: "pending" | "answered" | "auto" | "cancelled",
    chosen?: string,
  ): Extract<RoomItem, { type: "permission" }> => ({
    ...base,
    id: "p",
    seq: 1,
    at: "x",
    type: "permission",
    agent: "b",
    title: "npm test",
    options,
    state,
    ...(chosen ? { chosen } : {}),
  });

  it("stays a prompt while pending", () => {
    expect(permissionSummary(item("pending"))).toEqual({ pending: true });
  });
  it("collapses answered and auto prompts to one line", () => {
    expect(permissionSummary(item("auto", "yes"))).toEqual({
      pending: false,
      text: "Allowed: npm test, by rule",
    });
    expect(permissionSummary(item("answered", "no"))).toEqual({ pending: false, text: "Denied: npm test" });
    expect(permissionSummary(item("answered", "always"))).toEqual({
      pending: false,
      text: "Allowed for this task: npm test",
    });
    expect(permissionSummary(item("cancelled"))).toEqual({ pending: false, text: "Cancelled: npm test" });
  });
});

describe("touchedFiles", () => {
  it("collects completed edits, deletes and moves once per path", () => {
    const items = [
      tool("1", 1, {
        content: [{ type: "diff", path: "/w/api/a.ts", oldText: "a", newText: "b" }],
        locations: ["/w/api/a.ts"],
      }),
      tool("2", 2, { content: [{ type: "diff", path: "/w/api/a.ts", oldText: "b", newText: "c" }] }),
      tool("3", 3, { kind: "delete", locations: ["/w/api/old.ts"] }),
      tool("4", 4, { kind: "move", locations: ["/w/api/x.ts", "/w/api/y.ts"] }),
      tool("5", 5, { status: "failed", locations: ["/w/api/nope.ts"] }),
      tool("6", 6, { kind: "read", locations: ["/w/api/read.ts"] }),
      tool("7", 7, { status: "in_progress", locations: ["/w/api/later.ts"] }),
    ];
    const files = touchedFiles(items);
    expect(files.map((f) => [f.path, f.change, f.diffs.length])).toEqual([
      ["/w/api/a.ts", "edit", 2],
      ["/w/api/old.ts", "delete", 0],
      ["/w/api/x.ts", "move", 0],
      ["/w/api/y.ts", "move", 0],
    ]);
  });

  it("counts a diff on a tool of another kind", () => {
    const files = touchedFiles([
      tool("1", 1, { kind: "other", content: [{ type: "diff", path: "z.ts", newText: "n" }] }),
    ]);
    expect(files.map((f) => f.path)).toEqual(["z.ts"]);
  });

  it("splits files by worktree and leaves outsiders without a repo", () => {
    const repos = [{ worktree: "/t/api" }, { worktree: "/t/web" }];
    const groups = filesByRepo(
      [
        { path: "/t/api/src/a.ts", change: "edit", diffs: [] },
        { path: "/t/web/b.ts", change: "edit", diffs: [] },
        { path: "/etc/hosts", change: "edit", diffs: [] },
      ],
      repos,
    );
    expect(groups.map((g) => [g.repo?.worktree, g.files.map((f) => f.shown)])).toEqual([
      ["/t/api", ["src/a.ts"]],
      ["/t/web", ["b.ts"]],
      [undefined, ["/etc/hosts"]],
    ]);
  });

  it("sends relative paths to the only repo", () => {
    const groups = filesByRepo([{ path: "src/a.ts", change: "edit", diffs: [] }], [{ worktree: "/t/api" }]);
    expect(groups[0]?.files[0]?.shown).toBe("src/a.ts");
  });
});

describe("diffLines", () => {
  it("marks changed lines and numbers both sides", () => {
    const lines = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(lines).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "ctx", text: "c", oldNo: 3, newNo: 3 },
      { kind: "add", text: "d", newNo: 4 },
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it("treats a missing old text as a new file", () => {
    expect(diffLines(undefined, "x\ny")).toEqual([
      { kind: "add", text: "x", newNo: 1 },
      { kind: "add", text: "y", newNo: 2 },
    ]);
  });

  it("finds moved-out lines in the middle", () => {
    const lines = diffLines("1\n2\n3\n4\n5", "1\n3\n5");
    expect(lines.flatMap((l) => (l.kind === "del" ? [l.text] : []))).toEqual(["2", "4"]);
    expect(lines.filter((l) => l.kind === "add")).toEqual([]);
  });

  it("collapses unchanged runs to a gap", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const next = old.replace("l10", "changed");
    const out = collapseContext(diffLines(old, next), 2);
    expect(out.some((l) => l.kind === "gap")).toBe(true);
    expect(out.filter((l) => l.kind === "ctx")).toHaveLength(4);
  });

  it("pairs removed and added lines side by side", () => {
    const rows = splitRows(diffLines("a\nb\nc", "a\nB\nB2\nc"));
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ left: { text: "b" }, right: { text: "B" } });
    expect(rows[2]).toMatchObject({ right: { text: "B2" } });
    expect(rows[2] && "left" in rows[2] ? rows[2].left : undefined).toBeUndefined();
  });
});

describe("composerKey", () => {
  const key = (
    k: string,
    mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }> = {},
  ) => ({
    key: k,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    ...mods,
  });
  const idle = { popupOpen: false, busy: false, hasContent: true };

  it("sends on Enter, queues by sending while busy", () => {
    expect(composerKey(key("Enter"), idle)).toBe("send");
    expect(composerKey(key("Enter"), { ...idle, busy: true })).toBe("send");
  });
  it("interrupts on Cmd or Ctrl+Enter while busy, and just sends when idle", () => {
    expect(composerKey(key("Enter", { metaKey: true }), { ...idle, busy: true })).toBe("interrupt");
    expect(composerKey(key("Enter", { ctrlKey: true }), { ...idle, busy: true })).toBe("interrupt");
    expect(composerKey(key("Enter", { metaKey: true }), idle)).toBe("send");
  });
  it("adds a line on Shift+Enter", () => {
    expect(composerKey(key("Enter", { shiftKey: true }), idle)).toBe("newline");
  });
  it("does nothing on Enter without content or while composing", () => {
    expect(composerKey(key("Enter"), { ...idle, hasContent: false })).toBe("none");
    expect(composerKey(key("Enter", { isComposing: true }), idle)).toBe("none");
  });
  it("leaves Enter to an open popup", () => {
    expect(composerKey(key("Enter"), { ...idle, popupOpen: true })).toBe("none");
  });
  it("closes a popup on Esc, else cancels the turn", () => {
    expect(composerKey(key("Escape"), { ...idle, popupOpen: true })).toBe("close-popup");
    expect(composerKey(key("Escape"), idle)).toBe("cancel");
  });
});

describe("detectTrigger", () => {
  it("finds a slash command at the start", () => {
    expect(detectTrigger("/re", 3)).toEqual({ kind: "slash", query: "re", start: 0, end: 3 });
    expect(detectTrigger("/", 1)).toEqual({ kind: "slash", query: "", start: 0, end: 1 });
  });
  it("ignores a slash later in the text or inside a path", () => {
    expect(detectTrigger("look at /re", 11)).toBeNull();
    expect(detectTrigger("src/app", 7)).toBeNull();
  });
  it("finds an @ mention at the start of a word", () => {
    expect(detectTrigger("fix @src/ap", 11)).toEqual({ kind: "mention", query: "src/ap", start: 4, end: 11 });
    expect(detectTrigger("@a", 2)).toEqual({ kind: "mention", query: "a", start: 0, end: 2 });
  });
  it("ignores an @ inside a word and text after a space", () => {
    expect(detectTrigger("me@example", 10)).toBeNull();
    expect(detectTrigger("fix @a b", 8)).toBeNull();
  });
  it("uses the caret, not the end of the text", () => {
    expect(detectTrigger("@ab tail", 3)).toEqual({ kind: "mention", query: "ab", start: 0, end: 3 });
  });
});

describe("applyCompletion", () => {
  it("replaces the trigger and moves the caret past the insert", () => {
    const trigger = detectTrigger("fix @src/ap now", 11);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    expect(applyCompletion("fix @src/ap now", trigger, "src/app.ts")).toEqual({
      text: "fix @src/app.ts now",
      caret: 16,
    });
  });
  it("completes a slash command", () => {
    const trigger = detectTrigger("/re", 3);
    if (!trigger) throw new Error("no trigger");
    expect(applyCompletion("/re", trigger, "review")).toEqual({ text: "/review ", caret: 8 });
  });
});

describe("filterCommands", () => {
  it("lists prefix matches first", () => {
    const list = [{ name: "compact" }, { name: "review" }, { name: "init" }, { name: "rewind" }];
    expect(filterCommands(list, "re").map((c) => c.name)).toEqual(["review", "rewind"]);
    expect(filterCommands(list, "in").map((c) => c.name)).toEqual(["init", "rewind"]);
  });
});

describe("nearBottom", () => {
  it("is true within the slack", () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true);
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false);
  });
});

describe("permissionOptionLabel", () => {
  it("names what majhi does, not what the adapter calls it", () => {
    expect(permissionOptionLabel({ id: "a", name: "Always Allow", kind: "allow_always" })).toBe(
      "Allow for this task",
    );
    expect(permissionOptionLabel({ id: "r", name: "Reject", kind: "reject_once" })).toBe("Deny");
    expect(permissionOptionLabel({ id: "o", name: "Allow", kind: "allow_once" })).toBe("Allow");
  });
});

describe("shortPath", () => {
  it("shows paths inside the task folder relative to it, and others as they are", () => {
    expect(shortPath("/t/ACM-1/api/HEALTH.md", "/t/ACM-1")).toBe("api/HEALTH.md");
    expect(shortPath("/t/ACM-1/api/HEALTH.md", "/t/ACM-1/")).toBe("api/HEALTH.md");
    expect(shortPath("/t/ACM-10/x.md", "/t/ACM-1")).toBe("/t/ACM-10/x.md");
    expect(shortPath("relative.md", "/t/ACM-1")).toBe("relative.md");
  });
});
