import type { OrgConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { onboardingStatus } from "./onboarding.ts";

const status = (
  orgs: Record<string, OrgConfig>,
  projects: Record<string, number>,
  used: Record<string, string[]>,
) =>
  onboardingStatus({
    roots: ["/Users/owner/Work"],
    orgs,
    accounts: [],
    hasCaptain: false,
    projects,
    usedHosts: used,
    hostHelper: true,
  });
const git = (s: ReturnType<typeof status>) => s.steps.find((x) => x.id === "git");

it("Private completes workspace setup without a client workspace", () => {
  const s = status({ private: { name: "Private" } }, {}, {});
  expect(s.steps.find((step) => step.id === "workspaces")).toEqual({
    id: "workspaces",
    done: true,
    detail: "1 workspace",
  });
});

describe("first run: git accounts step", () => {
  it("is not done with nothing configured", () => {
    expect(git(status({ private: { name: "Private" } }, {}, {}))?.done).toBe(false);
  });

  it("is done only when every host the projects use has a sign-in, and names the missing ones", () => {
    const orgs: Record<string, OrgConfig> = {
      acme: { name: "Acme", mr_tokens: { github: "secret:t" } },
    };
    const partial = status(orgs, { acme: 3 }, { acme: ["github.com", "gitlab.com", "bitbucket.org"] });
    expect(git(partial)).toEqual({
      id: "git",
      done: false,
      detail: "Sign in to gitlab.com, bitbucket.org",
    });
    const all = status(orgs, { acme: 1 }, { acme: ["github.com"] });
    expect(git(all)?.done).toBe(true);
  });
});
