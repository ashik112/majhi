import type { AgentEntry, ParsedTask, ProjectView, TaskSummary } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  avatarTone,
  buildChips,
  createOverrides,
  defaultAgentId,
  eligibleAgents,
  groupTasks,
  initialOf,
  isYourTurn,
  listGroup,
  moveCursor,
  primaryAction,
  repoLabel,
  statusInfo,
  taskBoxKey,
  visibleTaskIds,
} from "./model";

function summary(id: string, status: TaskSummary["status"], updatedAt: string): TaskSummary {
  // Running tasks have a working agent here; `your turn` below covers idle ones.
  const working = status === "running" ? ["lead"] : [];
  return { id, title: id, kind: "code", status, team: [], updatedAt, repos: [], working };
}

describe("groupTasks", () => {
  const tasks = [
    summary("A-1", "done", "2026-01-01"),
    summary("A-2", "running", "2026-01-02"),
    summary("A-3", "ready", "2026-01-03"),
    summary("A-4", "paused", "2026-01-04"),
    summary("A-5", "review", "2026-01-05"),
    summary("A-6", "inbox", "2026-01-06"),
    summary("A-7", "mr", "2026-01-01"),
  ];

  it("orders groups and puts the newest task first inside each", () => {
    const groups = groupTasks(tasks);
    expect(groups.map((g) => g.label)).toEqual(["Needs you", "Working", "Up next", "Done"]);
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["A-5", "A-4", "A-7"]);
    expect(groups[2]?.tasks.map((t) => t.id)).toEqual(["A-6", "A-3"]);
  });

  it("leaves out empty groups", () => {
    expect(groupTasks([summary("A-1", "running", "x")]).map((g) => g.id)).toEqual(["working"]);
    expect(groupTasks([])).toEqual([]);
  });

  it("skips the done group in the cursor order while it is collapsed", () => {
    const groups = groupTasks(tasks);
    expect(visibleTaskIds(groups, false)).not.toContain("A-1");
    expect(visibleTaskIds(groups, true)).toContain("A-1");
  });
});

describe("moveCursor", () => {
  const ids = ["a", "b", "c"];
  it("moves and clamps", () => {
    expect(moveCursor(ids, "a", 1)).toBe("b");
    expect(moveCursor(ids, "c", 1)).toBe("c");
    expect(moveCursor(ids, "a", -1)).toBe("a");
  });
  it("starts at an end when there is no cursor or it left the list", () => {
    expect(moveCursor(ids, undefined, 1)).toBe("a");
    expect(moveCursor(ids, "gone", -1)).toBe("c");
    expect(moveCursor([], "a", 1)).toBeUndefined();
  });
});

describe("status", () => {
  it("labels statuses and names the pause reason", () => {
    expect(statusInfo("running")).toEqual({ label: "Working", tone: "amber" });
    expect(statusInfo("paused", "limit").label).toBe("Paused, limit");
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
    expect(initialOf("acme-lead")).toBe("A");
  });
});

const projects: ProjectView[] = [
  { id: "api", org: "acme", path: "/w/api", aliases: ["backend"], base: "develop", exists: true },
  { id: "web", org: "acme", path: "/w/web", aliases: [], exists: true },
];

function parsed(extra: Partial<ParsedTask> = {}): ParsedTask {
  return { title: "t", repos: [], mentions: [], links: [], kind: "code", warnings: [], ...extra };
}

