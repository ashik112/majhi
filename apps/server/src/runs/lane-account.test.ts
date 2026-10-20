import type { AccountConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Lanes } from "../captain/lanes.ts";
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
});

describe("the captain's account in a workspace's step", () => {
  const sections = {
    orgs: { acme: { name: "Acme" }, globex: { name: "Globex" } },
    accounts: {
      "claude-own": { tool: "claude", org: "private" },
      "claude-spare": { tool: "claude", org: "private" },
      "claude-acme": { tool: "claude", org: "acme" },
      "claude-globex": { tool: "claude", org: "globex" },
    },
    boss: "boss",
  };
  const lanes = (
    overrides: Record<string, { account?: string }>,
    state: Record<string, { status?: string; until?: string }> = {},
  ) =>
    new Lanes({
      config: {
        sections: async () => sections,
        settings: async () => ({ autonomy: { orgs: overrides } }),
      },
      agents: {
        get: async (id: string) =>
          id === "boss"
            ? { ok: true, agent: { frontmatter: { account: "claude-own", fallback: "spare" } } }
            : { ok: true, agent: { frontmatter: { account: "claude-spare" } } },
      },
      accountState: async (account: string) => state[account],
    } as unknown as ConstructorParameters<typeof Lanes>[0]);

  it("runs every workspace on the captain's account, or on the workspace's own when it is named, and falls back at a limit", async () => {
    expect(await lanes({}).account("acme")).toEqual({ account: "claude-own", own: true });
    expect(await lanes({}).account("globex")).toEqual({ account: "claude-own", own: true });
    // Acme names its own account: only Acme uses it.
    const named = lanes({ acme: { account: "claude-acme" } });
    expect(await named.account("acme")).toEqual({ account: "claude-acme", own: false });
    expect(await named.account("globex")).toEqual({ account: "claude-own", own: true });
    // The owner's own account named for a workspace runs it too (a setting kept from before the one captain).
    expect(await lanes({ acme: { account: "claude-own" } }).account("acme")).toEqual({
      account: "claude-own",
      own: true,
    });
    // Another workspace's account is refused, whatever is asked.
    expect(await lanes({ acme: { account: "claude-globex" } }).account("acme")).toMatchObject({
      why: "account-of-another-workspace",
    });
    // At its limit the captain's account hands over to the fallback agent's account.
    const limited = { "claude-own": { status: "at-limit", until: "2026-10-21T14:00:00.000Z" } };
    expect(await lanes({}, limited).account("acme")).toEqual({
      account: "claude-spare",
      own: false,
      fallback: true,
    });
    // With both at their limit Needs you gets the typed reason and the reset time.
    expect(
      await lanes({}, { ...limited, "claude-spare": { status: "at-limit" } }).account("acme"),
    ).toMatchObject({ why: "at-limit", until: "2026-10-21T14:00:00.000Z" });
  });
});
