import type { Settings } from "@majhi/shared";
import { SettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  type ApprovalItem,
  approvalOutcome,
  canUndo,
  formFromSettings,
  historyRow,
  looksLikeSecret,
  patchFromForm,
} from "./model";

const defaults: Settings = SettingsSchema.parse({ context: {}, limits: {}, resume: {}, policy: {} });

function card(over: Partial<ApprovalItem>): ApprovalItem {
  return {
    id: "a",
    task: "LOCAL-1",
    seq: 1,
    at: "2026-09-30T00:00:00.000Z",
    type: "approval",
    agent: "boss",
    command: "orgs.create",
    risk: "change",
    summary: "Create org Acme",
    input: "{}",
    state: "pending",
    ...over,
  };
}

describe("approval cards", () => {
  it("names the outcome of a settled card and none for a pending one", () => {
    expect(approvalOutcome(card({}))).toBeUndefined();
    expect(approvalOutcome(card({ state: "applied" }))).toBe("Applied");
    expect(approvalOutcome(card({ state: "rejected" }))).toBe("Rejected");
    expect(approvalOutcome(card({ state: "failed" }))).toBe("Failed");
    expect(approvalOutcome(card({ state: "undone" }))).toBe("Undone");
  });

  it("offers Undo only for an applied change with a commit", () => {
    expect(canUndo(card({ state: "applied", commit: "abc1234" }))).toBe(true);
    expect(canUndo(card({ state: "applied" }))).toBe(false);
    expect(canUndo(card({ state: "undone", commit: "abc1234" }))).toBe(false);
    expect(canUndo(card({ commit: "abc1234" }))).toBe(false);
  });
});

describe("looksLikeSecret", () => {
  it("flags keys and leaves plain talk alone", () => {
    expect(looksLikeSecret(`use sk-ant-api03-${"aB3xY9".repeat(8)} here`)).toBe(true);
    expect(looksLikeSecret("create an org called Acme for the api repo")).toBe(false);
    expect(looksLikeSecret("commit 9fceb02d0ae598e95dc970b74767f19372d61af8")).toBe(false);
  });
});

describe("historyRow", () => {
  const now = Date.parse("2026-09-30T01:00:00.000Z");
  const entry = {
    commit: "a".repeat(40),
    at: "2026-09-30T00:55:00.000Z",
    actor: "boss",
    command: "orgs.create",
    summary: "added org acme",
    reason: "you asked",
    undone: false,
  };
  it("says who, what and when", () => {
    expect(historyRow(entry, now)).toMatchObject({
      who: "@boss",
      what: "added org acme",
      when: "5 min ago",
      canUndo: true,
    });
    expect(historyRow({ ...entry, actor: "owner" }, now).who).toBe("You");
    expect(historyRow({ ...entry, actor: "manual" }, now).who).toBe("Edited by hand");
  });
  it("does not offer Undo for undone changes or for undo commits", () => {
    expect(historyRow({ ...entry, undone: true }, now).canUndo).toBe(false);
    expect(historyRow({ ...entry, command: "history.undo" }, now).canUndo).toBe(false);
  });
});

describe("settings form", () => {
  it("shows percentages as whole numbers", () => {
    expect(formFromSettings(defaults)).toMatchObject({
      compactAt: "80",
      compactTarget: "40",
      maxTurns: "40",
      agentsMax: "6",
      idleTimeout: "10m",
      resumeAuto: true,
    });
  });

  it("sends only what changed, with fractions for percentages", () => {
    const form = { ...formFromSettings(defaults), compactAt: "70", agentsMax: "3", resumeAuto: false };
    expect(patchFromForm(defaults, form)).toEqual({
      patch: { context: { compact_at: 0.7 }, limits: { agents_max: 3 }, resume: { auto: false } },
      errors: {},
    });
    expect(patchFromForm(defaults, formFromSettings(defaults)).patch).toEqual({});
  });

  it("reports each problem and sends nothing wrong", () => {
    const form = {
      ...formFromSettings(defaults),
      compactAt: "30",
      agentsMax: "0",
      perTask: "many",
      idleTimeout: "soon",
    };
    const { patch, errors } = patchFromForm(defaults, form);
    expect(errors).toMatchObject({
      compactTarget: "The target must be lower than the compact level",
      agentsMax: "Agents at once must be between 1 and 64",
      perTask: "Per task must be a whole number",
      idleTimeout: "Use a number and s, m or h, like 10m",
    });
    expect(patch.limits).toBeUndefined();
  });
});