describe("buildChips", () => {
  it("shows nothing without a parse result", () => {
    expect(buildChips({ parsed: null, projects })).toEqual([]);
  });

  it("builds repo chips with the base from the text, else the project's", () => {
    const chips = buildChips({
      parsed: parsed({
        repos: [
          { project: "api", match: "api" },
          { project: "web", match: "web" },
        ],
        base: "release/2.1",
      }),
      projects,
    });
    expect(chips.filter((c) => c.id.startsWith("repo-")).map((c) => c.label)).toEqual([
      "api: from release/2.1",
      "web: from release/2.1",
    ]);
    const plain = buildChips({
      parsed: parsed({
        repos: [
          { project: "api", match: "api" },
          { project: "web", match: "web" },
        ],
      }),
      projects,
    });
    expect(plain.filter((c) => c.id.startsWith("repo-")).map((c) => c.label)).toEqual([
      "api: from develop",
      "web: from default branch",
    ]);
  });

  it("adds branch, links and warnings", () => {
    const chips = buildChips({
      parsed: parsed({
        repos: [{ project: "api", match: "api" }],
        branch: "feature/x",
        links: ["https://a.dev", "https://b.dev"],
        warnings: ["No repo found"],
      }),
      projects,
    });
    expect(chips.find((c) => c.id === "branch")?.label).toBe("branch feature/x");
    expect(chips.find((c) => c.id === "links")?.label).toBe("2 links");
    expect(chips.find((c) => c.tone === "warn")?.label).toBe("No repo found");
  });

  it("shows the mentioned agent, else the default, and lets an override win", () => {
    const agentLabel = (input: Parameters<typeof buildChips>[0]) =>
      buildChips(input).find((c) => c.id === "agent")?.label;
    expect(agentLabel({ parsed: parsed({ mentions: ["lead"] }), projects, defaultAgent: "builder" })).toBe(
      "@lead",
    );
    expect(agentLabel({ parsed: parsed(), projects, defaultAgent: "builder" })).toBe("@builder");
    expect(agentLabel({ parsed: parsed({ mentions: ["lead"] }), projects, agentOverride: "boss" })).toBe(
      "@boss",
    );
    expect(agentLabel({ parsed: parsed(), projects })).toBeUndefined();
  });

  it("shows the kind, switched by the owner", () => {
    const kind = (override?: "code" | "chat") =>
      buildChips({ parsed: parsed(), projects, kindOverride: override }).find((c) => c.id === "kind");
    expect(kind()?.label).toBe("code");
    expect(kind("chat")?.label).toBe("chat");
    expect(kind()?.action).toBe("kind");
  });

  it("shows a base on its own when no repo is named", () => {
    expect(
      buildChips({ parsed: parsed({ base: "main" }), projects }).find((c) => c.id === "base")?.label,
    ).toBe("from main");
  });
});

describe("taskBoxKey", () => {
  const e = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean } = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    ...mods,
  });
  it("starts on Cmd or Ctrl+Enter only", () => {
    expect(taskBoxKey(e("Enter", { metaKey: true }))).toBe("start");
    expect(taskBoxKey(e("Enter", { ctrlKey: true }))).toBe("start");
    expect(taskBoxKey(e("Enter"))).toBe("default");
    expect(taskBoxKey(e("a", { metaKey: true }))).toBe("default");
    expect(taskBoxKey(e("Enter", { metaKey: true, isComposing: true }))).toBe("default");
  });
});

describe("createOverrides", () => {
  it("sends only what the owner changed", () => {
    expect(createOverrides(parsed(), undefined, undefined)).toEqual({});
    expect(createOverrides(parsed(), "code", undefined)).toEqual({});
    expect(createOverrides(parsed(), "chat", "boss")).toEqual({ kind: "chat", agent: "boss" });
  });
});

describe("repoLabel", () => {
  it("joins projects", () => {
    expect(repoLabel([{ project: "api" }, { project: "web" }])).toBe("api + web");
    expect(repoLabel([])).toBe("no repo");
  });
});

describe("your turn", () => {
  it("puts a running task whose agents are idle under Needs you, labelled Your turn", () => {
    const idle: TaskSummary = { ...summary("A-1", "running", "2026-09-29T10:00:00Z"), working: [] };
    const busy = { ...summary("A-2", "running", "2026-09-29T10:00:00Z"), working: ["lead"] };
    expect(isYourTurn(idle)).toBe(true);
    expect(listGroup(idle)).toBe("needs-you");
    expect(listGroup(busy)).toBe("working");
    expect(statusInfo("running", undefined, true)).toEqual({ label: "Your turn", tone: "violet" });
    expect(statusInfo("running", undefined, false).label).toBe("Working");
  });
});
