import type { TaskSummary } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { boardCounts, buildColumns, cardNote, columnOf, directionOf, moveFocus } from "./model";

const task = (over: Partial<TaskSummary> & { id: string }): TaskSummary => ({
  title: "A task",
  kind: "code",
  status: "inbox",
  team: [],
  updatedAt: "2026-09-29T10:00:00Z",
  repos: [],
  working: [],
  ...over,
});

const plain: { org: string | undefined; query: string; showDone: boolean } = {
  org: undefined,
  query: "",
  showDone: false,
};

describe("columns", () => {
  it("maps statuses to the design's five columns", () => {
    expect(
      (["inbox", "ready", "running", "paused", "review", "mr", "done"] as const).map((status) =>
        columnOf({ status }),
      ),
    ).toEqual(["inbox", "ready", "working", "working", "review", "mr", "done"]);
  });
  it("lists the columns in order and hides Done until asked", () => {
    expect(buildColumns([], plain).map((c) => c.label)).toEqual([
      "Inbox",
      "Ready",
      "Working",
      "Your review",
      "MR open",
    ]);
    expect(buildColumns([], { ...plain, showDone: true }).map((c) => c.id)).toEqual([
      "inbox",
      "ready",
      "working",
      "review",
      "mr",
      "done",
    ]);
  });
  it("keeps paused and your-turn tasks under Working, ahead of the ones being worked on", () => {
    const columns = buildColumns(
      [
        task({ id: "ACM-5", status: "running", working: ["a"] }),
        task({ id: "ACM-4", status: "running", working: [] }),
        task({ id: "ACM-3", status: "paused", pausedReason: "limit" }),
      ],
      plain,
    );
    expect(columns[2]?.tasks.map((t) => t.id)).toEqual(["ACM-3", "ACM-4", "ACM-5"]);
  });
  it("orders Working by id so streaming does not shuffle it", () => {
    const a = task({ id: "ACM-9", status: "running", working: ["x"], updatedAt: "2026-09-29T10:00:00Z" });
    const b = task({ id: "ACM-10", status: "running", working: ["x"], updatedAt: "2026-09-29T09:00:00Z" });
    expect(buildColumns([a, b], plain)[2]?.tasks.map((t) => t.id)).toEqual(["ACM-10", "ACM-9"]);
  });
  it("sorts the other columns newest first", () => {
    const old = task({ id: "ACM-1", updatedAt: "2026-09-28T10:00:00Z" });
    const fresh = task({ id: "ACM-2", updatedAt: "2026-09-29T10:00:00Z" });
    expect(buildColumns([old, fresh], plain)[0]?.tasks.map((t) => t.id)).toEqual(["ACM-2", "ACM-1"]);
  });
  it("applies the org filter and the search", () => {
    const tasks = [
      task({ id: "ACM-1", org: "acme", title: "Fix login", repos: [{ project: "api", branch: "b" }] }),
      task({ id: "NW-1", org: "north", title: "Fix charts" }),
      task({ id: "LOCAL-1", title: "Fix notes" }),
    ];
    const ids = (o: Partial<typeof plain>) =>
      buildColumns(tasks, { ...plain, ...o })[0]
        ?.tasks.map((t) => t.id)
        .toSorted();
    expect(ids({ org: "acme" })).toEqual(["ACM-1"]);
    expect(ids({ query: "fix" })).toEqual(["ACM-1", "LOCAL-1", "NW-1"]);
    expect(ids({ query: "api" })).toEqual(["ACM-1"]);
    expect(ids({ query: "nw-1" })).toEqual(["NW-1"]);
  });
  it("counts open and done tasks of the filtered org", () => {
    const tasks = [
      task({ id: "ACM-1", org: "acme" }),
      task({ id: "ACM-2", org: "acme", status: "done" }),
      task({ id: "NW-1", org: "north" }),
    ];
    expect(boardCounts(tasks, undefined)).toEqual({ open: 2, done: 1 });
    expect(boardCounts(tasks, "acme")).toEqual({ open: 1, done: 1 });
  });
});

describe("cardNote", () => {
  it("says why a task is paused", () => {
    expect(cardNote(task({ id: "A-1", status: "paused", pausedReason: "limit" }))).toEqual({
      text: "Paused · usage limit",
      tone: "coral",
    });
    expect(cardNote(task({ id: "A-1", status: "paused" }))?.text).toBe("Paused");
  });
  it("says who is working, or that it is your turn", () => {
    expect(cardNote(task({ id: "A-1", status: "running", working: ["acme-lead"] }))).toEqual({
      text: "@acme-lead working",
      tone: "amber",
    });
    const idle = task({ id: "A-1", status: "running" });
    expect(cardNote(idle)).toEqual({ text: "Your turn", tone: "violet" });
  });
  it("has no note for the quiet columns", () => {
    expect(cardNote(task({ id: "A-1", status: "inbox" }))).toBeNull();
    expect(cardNote(task({ id: "A-1", status: "review" }))).toBeNull();
  });
});

describe("keyboard", () => {
  const columns = [["a1", "a2", "a3"], [], ["c1", "c2"], ["d1"]];
  it("maps j k h l and the arrows", () => {
    expect(
      ["j", "ArrowDown", "k", "ArrowUp", "h", "ArrowLeft", "l", "ArrowRight", "x"].map(directionOf),
    ).toEqual(["down", "down", "up", "up", "left", "left", "right", "right", undefined]);
  });
  it("starts at the first card", () => {
    expect(moveFocus(columns, undefined, "down")).toBe("a1");
    expect(moveFocus([[], []], undefined, "down")).toBeUndefined();
  });
  it("moves within a column and stops at the ends", () => {
    expect(moveFocus(columns, "a1", "down")).toBe("a2");
    expect(moveFocus(columns, "a3", "down")).toBe("a3");
    expect(moveFocus(columns, "a1", "up")).toBe("a1");
  });
  it("jumps over empty columns and keeps the row where it can", () => {
    expect(moveFocus(columns, "a2", "right")).toBe("c2");
    expect(moveFocus(columns, "a3", "right")).toBe("c2");
    expect(moveFocus(columns, "c2", "right")).toBe("d1");
    expect(moveFocus(columns, "c1", "left")).toBe("a1");
  });
  it("stays on the last card when there is no column further on", () => {
    expect(moveFocus(columns, "d1", "right")).toBe("d1");
    expect(moveFocus(columns, "a1", "left")).toBe("a1");
  });
});
