import type { AgentEntry } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  avatarTone,
  defaultAgentId,
  eligibleAgents,
  initialOf,
  isYourTurn,
  primaryAction,
  statusInfo,
} from "./model";

describe("status", () => {
  it("labels statuses and names the pause reason", () => {
    expect(statusInfo("running")).toEqual({ label: "Working", tone: "amber" });
    expect(statusInfo("paused", "limit").label).toBe("Paused · usage limit");
  });
  it("picks one primary action", () => {
    expect(primaryAction("inbox")).toBe("start");
    expect(primaryAction("ready")).toBe("start");
    expect(primaryAction("running")).toBe("stop");
    expect(primaryAction("paused")).toBe("resume");
    expect(primaryAction("done")).toBeNull();
    expect(primaryAction("review")).toBeNull();
  });
});

function agent(
  id: string,
  scope: string,
  role: string,
  where: string[] = ["anywhere"],
  isBoss = false,
): AgentEntry {
  return {
    status: "ok",
    file: `/a/${id}.md`,
    warnings: [],
    isBoss,
    agent: {
      instructions: "",
      frontmatter: {
        id,
        scope,
        role,
        account: "acc",
        where,
        perms: [],
        tools: [],
        connections: [],
        skills: [],
        origin: "owner",
      },
    },
  } as AgentEntry;
}

describe("agents", () => {
  const entries = [
    agent("boss", "root", "Root", ["anywhere"], true),
    agent("acme-builder", "acme", "Builder", ["acme"]),
    agent("acme-lead", "acme", "Lead", ["acme"]),
    agent("other-lead", "other", "Lead", ["other"]),
    { status: "invalid", file: "x", id: "broken", errors: ["bad"] } as AgentEntry,
  ];

  it("keeps agents that can work in the org, and skips broken files", () => {
    expect(
      eligibleAgents(entries, "acme").map((e) => (e.status === "ok" ? e.agent.frontmatter.id : "")),
    ).toEqual(["boss", "acme-builder", "acme-lead"]);
  });

  it("prefers a Lead, then a Builder, org-scoped before root", () => {
    expect(defaultAgentId(entries, "acme", "code")).toBe("acme-lead");
    expect(
      defaultAgentId(
        entries.filter((e) => e.status === "ok" && e.agent.frontmatter.id !== "acme-lead"),
        "acme",
        "code",
      ),
    ).toBe("acme-builder");
  });

  it("sends a chat task without an org to the boss", () => {
    expect(defaultAgentId(entries, undefined, "chat")).toBe("boss");
  });

  it("has no default when no agent fits", () => {
    expect(defaultAgentId([], "acme", "code")).toBeUndefined();
  });

  it("gives an id the same avatar every time", () => {
    expect(avatarTone("acme-lead")).toBe(avatarTone("acme-lead"));
    expect(initialOf("acme-lead")).toBe("L");
    expect(initialOf("globex-builder")).toBe("B");
    expect(initialOf("globex-builder-2")).toBe("2");
    expect(initialOf("setup")).toBe("S");
  });
});

describe("your turn", () => {
  it("is a running task whose agents are idle, labelled Your turn", () => {
    expect(isYourTurn({ status: "running", working: [] })).toBe(true);
    expect(isYourTurn({ status: "running", working: ["lead"] })).toBe(false);
    expect(isYourTurn({ status: "paused", working: [] })).toBe(false);
    expect(statusInfo("running", undefined, true)).toEqual({ label: "Your turn", tone: "violet" });
    expect(statusInfo("running", undefined, false).label).toBe("Working");
  });
});
