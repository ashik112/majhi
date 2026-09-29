import type { AccountView, OrgView, TaskSummary } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../lib/agent-index";
import {
  accountsNeedingYou,
  agentsRightNow,
  deriveBanner,
  healthCheckedText,
  inOrg,
  orgRows,
  parseOrgParam,
} from "./model";
import { resolveShortcut } from "./shortcuts";

const task = (over: Partial<TaskSummary> & { id: string }): TaskSummary => ({
  title: "A task",
  kind: "code",
  status: "inbox",
  team: [],
  updatedAt: "2026-09-29T10:00:00Z",
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
  ...over,
});

const org = (id: string, key: string): OrgView => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  key,
  color: "#8ab8f5",
  accountCount: 0,
  agentCount: 0,
});

const agent = (id: string, account: string): AgentInfo => ({
  id,
  role: "Lead",
  account,
  model: undefined,
  effort: undefined,
  perms: [],
  fallback: undefined,
  scope: "acme",
  isBoss: false,
});

const account = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id,
  tool: "claude",
  org: "acme",
  auth: "login",
  home: "/x",
  agentCount: 1,
  status: "healthy",
  ...over,
});

describe("org filter", () => {
  const orgs = [org("acme", "ACM"), org("beta", "BET")];
  it("reads a known org from the URL and ignores the rest", () => {
    expect(parseOrgParam("acme", orgs)).toBe("acme");
    expect(parseOrgParam("all", orgs)).toBeUndefined();
    expect(parseOrgParam("ghost", orgs)).toBeUndefined();
    expect(parseOrgParam(undefined, orgs)).toBeUndefined();
  });
  it("keeps the value while orgs have not loaded", () => {
    expect(parseOrgParam("acme", [])).toBe("acme");
  });
  it("filters tasks; local tasks only show under All", () => {
    expect(inOrg({ org: "acme" }, "acme")).toBe(true);
    expect(inOrg({ org: undefined }, "acme")).toBe(false);
    expect(inOrg({ org: undefined }, undefined)).toBe(true);
  });
  it("counts open tasks per org and leaves done ones out", () => {
    const rows = orgRows(orgs, [
      task({ id: "ACM-1", org: "acme" }),
      task({ id: "ACM-2", org: "acme", status: "done" }),
      task({ id: "BET-1", org: "beta", status: "running" }),
      task({ id: "LOCAL-1" }),
    ]);
    expect(rows.map((r) => [r.name, r.badge, r.open])).toEqual([
      ["All orgs", "*", 3],
      ["Acme", "AC", 1],
      ["Beta", "BE", 1],
    ]);
  });
});

describe("agentsRightNow", () => {
  const agents = [agent("a", "acc-a"), agent("b", "acc-b"), agent("c", "acc-c"), agent("d", "acc-d")];
  it("puts each agent in one bucket: working, paused, limit, idle", () => {
    const tasks = [
      task({ id: "ACM-1", status: "running", team: ["a"], working: ["a"] }),
      task({ id: "ACM-2", status: "paused", team: ["b"], pausedReason: "limit" }),
    ];
    const accounts = [
      account("acc-a"),
      account("acc-b"),
      account("acc-c", { status: "at-limit" }),
      account("acc-d"),
    ];
    expect(agentsRightNow(agents, tasks, accounts)).toEqual({ working: 1, paused: 1, limit: 1, idle: 1 });
  });
  it("counts a full usage window as a limit", () => {
    const accounts = [
      account("acc-a", { usage: { window: { usedPct: 100 }, models: [], estimated: false, updatedAt: "" } }),
    ];
    expect(agentsRightNow([agent("a", "acc-a")], [], accounts).limit).toBe(1);
  });
  it("treats a running task with no one working as idle agents", () => {
    const tasks = [task({ id: "ACM-1", status: "running", team: ["a"], working: [] })];
    expect(agentsRightNow([agent("a", "acc-a")], tasks, []).idle).toBe(1);
  });
});

