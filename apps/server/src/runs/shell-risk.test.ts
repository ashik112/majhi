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
