import type { OwnerDecision } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { deriveBanner, homeRowIds } from "./model.ts";

function decision(id: string, task: string, org?: string): OwnerDecision {
  return {
    id,
    kind: "ship",
    ...(org === undefined ? {} : { org }),
    task,
    title: `@lead finished ${task}`,
    options: [],
    at: "2026-10-05T10:00:00Z",
    link: { kind: "task", id: task },
  };
}

const signIn: OwnerDecision = {
  id: "signin:claude-acme",
  kind: "sign-in",
  org: "acme",
  title: "Sign in claude-acme",
  options: [],
  at: "2026-10-05T10:00:00Z",
  link: { kind: "account", id: "claude-acme" },
};

describe("the banner never repeats a row on the page", () => {
  const all = [
    decision("room:ACM-1:ship", "ACM-1", "acme"),
    decision("room:GLX-1:ship", "GLX-1", "globex"),
    signIn,
  ];

  it("says the first decision off Home, with the rest counted", () => {
    const banner = deriveBanner({ decisions: all, permission: undefined });
    expect(banner?.key).toBe("signin:claude-acme");
    expect(banner?.more).toBe(2);
  });

  it("says nothing on Home when every decision is a row", () => {
    const rows = homeRowIds(all, undefined);
    expect(deriveBanner({ decisions: all, permission: undefined, onScreen: rows })).toBeNull();
  });

  it("says only what the workspace filter hides on Home", () => {
    const rows = homeRowIds(all, "globex");
    const banner = deriveBanner({ decisions: all, permission: undefined, onScreen: rows });
    expect(banner?.key).toBe("signin:claude-acme");
    expect(banner?.more).toBe(1);
  });

  it("leaves out the open task's own decisions and keeps the rest", () => {
    const only = [decision("room:ACM-1:ship", "ACM-1", "acme")];
    expect(deriveBanner({ decisions: only, permission: undefined, openTask: "ACM-1" })).toBeNull();
    const banner = deriveBanner({ decisions: all, permission: undefined, openTask: "ACM-1" });
    expect(banner?.key).toBe("signin:claude-acme");
    expect(banner?.more).toBe(1);
  });
});
