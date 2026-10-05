import type { HostStatus } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { accountCheck, checkHostHelper, diskStatus, exportCheck, keychainCheck } from "./checks.ts";

describe("accountCheck", () => {
  const view = (status: Parameters<typeof accountCheck>[0]["status"]) => ({
    id: "work",
    status,
    auth: "login" as const,
    signedInAs: "me@example.com",
  });

  it("passes a healthy account and names who is signed in", () => {
    expect(accountCheck(view("healthy"), undefined)).toMatchObject({
      id: "account:work",
      group: "accounts",
      status: "pass",
      detail: "Signed in as me@example.com",
    });
  });

  it("offers Sign in for a signed-out account and no fix for an unreachable one (the page offers Check again)", () => {
    expect(accountCheck(view("needs-login"), undefined)).toMatchObject({
      status: "warn",
      fix: { label: "Sign in" },
    });
    expect(accountCheck(view("unreachable"), [{ name: "acp", ok: false, detail: "no session" }])).toEqual(
      expect.objectContaining({ status: "fail", detail: "acp: no session" }),
    );
    expect(
      accountCheck(view("unreachable"), [{ name: "acp", ok: false, detail: "no session" }]).fix,
    ).toBeUndefined();
  });

  it("gives no fix to an account that is at its limit", () => {
    const check = accountCheck(view("at-limit"), undefined);
    expect(check.status).toBe("warn");
    expect(check.fix).toBeUndefined();
  });
});

describe("checkHostHelper", () => {
  const connected = (info: NonNullable<HostStatus["info"]>): { status: HostStatus } => ({
    status: { connected: true, info },
  });

  it("names the Docker runtime when it can remount", () => {
    expect(
      checkHostHelper(
        connected({ version: "1", platform: "darwin", canRemount: true, dockerRuntime: "orbstack" }),
      ),
    ).toMatchObject({ status: "pass", detail: expect.stringContaining("OrbStack") });
  });

  it("warns without a fix when it is not connected, with the exact step", () => {
    const check = checkHostHelper({ status: { connected: false } });
    expect(check.status).toBe("warn");
    expect(check.fix).toBeUndefined();
    expect(check.detail).toContain("`make up`");
  });
});

describe("diskStatus", () => {
  it("warns under 5 GB and fails under 1 GB", () => {
    expect(diskStatus(6e9)).toBe("pass");
    expect(diskStatus(4e9)).toBe("warn");
    expect(diskStatus(5e8)).toBe("fail");
  });
});

describe("secrets key backup checks", () => {
  const KEY = "0123456789abcdef";
  const OLD = "fedcba9876543210";
  const mac = (secretsKey?: NonNullable<HostStatus["info"]>["secretsKey"]): { status: HostStatus } => ({
    status: {
      connected: true,
      info: { version: "1", platform: "darwin", canRemount: true, ...(secretsKey ? { secretsKey } : {}) },
    },
  });

  it("passes when the Keychain holds the key majhi uses", () => {
    expect(keychainCheck(KEY, mac({ saved: KEY, checkedAt: "t" })).status).toBe("pass");
  });

  it("warns with a fix when there is no copy, a failed copy or another key", () => {
    expect(keychainCheck(KEY, mac({ checkedAt: "t" }))).toMatchObject({
      status: "warn",
      fix: { label: "Save to the Keychain" },
    });
    expect(
      keychainCheck(KEY, mac({ error: "The Keychain did not answer. Is it locked?", checkedAt: "t" })),
    ).toMatchObject({
      status: "warn",
      detail: "The Keychain did not answer. Is it locked?",
      fix: { label: "Save to the Keychain" },
    });
    expect(keychainCheck(KEY, mac({ saved: OLD, checkedAt: "t" }))).toMatchObject({
      status: "warn",
      fix: { label: "Replace copy" },
    });
    expect(keychainCheck(KEY, mac()).status).toBe("warn");
  });

  it("warns without a fix while the helper is away", () => {
    const away = keychainCheck(KEY, { status: { connected: false } });
    expect(away.status).toBe("warn");
    expect(away.fix).toBeUndefined();
  });

  it("names the keyring on Linux, and warns with the reason and no fix when none answers", () => {
    const linux = (info: Partial<NonNullable<HostStatus["info"]>>): { status: HostStatus } => ({
      status: {
        connected: true,
        info: { version: "1", platform: "linux", os: "linux", canRemount: true, ...info },
      },
    });
    const kept = keychainCheck(
      KEY,
      linux({ keyring: { kind: "secret-service" }, secretsKey: { saved: KEY, checkedAt: "t" } }),
    );
    expect(kept).toMatchObject({ name: "Secrets key in the keyring", status: "pass" });
    expect(kept.detail).toContain("in the keyring");
    expect(keychainCheck(KEY, linux({ keyring: { kind: "secret-service" } }))).toMatchObject({
      status: "warn",
      fix: { label: "Save to the keyring" },
    });
    const locked = keychainCheck(KEY, linux({ keyring: { kind: "none", reason: "The keyring is locked." } }));
    expect(locked).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/^The keyring is locked\. /),
    });
    expect(locked.detail).toContain("export");
    expect(locked.fix).toBeUndefined();
  });

  it("warns until the current key is exported", () => {
    expect(exportCheck(KEY, undefined)).toMatchObject({ status: "warn", fix: { label: "Export key" } });
    expect(exportCheck(KEY, { fingerprint: OLD, exportedAt: "2026-09-01T10:00:00.000Z" })).toMatchObject({
      status: "warn",
      fix: { label: "Export key" },
    });
    expect(exportCheck(KEY, { fingerprint: KEY, exportedAt: "2026-10-02T10:00:00.000Z" })).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("2026-10-02"),
    });
  });
});
