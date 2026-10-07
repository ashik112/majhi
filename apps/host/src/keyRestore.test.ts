import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyFingerprint } from "./keyBackup.ts";
import {
  createKeyRestorer,
  DOES_NOT_OPEN,
  KEY_FILE_WORKS,
  NOT_A_KEY,
  writeRestoredKey,
} from "./keyRestore.ts";
import { type ExecFn, recreateServer } from "./remount.ts";

const STAMP = "20261002T100000Z";

describe("restoring the secrets key", () => {
  let dir: string;
  let keyFile: string;
  let secretsFile: string;
  /** The key that made secrets.age. */
  let key: string;
  let other: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-key-restore-"));
    keyFile = join(dir, ".config", "majhi", "secrets.key");
    secretsFile = join(dir, ".majhi", "secrets.age");
    key = await generateIdentity();
    other = await generateIdentity();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const files = () => ({ keyFile, secretsFile, now: () => new Date("2026-10-02T10:00:00.123Z") });
  const modeOf = async (path: string) => (await stat(path)).mode & 0o777;
  const folder = () => readdir(dirname(keyFile)).then((names) => names.sort());

  /** secrets.age that each of these keys opens. */
  async function seal(...identities: string[]): Promise<void> {
    const encrypter = new Encrypter();
    for (const identity of identities) encrypter.addRecipient(await identityToRecipient(identity));
    await mkdir(dirname(secretsFile), { recursive: true });
    await writeFile(secretsFile, await encrypter.encrypt(JSON.stringify({ "acme-api": "value-1" })));
  }
  async function keyFileHolds(text: string): Promise<void> {
    await mkdir(dirname(keyFile), { recursive: true });
    await writeFile(keyFile, text, { mode: 0o600 });
  }

  it("writes a missing key file with mode 600, in a folder of mode 700", async () => {
    expect(await writeRestoredKey(key, files())).toEqual({ written: true });
    expect(await readFile(keyFile, "utf8")).toBe(`${key}\n`);
    expect(await modeOf(keyFile)).toBe(0o600);
    expect(await modeOf(dirname(keyFile))).toBe(0o700);

    await rm(keyFile);
    await chmod(dirname(keyFile), 0o755);
    await seal(key);
    expect(await writeRestoredKey(key, files())).toEqual({ written: true });
    expect(await modeOf(dirname(keyFile))).toBe(0o700);
    expect(await folder()).toEqual(["secrets.key"]);
  });

  it("keeps a key file that does not open secrets.age aside, and never deletes one", async () => {
    await seal(key);
    const made = `# created: 2026-10-01T09:00:00Z\n${other}\n`;
    await keyFileHolds(made);
    expect(await writeRestoredKey(key, files())).toEqual({
      written: true,
      keptAside: `${keyFile}.old-${STAMP}`,
    });
    expect(await readFile(keyFile, "utf8")).toBe(`${key}\n`);
    expect(await readFile(`${keyFile}.old-${STAMP}`, "utf8")).toBe(made);

    // A key file without a key counts as wrong too. The same second gets a numbered name.
    await keyFileHolds("");
    expect(await writeRestoredKey(key, files())).toEqual({
      written: true,
      keptAside: `${keyFile}.old-${STAMP}-2`,
    });
    expect(await folder()).toEqual(["secrets.key", `secrets.key.old-${STAMP}`, `secrets.key.old-${STAMP}-2`]);
  });

  it("moves aside the folder Docker makes where a key file was missing", async () => {
    await seal(key);
    await mkdir(keyFile, { recursive: true });
    expect(await writeRestoredKey(key, files())).toEqual({
      written: true,
      keptAside: `${keyFile}.old-${STAMP}`,
    });
    expect((await stat(`${keyFile}.old-${STAMP}`)).isDirectory()).toBe(true);
    expect(await readFile(keyFile, "utf8")).toBe(`${key}\n`);
  });

  it("leaves a key file that already holds the key as it is", async () => {
    await seal(key);
    await keyFileHolds(`# made by make up\n${key}\n`);
    expect(await writeRestoredKey(key, files())).toEqual({ written: false });
    expect(await readFile(keyFile, "utf8")).toBe(`# made by make up\n${key}\n`);
    expect(await folder()).toEqual(["secrets.key"]);
  });

  it("never replaces a key file that works", async () => {
    // secrets.age that both keys open, so only the guard on the key file stops the write.
    await seal(key, other);
    await keyFileHolds(`${key}\n`);
    await expect(writeRestoredKey(other, files())).rejects.toThrow(KEY_FILE_WORKS);
    // Before there is a secrets.age, any key in the key file works.
    await rm(secretsFile);
    await expect(writeRestoredKey(other, files())).rejects.toThrow(KEY_FILE_WORKS);
    expect(await readFile(keyFile, "utf8")).toBe(`${key}\n`);
    expect(await folder()).toEqual(["secrets.key"]);
  });

  it("writes nothing for a key that does not open secrets.age or is not a key", async () => {
    await seal(key);
    await expect(writeRestoredKey(other, files())).rejects.toThrow(DOES_NOT_OPEN);
    await expect(writeRestoredKey("AGE-SECRET-KEY-1QQQQQQ", files())).rejects.toThrow(NOT_A_KEY);
    await expect(writeRestoredKey(`${key}\n`, files())).rejects.toThrow(NOT_A_KEY);
    await expect(stat(dirname(keyFile))).rejects.toThrow("ENOENT");
  });

  it("answers first, then restarts majhi and saves the key to the keyring, logging no key", async () => {
    await seal(key);
    await keyFileHolds(`${other}\n`);
    const events: string[] = [];
    const docker: string[][] = [];
    const logs: string[] = [];
    const exec: ExecFn = async (_file, args) => {
      docker.push([...args]);
      events.push("docker");
      return { stdout: "", stderr: "" };
    };
    const restore = createKeyRestorer({
      ...files(),
      restart: () =>
        recreateServer(
          { repo: dir, docker: "/usr/local/bin/docker", env: {}, exec, log: (m) => logs.push(m) },
          "secrets key",
        ),
      saveToKeyring: async (fingerprint) => {
        events.push(`keyring ${fingerprint}`);
      },
      log: (m) => logs.push(m),
    });

    const run = await restore({ key });
    expect(run.result).toEqual({ written: true, keptAside: `${keyFile}.old-${STAMP}`, restarts: true });
    expect(events).toEqual([]);
    await run.after();
    expect(events).toEqual(["docker", `keyring ${keyFingerprint(key)}`]);
    expect(docker).toEqual([["compose", "up", "-d", "--force-recreate", "--wait", "server"]]);
    expect(logs[0]).toBe(`secrets key: restored from its export, the old file is ${keyFile}.old-${STAMP}`);
    expect(logs.join("\n")).not.toContain("AGE-SECRET-KEY");
  });

  it("logs a failed restart or keyring save instead of throwing, and only saves without Docker", async () => {
    await seal(key);
    const logs: string[] = [];
    const failing = createKeyRestorer({
      ...files(),
      restart: async () => {
        throw new Error("restart majhi failed: timed out after 300s");
      },
      saveToKeyring: async () => {
        throw new Error("The keyring did not take the secrets key. Is it locked?");
      },
      log: (m) => logs.push(m),
    });
    await expect((await failing({ key })).after()).resolves.toBeUndefined();
    expect(logs.slice(1)).toEqual([
      "secrets key: restart majhi failed: timed out after 300s",
      "secrets key: The keyring did not take the secrets key. Is it locked?",
    ]);

    const saved: string[] = [];
    const noDocker = createKeyRestorer({
      ...files(),
      restart: undefined,
      saveToKeyring: async (fingerprint) => {
        saved.push(fingerprint);
      },
      log: () => undefined,
    });
    const run = await noDocker({ key });
    expect(run.result).toEqual({ written: false, restarts: false });
    await run.after();
    expect(saved).toEqual([keyFingerprint(key)]);
  });

  it("looks for the restart at each restore, so one works once docker is found", async () => {
    await seal(key);
    let restart: (() => Promise<void>) | undefined;
    const restarted: string[] = [];
    const restore = createKeyRestorer({
      ...files(),
      get restart() {
        return restart;
      },
      saveToKeyring: undefined,
      log: () => undefined,
    });
    expect((await restore({ key })).result.restarts).toBe(false);
    restart = async () => {
      restarted.push("server");
    };
    const run = await restore({ key });
    expect(run.result.restarts).toBe(true);
    await run.after();
    expect(restarted).toEqual(["server"]);
  });

  it("runs one restore at a time", async () => {
    await seal(key);
    const restore = createKeyRestorer({
      ...files(),
      restart: undefined,
      saveToKeyring: undefined,
      log: () => undefined,
    });
    const runs = await Promise.all([restore({ key }), restore({ key })]);
    expect(runs.map((run) => run.result.written)).toEqual([true, false]);
    expect(await folder()).toEqual(["secrets.key"]);
  });
});
