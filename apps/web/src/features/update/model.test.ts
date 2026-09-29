import type { UpdateStatus } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { changeSummary, isNewServer, updateNotice, updatePhase, type VersionInfo } from "./model";

const version = (over: Partial<VersionInfo> = {}): VersionInfo => ({
  running: "aaaaaaa",
  updateReady: false,
  changes: [],
  ...over,
});

describe("updateNotice", () => {
  it("shows nothing until newer code is on disk", () => {
    expect(updateNotice(undefined)).toEqual({ kind: "none" });
    expect(updateNotice(version())).toEqual({ kind: "none" });
  });

  it("lists the changes and says whether the button can work", () => {
    expect(
      updateNotice(version({ updateReady: true, changes: ["feat: a", "fix: b"], canUpdate: true })),
    ).toEqual({
      kind: "ready",
      changes: ["feat: a", "fix: b"],
      dirty: false,
      canUpdate: true,
      working: 0,
      waiting: false,
    });
    expect(updateNotice(version({ updateReady: true, working: 2, waiting: true }))).toMatchObject({
      working: 2,
      waiting: true,
    });
    expect(updateNotice(version({ updateReady: true, dirty: true }))).toMatchObject({
      dirty: true,
      canUpdate: false,
    });
  });

  it("summarizes the change list", () => {
    expect(changeSummary([])).toBe("New code is on disk");
    expect(changeSummary(["a"])).toBe("1 change");
    expect(changeSummary(["a", "b"])).toBe("2 changes");
  });
});

describe("updatePhase", () => {
  const started = "2026-09-30T10:00:00.000Z";
  const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
    state: "running",
    commit: "bbbbbbb1234",
    startedAt: started,
    lines: ["Building"],
    ...over,
  });

  it("builds while the old server still answers", () => {
    expect(
      updatePhase({ status: status(), serverUp: true, healthCommit: "aaaaaaa", startedAt: started }),
    ).toEqual({
      kind: "building",
      lines: ["Building"],
    });
  });

  it("waits through the restart when the server stops answering", () => {
    expect(
      updatePhase({ status: undefined, serverUp: false, healthCommit: undefined, startedAt: started }),
    ).toEqual({
      kind: "restarting",
      lines: [],
    });
  });

  it("is back once /health reports the new commit", () => {
    expect(
      updatePhase({
        status: status({ state: "done" }),
        serverUp: true,
        healthCommit: "bbbbbbb",
        startedAt: started,
      }),
    ).toEqual({ kind: "back" });
  });

  it("shows a failure with its reason, and ignores an older update's file", () => {
    expect(
      updatePhase({
        status: status({ state: "failed", error: "build failed" }),
        serverUp: true,
        healthCommit: "aaaaaaa",
        startedAt: started,
      }),
    ).toMatchObject({ kind: "failed", error: "build failed" });
    expect(
      updatePhase({
        status: status({ state: "failed", startedAt: "2026-09-29T00:00:00.000Z" }),
        serverUp: true,
        healthCommit: "aaaaaaa",
        startedAt: started,
      }).kind,
    ).toBe("building");
  });

  it("matches commits by prefix", () => {
    expect(isNewServer("bbbbbbb", "bbbbbbb1234")).toBe(true);
    expect(isNewServer("aaaaaaa", "bbbbbbb1234")).toBe(false);
    expect(isNewServer(undefined, "bbbbbbb")).toBe(false);
  });
});
