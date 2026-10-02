import type { RoomItem } from "@majhi/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dockItems } from "./dock.ts";
import { DockCaption, dockCaption, questionLine } from "./dock-caption.tsx";

const base = { task: "ACM-12", seq: 1, at: "2026-10-01T10:00:00.000Z" };
const item = (id: string, rest: Record<string, unknown>) => ({ id, ...base, ...rest }) as RoomItem;
type Question = Extract<RoomItem, { type: "owner-question" }>;
const question = (id: string, rest: Partial<Question> = {}) =>
  item(id, {
    type: "owner-question",
    agent: "acme-lead",
    choices: [],
    state: "pending",
    ...rest,
  }) as Question;

describe("dock captions", () => {
  it("names the agent, the task and the kind for questions, asks and choices", () => {
    const ask = item("a", { type: "ask", agent: "acme-builder", questions: [], state: "pending" });
    const choice = item("c", {
      type: "choice",
      agent: "acme-lead",
      question: "?",
      options: [],
      state: "pending",
    });
    expect(dockCaption(question("q"), undefined)).toEqual({
      who: "@acme-lead",
      task: "ACM-12",
      kind: "Question",
    });
    expect(dockCaption(ask, undefined)).toEqual({ who: "@acme-builder", task: "ACM-12", kind: "Question" });
    expect(dockCaption(choice, undefined)).toEqual({ who: "@acme-lead", task: "ACM-12", kind: "Choice" });
  });

  it("uses the review's lead, the task's lead for a choice with no agent, and majhi for a pause", () => {
    const review = item("r", { type: "review", state: "pending", lead: "acme-lead" });
    const choice = item("c", { type: "choice", question: "?", options: [], state: "pending" });
    const paused = item("p", { type: "paused", reason: "owner", state: "pending" });
    expect(dockCaption(review, undefined).who).toBe("@acme-lead");
    expect(dockCaption(choice, "acme-lead").who).toBe("@acme-lead");
    expect(dockCaption(choice, undefined).who).toBe("majhi");
    expect(dockCaption(paused, "acme-lead")).toEqual({ who: "majhi", task: "ACM-12", kind: "Paused" });
  });

  it("renders who, task and kind in the row", () => {
    const html = renderToStaticMarkup(<DockCaption parts={dockCaption(question("q"), undefined)} />);
    expect(html).toContain("@acme-lead");
    expect(html).toContain("ACM-12");
    expect(html).toContain("Question");
  });
});

describe("question rows", () => {
  it("gives the agent's words, trimmed", () => {
    expect(questionLine(question("q", { text: "  Keep the retry limit at 3?  " }))).toEqual({
      who: "@acme-lead",
      text: "Keep the retry limit at 3?",
    });
  });

  it("has no text for an empty body, so the row shows its fallback and is never blank", () => {
    expect(questionLine(question("q")).text).toBeUndefined();
    expect(questionLine(question("q", { text: "   " })).text).toBeUndefined();
  });
});

describe("what the dock holds", () => {
  it("keeps a question with an empty body while the task runs", () => {
    const rows = dockItems([question("q")], "running");
    expect(rows.map((r) => r.id)).toEqual(["q"]);
  });

  it("drops a no-choice question once the task is in review (Ask for changes covers it) or done", () => {
    expect(dockItems([question("q")], "review")).toEqual([]);
    expect(dockItems([question("q", { choices: ["Yes"] })], "done")).toEqual([]);
  });

  it("shows asks, choices and questions together, and not what was answered", () => {
    const ask = item("a", { type: "ask", agent: "acme-lead", questions: [], state: "pending" });
    const choice = item("c", { type: "choice", question: "?", options: [], state: "pending" });
    const done = question("d", { state: "answered", chosen: "Yes" });
    const ids = dockItems([question("q", { text: "Go?" }), ask, choice, done], "running").map((r) => r.id);
    expect(ids).toEqual(["q", "a", "c"]);
  });
});
