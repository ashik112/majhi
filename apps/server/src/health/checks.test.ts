import type { HostStatus } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { accountCheck, checkHostHelper, diskStatus } from "./checks.ts";

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

  it("offers Sign in for a signed-out account and Check again for an unreachable one", () => {
    expect(accountCheck(view("needs-login"), undefined)).toMatchObject({
      status: "warn",
      fix: { label: "Sign in" },
    });
    expect(
      accountCheck(view("unreachable"), [{ name: "acp", ok: false, detail: "no session" }]),
    ).toMatchObject({ status: "fail", detail: "acp: no session", fix: { label: "Check again" } });
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
