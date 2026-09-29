import { describe, expect, it } from "vitest";
import { sshVerdict } from "./doctor.ts";

const at = "2026-09-29T10:00:00.000Z";

describe("the SSH agent check", () => {
  it("passes when keys are loaded and none waits for a passphrase", () => {
    expect(sshVerdict("SSH agent", 2, { loaded: 2, needsPassphrase: [], checkedAt: at })).toEqual({
      name: "SSH agent",
      status: "pass",
      detail: "Reachable, 2 keys loaded",
    });
  });

  it("prints the exact one-time command for each key that needs a passphrase", () => {
    const check = sshVerdict("SSH agent", 1, {
      loaded: 1,
      needsPassphrase: ["~/.ssh/id_work", "~/.ssh/id_ed25519"],
      checkedAt: at,
    });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("ssh-add --apple-use-keychain ~/.ssh/id_work");
    expect(check.detail).toContain("ssh-add --apple-use-keychain ~/.ssh/id_ed25519");
    expect(check.detail).toContain("1 key loaded");
  });

  it("warns when the agent holds no keys, with or without a helper report", () => {
    expect(sshVerdict("SSH agent", 0, undefined)).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("the host helper has not loaded any"),
    });
    expect(sshVerdict("SSH agent", 0, { loaded: 0, needsPassphrase: [], checkedAt: at })).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("no key file was found"),
    });
  });
});
