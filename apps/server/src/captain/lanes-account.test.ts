import { describe, expect, it } from "vitest";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { Store } from "../store/index.ts";
import { Lanes } from "./lanes.ts";
import type { CaptainRepo } from "./repo.ts";

/** Which account pays for a lane: never the owner's Private account for a client workspace unless the owner named it. */

function lanes(opts: { acmeAccounts: boolean; chosen?: string }) {
  const accounts: Record<string, { org: string; tool: string }> = {
    "claude-personal": { org: "private", tool: "claude" },
    ...(opts.acmeAccounts ? { "claude-acme": { org: "acme", tool: "claude" } } : {}),
    "claude-globex": { org: "globex", tool: "claude" },
  };
  const config = {
    sections: async () => ({ boss: "captain", orgs: { acme: { name: "Acme" } }, accounts }),
    settings: async () => ({
      autonomy: { orgs: { acme: opts.chosen === undefined ? {} : { account: opts.chosen } } },
    }),
  } as unknown as ConfigService;
  const agents = {
    get: async () => ({ ok: true, agent: { frontmatter: { account: "claude-personal" } } }),
  } as unknown as AgentStore;
  return new Lanes({
    repo: {} as CaptainRepo,
    store: {} as Store,
    tasks: {} as never,
    config,
    agents,
    now: () => new Date(),
  });
}

describe("the account of a client workspace's lane", () => {
  it("uses the workspace's own account, not the owner's Private one", async () => {
    expect(await lanes({ acmeAccounts: true }).account("acme")).toEqual({
      account: "claude-acme",
      own: false,
    });
  });

  it("refuses the Private account when the owner has not named it for the workspace", async () => {
    const out = await lanes({ acmeAccounts: false }).account("acme");
    expect(out).toEqual({
      problem:
        "Acme has no account of its own for the captain, and claude-personal is a Private account. Pick the account that pays in Captain, Permissions, Acme, Hours, freezes and more",
    });
  });

  it("uses the Private account once the owner names it, and never another workspace's", async () => {
    expect(await lanes({ acmeAccounts: false, chosen: "claude-personal" }).account("acme")).toEqual({
      account: "claude-personal",
      own: true,
    });
    const other = await lanes({ acmeAccounts: true, chosen: "claude-globex" }).account("acme");
    expect(other).toEqual({
      problem:
        "claude-globex belongs to globex, so it cannot pay for Acme. Pick an account of Acme in Captain, Permissions, Acme, Hours, freezes and more",
    });
  });
});
