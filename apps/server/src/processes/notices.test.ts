import type { ProcessInfo } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { splitCurrent, supersededBy } from "./notices.ts";

const run = (id: string, name: string, command: string, startedAt: string): ProcessInfo => ({
  id,
  task: "ACM-1",
  agent: "acme-builder",
  name,
  command,
  cwd: "/Users/owner/Work/.majhi/ACM-1",
  wait: true,
  status: "exited",
  exitCode: 0,
  startedAt,
  endedAt: startedAt,
  tail: [],
});

describe("which process results are current", () => {
  const old = run("p4", "tests", "pnpm test", "2026-10-01T10:00:00.000Z");

  it("a newer run of the same name or command replaces an older one", () => {
    expect(
      supersededBy(old, [old, run("p9", "tests", "pnpm test --run", "2026-10-01T10:05:00.000Z")])?.id,
    ).toBe("p9");
    expect(supersededBy(old, [old, run("p9", "check", "pnpm test", "2026-10-01T10:05:00.000Z")])?.id).toBe(
      "p9",
    );
    // A restart keeps the id and starts later.
    expect(supersededBy(old, [run("p4", "tests", "pnpm test", "2026-10-01T10:05:00.000Z")])?.id).toBe("p4");
  });

  it("an older or unrelated run does not", () => {
    expect(
      supersededBy(old, [old, run("p2", "tests", "pnpm test", "2026-10-01T09:00:00.000Z")]),
    ).toBeUndefined();
    expect(
      supersededBy(old, [old, run("p9", "lint", "pnpm lint", "2026-10-01T10:05:00.000Z")]),
    ).toBeUndefined();
  });

  it("of ends waiting together, only the newest of each command is current", () => {
    const newer = run("p6", "tests", "pnpm test", "2026-10-01T10:02:00.000Z");
    const lint = run("p5", "lint", "pnpm lint", "2026-10-01T10:01:00.000Z");
    const { current, replaced } = splitCurrent([old, lint, newer], []);
    expect(current.map((p) => p.id)).toEqual(["p5", "p6"]);
    expect(replaced.map((p) => p.id)).toEqual(["p4"]);
  });
});
