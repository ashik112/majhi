import { keyringName } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { createKeyBackup, keyFingerprint } from "./keyBackup.ts";
import {
  type FakeItems,
  type FakeKeyringState,
  fakeOs,
  fakeSecretService,
  fakeSecurity,
} from "./platform/fakeOs.ts";
import { createPlatform } from "./platform/index.ts";
import { SECRETS_KEY_ITEM } from "./platform/types.ts";

const KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const OTHER = "AGE-SECRET-KEY-1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const ITEM = `${SECRETS_KEY_ITEM.service}|${SECRETS_KEY_ITEM.account}`;

/** The key backup over macOS's Keychain (a fake `security`), or a Linux Secret Service keyring. */
function setup(
  options: {
    os?: "macos" | "linux";
    file?: string;
    stored?: string;
    refuse?: boolean;
    keyring?: FakeKeyringState;
  } = {},
) {
  const items: FakeItems = new Map(options.stored === undefined ? [] : [[ITEM, options.stored]]);
  const os = options.os ?? "macos";
  const fake = fakeOs({
    home: os === "macos" ? "/Users/owner" : "/home/owner",
    programs:
      os === "macos"
        ? { "/usr/bin/security": fakeSecurity(items, { refuse: options.refuse ?? false }) }
        : fakeSecretService(items, options.keyring),
  });
  const logs: string[] = [];
  const backup = createKeyBackup({
    keyring: createPlatform(os, fake.deps).keyring,
    where: keyringName(os),
    readText: async () => options.file,
    keyFile: `${fake.deps.home}/.config/majhi/secrets.key`,
    log: (line) => logs.push(line),
    now: () => new Date("2026-10-02T10:00:00Z"),
  });
  return { backup, runs: fake.runs, logs, stored: () => items.get(ITEM) };
}

describe("secrets key backup in the Keychain", () => {
  it("saves the key when the Keychain has none, through stdin only", async () => {
    const { backup, runs, logs, stored } = setup({ file: `# created by make up\n${KEY}\n` });
    const status = await backup.ensure();
    expect(stored()).toBe(KEY);
    expect(status).toEqual({ saved: keyFingerprint(KEY), checkedAt: "2026-10-02T10:00:00.000Z" });
    for (const run of runs) expect(run.args.join(" ")).not.toContain(KEY);
    expect(runs.find((r) => r.args[0] === "-i")?.options.input).toContain(`"${SECRETS_KEY_ITEM.service}"`);
    expect(logs).toEqual(["keyring: keychain", "secrets key: saved a copy in the Keychain"]);
    expect(backup.keyring()).toEqual({ kind: "keychain" });
  });

  it("never replaces a different key on its own", async () => {
    const { backup, stored } = setup({ file: KEY, stored: OTHER });
    const status = await backup.ensure();
    expect(stored()).toBe(OTHER);
    expect(status?.saved).toBe(keyFingerprint(OTHER));
  });

  it("replaces it when asked for the key majhi uses", async () => {
    const { backup, stored } = setup({ file: KEY, stored: OTHER });
    const status = await backup.save(keyFingerprint(KEY));
    expect(stored()).toBe(KEY);
    expect(status.saved).toBe(keyFingerprint(KEY));
  });

  it("refuses to save a key file that is not the key majhi uses", async () => {
    const { backup, stored } = setup({ file: OTHER });
    await expect(backup.save(keyFingerprint(KEY))).rejects.toThrow("not the key majhi uses");
    expect(stored()).toBeUndefined();
  });

  it("refuses a key file whose line could break the security command", async () => {
    const bad = `${KEY}" -w x`;
    const { backup, runs } = setup({ file: bad });
    await expect(backup.save(keyFingerprint(bad))).rejects.toThrow("does not hold a key");
    expect(runs.some((r) => r.args[0] === "-i")).toBe(false);
  });

  it("reports a Keychain that did not keep the key, without the key", async () => {
    const { backup } = setup({ file: KEY, refuse: true });
    const status = await backup.ensure();
    expect(status?.saved).toBeUndefined();
    expect(status?.error).toBe("The Keychain did not take the majhi secrets key. Is it locked?");
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("reads the key back to restore a lost key file", async () => {
    const { backup } = setup({ stored: KEY });
    expect(await backup.read()).toBe(KEY);
  });

  it("fingerprints the key as the server does", () => {
    // The same line and value as the server's secrets store test.
    expect(keyFingerprint(KEY)).toBe("babd60656c326900");
  });
});

describe("secrets key backup in a Linux keyring", () => {
  it("saves the key through secret-tool's stdin, with no newline, and reads it back", async () => {
    const { backup, runs, logs, stored } = setup({ os: "linux", file: `${KEY}\n` });
    expect(await backup.ensure()).toEqual({
      saved: keyFingerprint(KEY),
      checkedAt: "2026-10-02T10:00:00.000Z",
    });
    expect(stored()).toBe(KEY);
    const store = runs.find((r) => r.args[0] === "store");
    expect(store?.args).toEqual([
      "store",
      "--label=majhi secrets key",
      "service",
      "majhi secrets key",
      "account",
      "secrets.key",
    ]);
    expect(store?.options.input).toBe(KEY);
    for (const run of runs) expect(run.args.join(" ")).not.toContain(KEY);
    expect(logs).toEqual(["keyring: secret-service", "secrets key: saved a copy in the keyring"]);
    expect(await backup.read()).toBe(KEY);
  });

  it("does nothing while the keyring is locked, and says why on save", async () => {
    const { backup, runs, stored } = setup({ os: "linux", file: KEY, keyring: "locked" });
    expect(await backup.ensure()).toBeUndefined();
    expect(backup.status()).toBeUndefined();
    expect(backup.keyring()).toEqual({ kind: "none", reason: "The keyring is locked." });
    await expect(backup.save(keyFingerprint(KEY))).rejects.toThrow(
      "The keyring is locked. The copy was not saved.",
    );
    expect(await backup.read()).toBeUndefined();
    // Only the D-Bus probe ran: secret-tool on a locked keyring would pop an unlock prompt.
    expect(runs.every((r) => r.file === "/usr/bin/busctl")).toBe(true);
    expect(stored()).toBeUndefined();
  });

  it("drops the last status when the keyring goes away, and logs each change once", async () => {
    let state: FakeKeyringState = "unlocked";
    const fake = fakeOs({ programs: fakeSecretService(new Map(), () => state) });
    const logs: string[] = [];
    const backup = createKeyBackup({
      keyring: createPlatform("linux", fake.deps).keyring,
      where: "the keyring",
      readText: async () => KEY,
      keyFile: "/home/owner/.config/majhi/secrets.key",
      log: (line) => logs.push(line),
    });
    await backup.ensure();
    await backup.ensure();
    expect(backup.status()?.saved).toBe(keyFingerprint(KEY));
    state = "absent";
    expect(await backup.ensure()).toBeUndefined();
    expect(backup.status()).toBeUndefined();
    expect(logs).toEqual([
      "keyring: secret-service",
      "secrets key: saved a copy in the keyring",
      "keyring: none, No keyring is running.",
    ]);
  });

  it("checks the key file before anything goes to the keyring", async () => {
    const bad = `${KEY} extra`;
    const { backup, runs } = setup({ os: "linux", file: bad });
    await expect(backup.save(keyFingerprint(bad))).rejects.toThrow("does not hold a key");
    expect(runs.some((r) => r.args[0] === "store")).toBe(false);
  });
});
