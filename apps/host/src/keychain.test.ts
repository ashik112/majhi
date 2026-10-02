import { describe, expect, it } from "vitest";
import { createKeyBackup, KEYCHAIN_SERVICE, keyFingerprint } from "./keychain.ts";
import type { RunOptions } from "./ssh.ts";

const KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const OTHER = "AGE-SECRET-KEY-1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

interface Call {
  args: readonly string[];
  options: RunOptions;
}

/** A fake `security` that keeps one item, like the login Keychain. */
function setup(options: { file?: string; stored?: string; platform?: string; refuse?: boolean } = {}) {
  let stored = options.stored;
  const calls: Call[] = [];
  const logs: string[] = [];
  const backup = createKeyBackup({
    run: async (_file, args, runOptions) => {
      calls.push({ args, options: runOptions });
      if (args[0] === "find-generic-password") {
        return stored === undefined
          ? { code: 44, stdout: "", stderr: "not found" }
          : { code: 0, stdout: `${stored}\n`, stderr: "" };
      }
      // `security -i`: the key is the word after -w.
      const words = (runOptions.input ?? "").split("\n")[0]?.split(" ") ?? [];
      if (!options.refuse) stored = words[words.indexOf("-w") + 1];
      return { code: 0, stdout: "", stderr: "" };
    },
    readText: async () => options.file,
    keyFile: "/Users/owner/.config/majhi/secrets.key",
    platform: options.platform ?? "darwin",
    log: (line) => logs.push(line),
    now: () => new Date("2026-10-02T10:00:00Z"),
  });
  return { backup, calls, logs, stored: () => stored };
}

describe("secrets key backup in the Keychain", () => {
  it("saves the key when the Keychain has none, through stdin only", async () => {
    const { backup, calls, logs, stored } = setup({ file: `# created by make up\n${KEY}\n` });
    const status = await backup.ensure();
    expect(stored()).toBe(KEY);
    expect(status).toEqual({ saved: keyFingerprint(KEY), checkedAt: "2026-10-02T10:00:00.000Z" });
    for (const call of calls) expect(call.args.join(" ")).not.toContain(KEY);
    expect(calls.find((c) => c.args[0] === "-i")?.options.input).toContain(`"${KEYCHAIN_SERVICE}"`);
    expect(logs.join("\n")).not.toContain(KEY);
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
    const { backup, calls } = setup({ file: bad });
    await expect(backup.save(keyFingerprint(bad))).rejects.toThrow("does not hold a key");
    expect(calls.some((c) => c.args[0] === "-i")).toBe(false);
  });

  it("reports a Keychain that did not keep the key, without the key", async () => {
    const { backup } = setup({ file: KEY, refuse: true });
    const status = await backup.ensure();
    expect(status?.saved).toBeUndefined();
    expect(status?.error).toContain("did not take the secrets key");
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("does nothing off macOS", async () => {
    const { backup, calls } = setup({ file: KEY, platform: "linux" });
    expect(await backup.ensure()).toBeUndefined();
    expect(await backup.read()).toBeUndefined();
    expect(calls).toEqual([]);
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
