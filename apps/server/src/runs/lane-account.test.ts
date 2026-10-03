import type { AccountConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type ResolvedAgent, withAccount } from "./launch.ts";

/** The captain's lane on the account its workspace names (5.18): never another workspace's credentials. */

const captain = {
  fm: { id: "boss", account: "claude-own" },
  instructions: "",
  account: { tool: "claude", org: "private", auth: "login" },
  boss: "boss",
} as unknown as ResolvedAgent;

const accounts: Record<string, AccountConfig> = {
  "claude-own": { tool: "claude", org: "private", auth: "login" } as AccountConfig,
  "claude-acme": { tool: "claude", org: "acme", auth: "login" } as AccountConfig,
  "codex-globex": { tool: "codex", org: "globex", auth: "login" } as AccountConfig,
};

describe("the lane's account", () => {
  it("keeps the captain's own account when the workspace names none", () => {
    expect(withAccount(captain, undefined, accounts, "acme")).toBe(captain);
  });

  it("runs on the workspace's own account", () => {
    const run = withAccount(captain, "claude-acme", accounts, "acme");
    expect(run.fm.account).toBe("claude-acme");
    expect(run.account.org).toBe("acme");
  });

  it("refuses another workspace's account, whatever the lane asks", () => {
    expect(() => withAccount(captain, "codex-globex", accounts, "acme")).toThrow(
      'codex-globex belongs to "globex" and cannot run work of "acme".',
    );
    expect(() => withAccount(captain, "claude-acme", accounts, undefined)).toThrow(
      'claude-acme belongs to "acme" and cannot run work of "private".',
    );
    expect(() => withAccount(captain, "nobody", accounts, "acme")).toThrow(
      'Account "nobody" is not in majhi.yaml.',
    );
  });

  it("may use a Private account in any workspace", () => {
    const acmeCaptain = { ...captain, fm: { ...captain.fm, account: "claude-acme" } } as ResolvedAgent;
    expect(withAccount(acmeCaptain, "claude-own", accounts, "globex").fm.account).toBe("claude-own");
  });
});
