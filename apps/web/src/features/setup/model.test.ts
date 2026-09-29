import type { AccountView, AgentEntry, HostStatus, RootScan } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { accountsCard, agentsCard, bossCard, readyCount, rootsCard, sshCard } from "./model";

const root = (over: Partial<RootScan> = {}): RootScan => ({
  path: "/h/Work",
  mounted: true,
  repos: [],
  ...over,
});

const account = (id: string, status: AccountView["status"]): AccountView => ({
  id,
  tool: "claude",
  org: "acme",
  auth: "login",
  home: "/x",
  agentCount: 0,
  status,
});

const agent = (id: string, scope: string, isBoss = false, account = "claude-acme"): AgentEntry => ({
  status: "ok",
  file: `/h/${id}.md`,
  warnings: [],
  isBoss,
  agent: {
    frontmatter: {
      id,
      scope,
      role: "Lead",
      account,
      where: ["anywhere"],
      perms: [],
      tools: [],
      connections: [],
      skills: [],
      origin: "owner",
    },
    instructions: "",
  },
});

describe("rootsCard", () => {
  it("is ready when every root is mounted, and counts the repos", () => {
    const state = rootsCard(
      [root({ repos: [{ name: "a", path: "/h/Work/a", relPath: "a", remotes: [], registered: false }] })],
      ["~/Work"],
    );
    expect(state).toEqual({ pill: "Ready", tone: "green", detail: "~/Work\n1 repo found" });
  });
  it("asks for a mount when a root is not visible", () => {
    expect(rootsCard([root({ mounted: false })], ["~/Work"]).pill).toBe("Needs mount");
  });
  it("waits for the first scan", () => {
    expect(rootsCard(undefined, ["~/Work"]).pill).toBe("Checking");
  });
});

describe("sshCard", () => {
  const host = (
    ssh: { loaded: number; needsPassphrase: string[] } | undefined,
    connected = true,
  ): HostStatus => ({
    connected,
    ...(ssh ? { info: { ssh: { ...ssh, checkedAt: "" } } as unknown as HostStatus["info"] } : {}),
  });
  it("names the three states", () => {
    expect(sshCard(host({ loaded: 2, needsPassphrase: [] })).detail).toBe("2 keys loaded");
    expect(sshCard(host({ loaded: 1, needsPassphrase: ["~/.ssh/id"] }))).toMatchObject({
      pill: "Needs you",
      tone: "coral",
    });
    expect(sshCard(host({ loaded: 0, needsPassphrase: [] })).detail).toBe("No SSH key loaded");
    expect(sshCard(host(undefined, false)).pill).toBe("Helper offline");
  });
});

describe("accounts, agents and boss cards", () => {
  it("counts accounts that need the owner", () => {
    const state = accountsCard([account("a", "healthy"), account("b", "needs-login")]);
    expect(state).toEqual({ pill: "Needs you", tone: "coral", detail: "2 accounts, 1 needs you" });
    expect(accountsCard([]).pill).toBe("None yet");
  });
  it("counts agents and the orgs they span", () => {
    const orgs = [
      { id: "acme", name: "Acme", key: "ACM", accountCount: 0, agentCount: 0 },
      { id: "zed", name: "Zed", key: "ZED", accountCount: 0, agentCount: 0 },
    ];
    expect(agentsCard([agent("a", "acme"), agent("b", "acme"), agent("r", "root")], orgs).detail).toBe(
      "3 agents across 1 org",
    );
  });
  it("shows the boss and how its account is doing", () => {
    const state = bossCard([agent("setup", "root", true)], [account("claude-acme", "healthy")]);
    expect(state).toMatchObject({
      id: "setup",
      pill: "Healthy",
      tone: "green",
      detail: "@setup · claude-acme · account default",
    });
    expect(bossCard([agent("setup", "root")], []).pill).toBe("No boss");
    expect(bossCard([agent("setup", "root", true)], [account("claude-acme", "needs-login")]).pill).toBe(
      "Needs you",
    );
  });
  it("counts the ready cards", () => {
    expect(
      readyCount([
        { pill: "", tone: "green", detail: "" },
        { pill: "", tone: "coral", detail: "" },
      ]),
    ).toBe(1);
  });
});
