import { describe, expect, it } from "vitest";
import { growthHandlers } from "./handlers.ts";

const finding = (id: number) => ({
  id,
  org: id === 1 ? "acme" : "globex",
  source: "grant",
  title: "Acme grant round",
  detail: "",
  evidence: ["deadline:2026-11-30"],
});
const added: { org: string; due: string }[] = [];
const handlers = growthHandlers({
  lanes: { orgOf: (task: string) => (task === "lane-acme" ? "acme" : undefined), boss: async () => "boss" },
  growth: {
    findings: { get: finding },
    deadlines: {
      list: () => ({ deadlines: [] }),
      upsert: (d: { org: string; due: string }) => {
        added.push({ org: d.org, due: d.due });
        return d;
      },
    },
  },
} as never);
const captainInLane = {
  command: "findings.deadline",
  meta: { actor: { kind: "agent", id: "boss" }, task: "lane-acme" },
} as never;

describe("a finding's deadline from the captain", () => {
  it("is added for its own workspace once approved, and refused for another workspace", async () => {
    await handlers["findings.deadline"]({ id: 1 }, captainInLane);
    expect(added).toEqual([{ org: "acme", due: "2026-11-30" }]);
    await expect(handlers["findings.deadline"]({ id: 2 }, captainInLane)).rejects.toThrow(
      "You work on your own workspace's findings only.",
    );
    expect(added).toHaveLength(1);
  });
});
