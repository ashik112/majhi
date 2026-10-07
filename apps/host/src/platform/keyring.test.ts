import { describe, expect, it } from "vitest";
import {
  type FakeItems,
  type FakeKeyringState,
  type FakeProgram,
  failed,
  fakeOs,
  fakeSecretService,
  fakeSecurity,
  ok,
} from "./fakeOs.ts";
import { linuxPlatform } from "./linux.ts";
import { macosPlatform } from "./macos.ts";
import { SECRETS_KEY_ITEM, sshPassphraseItem } from "./types.ts";

const KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const PHRASE = "correct horse battery staple";
const KEY_ITEM = sshPassphraseItem("~/.ssh/id_ed25519");

/** Every argument of every run, so a test can check that a secret never went there. */
const allArgs = (runs: readonly { args: readonly string[] }[]): string =>
  runs.map((run) => run.args.join(" ")).join("\n");

describe("the Keychain on macOS", () => {
  function keychain(options: { refuse?: boolean; security?: FakeProgram } = {}) {
    const items: FakeItems = new Map();
    const security = options.security ?? fakeSecurity(items, { refuse: options.refuse ?? false });
    const os = fakeOs({ home: "/Users/owner", programs: { "/usr/bin/security": security } });
    return { keyring: macosPlatform(os.deps).keyring, runs: os.runs, items };
  }

  it("writes through security -i on stdin, reads the copy back, and removes it", async () => {
    const { keyring, runs, items } = keychain();
    expect(await keyring.check()).toEqual({ kind: "keychain" });
    await keyring.write(SECRETS_KEY_ITEM, KEY);
    expect(runs.map((run) => [run.file, ...run.args])).toEqual([
      ["/usr/bin/security", "-i"],
      ["/usr/bin/security", "find-generic-password", "-s", "majhi secrets key", "-a", "secrets.key", "-w"],
    ]);
    expect(runs[0]?.options.input).toBe(
      `add-generic-password -U -s "majhi secrets key" -a "secrets.key" -l "majhi secrets key" ` +
        `-j "${SECRETS_KEY_ITEM.comment}" -w ${KEY}\nquit\n`,
    );
    expect(allArgs(runs)).not.toContain(KEY);
    for (const run of runs) expect(run.options.env).toEqual({ PATH: "/usr/bin:/bin" });

    expect(await keyring.read(SECRETS_KEY_ITEM)).toBe(KEY);
    await keyring.remove(SECRETS_KEY_ITEM);
    expect(items.size).toBe(0);
    expect(await keyring.read(SECRETS_KEY_ITEM)).toBeUndefined();
    // An item that is not there is fine to remove.
    await keyring.remove(SECRETS_KEY_ITEM);
  });

  it("refuses a secret or an item that could break the command line, and runs nothing", async () => {
    const { keyring, runs } = keychain();
    await expect(keyring.write(SECRETS_KEY_ITEM, `${KEY}" -w x`)).rejects.toThrow(
      "This secret cannot go to the Keychain.",
    );
    await expect(keyring.write(SECRETS_KEY_ITEM, `${KEY}\ndelete-keychain`)).rejects.toThrow(
      "This secret cannot go to the Keychain.",
    );
    await expect(keyring.write({ ...SECRETS_KEY_ITEM, label: 'a" -w x' }, KEY)).rejects.toThrow(
      "This item cannot go to the Keychain.",
    );
    expect(runs).toEqual([]);
  });

  it("says when the Keychain kept nothing or did not answer, never with the secret", async () => {
    const refused = keychain({ refuse: true });
    const error = await refused.keyring.write(SECRETS_KEY_ITEM, KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);

    const broken = keychain({ security: () => failed(51, "User interaction is not allowed.") });
    await expect(broken.keyring.read(SECRETS_KEY_ITEM)).rejects.toThrow();
    await expect(broken.keyring.remove(SECRETS_KEY_ITEM)).rejects.toThrow();
  });
});

