import { describe, expect, it } from "vitest";
import { riskScopeOfTask, shellRisk } from "./shell-risk.ts";

/**
 * Security: the tasks folder is named `.majhi` like majhi's own home, but it holds work, not logins. Reading
 * another task's folder never asks; majhi's home and real login files still count as secrets.
 */
const scope = riskScopeOfTask({ folder: "/Users/owner/Work/.majhi/LOCAL-20", repos: [] });

describe("a shell command that names a path", () => {
  it.each([
    "cd /Users/owner/Work/.majhi/acme-api/fix-login/acme-api && git log --oneline -5 && git status --short | head",
    "cat /Users/owner/Work/.majhi/acme-api/fix-login/REPORT.md",
    "ls /Users/owner/Work/.majhi",
  ])("inside the tasks folder is a plain read: %s", (line) => {
    expect(shellRisk(line, scope)).toBe("sandbox");
  });

  it.each([
    "cat /Users/owner/.majhi/secrets.json",
    "ls /Users/owner/.majhi",
    "cat /Users/owner/Work/.majhi/acme-api/fix-login/.ssh/id_ed25519",
    "cat /Users/owner/.ssh/id_rsa",
  ])("naming a login or majhi's home is a secret: %s", (line) => {
    expect(shellRisk(line, scope)).toBe("secret");
  });
});

/**
 * Reading the workspace's own code never asks: a clone or a fetch into a temp folder, a log or a diff, a GET through
 * the host's API, and the listing verbs. A write to the host, a push outside the task's branch and a delete still
 * land in their own kind. The first line is the one the captain ran in a live lane, which waited 11 hours on a card.
 */
const taskScope = riskScopeOfTask({
  folder: "/Users/owner/Work/.majhi/LOCAL-21",
  repos: [{ branch: "acme/fix-login", base: "main", writes: true }],
});

describe("a command that reads the workspace's own code", () => {
  it.each([
    "D=/tmp/tmp.X; cd $D && glab repo clone acme/api gl -- --bare -q 2>&1 | tail -3; cd gl && git remote -v | head -1 && git fetch -q https://github.com/globex/api.git main:refs/gh/main 2>&1|tail -2; git log --oneline -1 main; git diff --stat 99a0b319 96490c1eb | tail -2",
    "glab repo clone acme/api /tmp/gl -- --bare -q",
    "gh repo clone globex/api /tmp/api",
    "cd $(mktemp -d) && git clone https://example.com/acme/api.git && git log --oneline -3",
    "git fetch -q https://example.com/acme/api.git main:refs/remotes/acme/main",
    "git ls-remote https://example.com/acme/api.git",
    "git show 99a0b319 --stat",
    "glab api projects/acme%2Fapi/merge_requests",
    "glab api -X GET projects/acme%2Fapi/pipelines",
    "gh api --method GET repos/globex/api/pulls",
    "gh api repos/globex/api/issues --jq '.[].title'",
    "gh project list",
    "glab snippet list",
    "gh release view v1.2.0",
    "glab auth status",
  ])("never asks: %s", (line) => {
    expect(shellRisk(line, taskScope)).toBe("sandbox");
  });

  it.each([
    ["gh api -X POST repos/globex/api/issues -f title=Bug", "client-server-write"],
    ["gh api repos/globex/api/issues -f title=Bug", "client-server-write"],
    ["glab api --method PUT projects/acme%2Fapi/merge_requests/3/merge", "client-server-write"],
    ["gh api -X DELETE repos/globex/api/git/refs/heads/old", "client-server-write"],
    ["gh repo create globex/new --private", "client-server-write"],
    ["gh auth status --show-token", "secret"],
    ["gh secret list", "secret"],
    ["gh pr merge 5", "merge-main"],
    ["glab mr merge 5", "merge-main"],
    ["git push origin main", "merge-main"],
    ["git push origin acme/fix-login", "push-branch"],
    ["glab repo delete acme/api", "delete-outside"],
    ["npm publish", "client-server-write"],
    ["glab repo clone acme/api /Users/owner/.ssh/keys", "secret"],
  ] as const)("keeps its kind: %s", (line, kind) => {
    expect(shellRisk(line, taskScope)).toBe(kind);
  });
});
