import { ContextSettingsSchema, type RoomItem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  budgetFor,
  compactCommand,
  estimateTokens,
  IMAGE_TOKENS,
  isContextError,
  needsCompaction,
  reachedTarget,
  rotationDue,
} from "./context.ts";
import {
  durableNote,
  freshPrompt,
  HANDOFF_HEADINGS,
  HANDOFF_REQUEST,
  looksLikeNote,
  roomLines,
} from "./handoff.ts";

const defaults = ContextSettingsSchema.parse({});

describe("the context budget", () => {
  it("merges compact_at as majhi default, then org, then agent", () => {
    expect(budgetFor(defaults, undefined, undefined)).toEqual({
      compactAt: 0.8,
      compactTarget: 0.4,
      maxTurns: 40,
    });
    expect(budgetFor(defaults, { compact_at: 0.7 }, undefined).compactAt).toBe(0.7);
    expect(budgetFor(defaults, { compact_at: 0.7 }, { compact_at: 0.6 }).compactAt).toBe(0.6);
    expect(budgetFor(defaults, {}, {}).compactAt).toBe(0.8);
    expect(budgetFor({ ...defaults, compact_at: 0.9, max_turns: 0 }, undefined, undefined)).toMatchObject({
      compactAt: 0.9,
      maxTurns: 0,
    });
  });

  it("keeps the target under a low org or agent threshold", () => {
    expect(budgetFor(defaults, undefined, { compact_at: 0.3 }).compactTarget).toBe(0.15);
    expect(budgetFor(defaults, { compact_at: 0.5 }, undefined).compactTarget).toBe(0.4);
  });

  it("compacts at the threshold, counting the prompt about to be sent", () => {
    const b = budgetFor(defaults, undefined, undefined);
    expect(needsCompaction(undefined, b)).toBe(false);
    expect(needsCompaction({ used: 159_999, size: 200_000 }, b)).toBe(false);
    expect(needsCompaction({ used: 160_000, size: 200_000 }, b)).toBe(true);
    expect(needsCompaction({ used: 150_000, size: 200_000 }, b, 10_000)).toBe(true);
    expect(needsCompaction({ used: 150_000, size: 200_000 }, b, 9_999)).toBe(false);
    expect(needsCompaction({ used: 10, size: 0 }, b)).toBe(false);
  });

  it("checks native compaction against the target", () => {
    const b = budgetFor(defaults, undefined, undefined);
    expect(reachedTarget({ used: 20_000, size: 200_000 }, b)).toBe(true);
    expect(reachedTarget({ used: 80_000, size: 200_000 }, b)).toBe(false);
    expect(reachedTarget(undefined, b)).toBe(false);
  });

  it("rotates after max_turns, and never with 0", () => {
    expect(rotationDue(39, budgetFor(defaults, undefined, undefined))).toBe(false);
    expect(rotationDue(40, budgetFor(defaults, undefined, undefined))).toBe(true);
    expect(rotationDue(400, budgetFor({ ...defaults, max_turns: 0 }, undefined, undefined))).toBe(false);
  });

  it("estimates prompts at four characters a token and a fixed cost per image", () => {
    expect(estimateTokens([{ type: "text", text: "x".repeat(400) }])).toBe(100);
    expect(estimateTokens([{ type: "image", mime: "image/png", data: "abc" }])).toBe(IMAGE_TOKENS);
  });

  it("finds the native compact command and context errors", () => {
    expect(compactCommand([{ name: "review" }, { name: "compact" }])).toBe("/compact");
    expect(compactCommand([{ name: "review" }])).toBeUndefined();
    expect(isContextError("prompt is too long: 210000 tokens > 200000 maximum")).toBe(true);
    expect(isContextError("context_length_exceeded")).toBe(true);
    expect(isContextError("Permission denied")).toBe(false);
  });
});

let seq = 0;
const item = (over: Partial<RoomItem> & Pick<RoomItem, "type">): RoomItem =>
  ({ id: `i${++seq}`, task: "ACM-1", seq, at: "2026-01-01T00:00:00Z", ...over }) as RoomItem;

describe("handoff notes", () => {
  it("asks for the fixed template and recognizes a reply that follows it", () => {
    for (const h of HANDOFF_HEADINGS) expect(HANDOFF_REQUEST).toContain(`## ${h}`);
    const note = HANDOFF_HEADINGS.map((h) => `## ${h}\n\nsomething`).join("\n\n");
    expect(looksLikeNote(note)).toBe(true);
    expect(looksLikeNote("Sure, here is what I did.")).toBe(false);
  });

  it("builds a note from durable state: TASK.md, the checkpoint, the room newest first within a budget, the diff", () => {
    const room = [
      item({ type: "owner", text: "first ask", attachments: [], queued: false }),
      item({ type: "agent", agent: "b", text: "x".repeat(5000) }),
      item({ type: "system", level: "info", text: "noise" }),
      item({ type: "agent", agent: "b", text: "latest reply" }),
    ];
    const note = durableNote({
      task: "ACM-1",
      agent: "b",
      taskMd: "# ACM-1\n\nFix the api",
      checkpoint: 3,
      room,
      diff: " src/a.ts | 2 +-",
      why: "the session was full",
    });
    for (const h of HANDOFF_HEADINGS) expect(note).toContain(`## ${h}`);
    expect(note).toContain("Fix the api");
    expect(note).toContain("checkpoint 3");
    expect(note).toContain("src/a.ts");
    expect(note).not.toContain("noise");
    expect(note.indexOf("latest reply")).toBeLessThan(note.indexOf("first ask"));
    expect(note).toContain("[... trimmed ...]");
    expect(looksLikeNote(note)).toBe(true);
  });

  it("stops adding room lines at the budget", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      item({ type: "agent", agent: "b", text: `line ${i} ${"y".repeat(200)}` }),
    );
    const lines = roomLines(many, 1000);
    expect(lines.join("\n").length).toBeLessThanOrEqual(1000);
    expect(lines[0]).toContain("line 49");
  });

  it("opens a fresh session with prefix, TASK.md, note, room, diff stat, then the pending prompt verbatim", () => {
    const text = freshPrompt({
      taskMd: "TASKMD",
      note: "NOTE",
      room: ["Owner: hi"],
      diffStat: "STAT",
      pending: "please add tests",
    });
    const order = ["majhi replaced", "TASKMD", "NOTE", "Owner: hi", "STAT", "please add tests"].map((s) =>
      text.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(freshPrompt({ taskMd: "", note: "", room: [], diffStat: "" })).toContain(
      "Continue from where you left off.",
    );
  });
});