describe("the Secret Service keyring on Linux", () => {
  function secretService(
    state: FakeKeyringState,
    options: { items?: FakeItems; without?: string; secretTool?: FakeProgram } = {},
  ) {
    const programs = fakeSecretService(options.items ?? new Map(), state);
    if (options.secretTool !== undefined) programs["/usr/bin/secret-tool"] = options.secretTool;
    if (options.without !== undefined) delete programs[options.without];
    const os = fakeOs({
      env: {
        DISPLAY: ":0",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        NORTHWIND_TOKEN: "not-for-the-keyring",
      },
      programs,
    });
    return { keyring: linuxPlatform(os.deps).keyring, runs: os.runs };
  }

  it("asks D-Bus whether the default collection is unlocked, and names what is missing", async () => {
    const unlocked = secretService("unlocked");
    expect(await unlocked.keyring.check()).toEqual({ kind: "secret-service" });
    expect(unlocked.runs).toHaveLength(1);
    expect(unlocked.runs[0]?.file).toBe("/usr/bin/busctl");
    expect(unlocked.runs[0]?.args).toEqual([
      "--user",
      "get-property",
      "org.freedesktop.secrets",
      "/org/freedesktop/secrets/aliases/default",
      "org.freedesktop.Secret.Collection",
      "Locked",
    ]);
    // Only what D-Bus needs goes to the probe, never the rest of the helper's environment.
    expect(unlocked.runs[0]?.options.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/owner",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });

    expect(await secretService("locked").keyring.check()).toEqual({
      kind: "none",
      reason: "The keyring is locked.",
    });
    expect(await secretService("absent").keyring.check()).toEqual({
      kind: "none",
      reason: "No keyring is running.",
    });
    expect(await secretService("unlocked", { without: "/usr/bin/secret-tool" }).keyring.check()).toEqual({
      kind: "none",
      reason:
        "secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch).",
    });
    expect(await secretService("unlocked", { without: "/usr/bin/busctl" }).keyring.check()).toEqual({
      kind: "none",
      reason: "The keyring cannot be checked without busctl (systemd).",
    });
  });

  it("never runs secret-tool on a locked keyring, which would pop an unlock prompt", async () => {
    const items: FakeItems = new Map([[`${KEY_ITEM.service}|${KEY_ITEM.account}`, PHRASE]]);
    const { keyring, runs } = secretService("locked", { items });
    await expect(keyring.read(KEY_ITEM)).rejects.toThrow("The keyring is locked.");
    await expect(keyring.write(KEY_ITEM, PHRASE)).rejects.toThrow("The keyring is locked.");
    await expect(keyring.remove(KEY_ITEM)).rejects.toThrow("The keyring is locked.");
    expect(runs.every((run) => run.file === "/usr/bin/busctl")).toBe(true);
    expect(items.size).toBe(1);
  });

  it("writes the secret on stdin only, reads the copy back, and removes it", async () => {
    const items: FakeItems = new Map();
    const { keyring, runs } = secretService("unlocked", { items });
    await keyring.write(KEY_ITEM, PHRASE);
    expect(runs.map((run) => run.args[0])).toEqual(["--user", "store", "lookup"]);
    const store = runs[1];
    expect(store?.args).toEqual([
      "store",
      "--label=majhi SSH key passphrase for ~/.ssh/id_ed25519",
      "service",
      "majhi ssh key",
      "account",
      "~/.ssh/id_ed25519",
    ]);
    expect(store?.options.input).toBe(PHRASE);
    expect(runs.filter((run) => run.options.input !== undefined)).toHaveLength(1);
    expect(allArgs(runs)).not.toContain(PHRASE);

    expect(await keyring.read(KEY_ITEM)).toBe(PHRASE);
    await keyring.remove(KEY_ITEM);
    expect(items.size).toBe(0);
    expect(await keyring.read(KEY_ITEM)).toBeUndefined();
    await keyring.remove(KEY_ITEM);
  });

  it("says when the keyring kept nothing or did not answer, never with the secret", async () => {
    const forgetful = secretService("unlocked", {
      secretTool: (args) => (args[0] === "lookup" ? failed(1) : ok()),
    });
    const error = await forgetful.keyring.write(KEY_ITEM, PHRASE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);

    const broken = secretService("unlocked", { secretTool: () => failed(1, "Cannot autolaunch D-Bus") });
    await expect(broken.keyring.read(KEY_ITEM)).rejects.toThrow();
    await expect(broken.keyring.remove(KEY_ITEM)).rejects.toThrow();
  });
});