describe("accounts and health", () => {
  it("lists accounts at limit, signed out or unreachable", () => {
    const list = [
      account("a"),
      account("b", { status: "needs-login" }),
      account("c", { status: "at-limit" }),
      account("d", { status: "running-high" }),
    ];
    expect(accountsNeedingYou(list).map((a) => a.id)).toEqual(["b", "c"]);
  });
  it("names the newest check", () => {
    const now = Date.parse("2026-09-29T10:05:00Z");
    const list = [
      account("a", { lastHealth: { ok: true, checkedAt: "2026-09-29T09:00:00Z", durationMs: 1, steps: [] } }),
      account("b", { lastHealth: { ok: true, checkedAt: "2026-09-29T10:03:00Z", durationMs: 1, steps: [] } }),
    ];
    expect(healthCheckedText(list, now)).toBe("Health checked 2 min ago");
    expect(healthCheckedText([account("c")], now)).toBe("Health not checked yet");
  });
});

describe("deriveBanner", () => {
  const now = Date.parse("2026-09-29T10:00:00Z");
  const agents = new Map([["lead", agent("lead", "claude-acme")]]);
  const base = { tasks: [], agents, accounts: [], permission: undefined, now };

  it("shows nothing when nothing needs the owner", () => {
    expect(deriveBanner({ ...base, tasks: [task({ id: "ACM-1", status: "running" })] })).toBeNull();
  });
  it("says which account hit its limit and opens the task", () => {
    const banner = deriveBanner({
      ...base,
      tasks: [task({ id: "ACM-3", status: "paused", pausedReason: "limit", team: ["lead"] })],
      accounts: [
        account("claude-acme", {
          usage: {
            window: { usedPct: 100, resetsAt: "2026-09-29T10:00:00Z" },
            models: [],
            estimated: false,
            updatedAt: "",
          },
        }),
      ],
    });
    expect(banner).toMatchObject({
      tone: "amber",
      actionLabel: "Open ACM-3",
      action: { kind: "task", id: "ACM-3" },
      more: 0,
    });
    expect(banner?.text).toMatch(/^ACM-3 is paused: claude-acme hit its usage limit, resets /);
  });
  it("skips a task the owner stopped", () => {
    expect(
      deriveBanner({ ...base, tasks: [task({ id: "ACM-1", status: "paused", pausedReason: "owner" })] }),
    ).toBeNull();
  });
  it("ranks a limit pause over a pending prompt over a sign-in, and counts the rest", () => {
    const banner = deriveBanner({
      ...base,
      tasks: [task({ id: "ACM-3", status: "paused", pausedReason: "limit", team: ["lead"] })],
      accounts: [account("x", { status: "needs-login" })],
      permission: { task: "ACM-4", agent: "lead", elementId: "perm-1" },
    });
    expect(banner?.key).toBe("limit:ACM-3");
    expect(banner?.more).toBe(2);
  });
  it("points a pending prompt at its element", () => {
    const banner = deriveBanner({
      ...base,
      permission: { task: "ACM-4", agent: "lead", elementId: "perm-1" },
    });
    expect(banner).toMatchObject({ actionLabel: "Show", action: { kind: "element", id: "perm-1" } });
  });
  it("sends a sign-in to Accounts", () => {
    const banner = deriveBanner({ ...base, accounts: [account("x", { status: "needs-login" })] });
    expect(banner).toMatchObject({
      tone: "red",
      text: "x needs you to sign in.",
      action: { kind: "page", to: "/accounts", search: { account: "x" } },
    });
  });
});

describe("resolveShortcut", () => {
  const key = (k: string, extra: Partial<Parameters<typeof resolveShortcut>[0]> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    ...extra,
  });
  it("waits after g and goes on the second key", () => {
    expect(resolveShortcut(key("g"), false)).toEqual({ type: "wait-for-go" });
    expect(resolveShortcut(key("a"), true)).toEqual({ type: "go", to: "/agents" });
    expect(resolveShortcut(key("b"), true)).toEqual({ type: "go", to: "/" });
    expect(resolveShortcut(key("z"), true)).toEqual({ type: "none" });
  });
  it("opens new task on n and help on ?", () => {
    expect(resolveShortcut(key("n"), false)).toEqual({ type: "new-task" });
    expect(resolveShortcut(key("?", { shiftKey: true } as never), false)).toEqual({ type: "help" });
  });
  it("leaves modified keys alone", () => {
    expect(resolveShortcut(key("n", { metaKey: true }), false)).toEqual({ type: "none" });
    expect(resolveShortcut(key("g", { ctrlKey: true }), false)).toEqual({ type: "none" });
  });
  it("does not go anywhere without g", () => {
    expect(resolveShortcut(key("a"), false)).toEqual({ type: "none" });
  });
});
