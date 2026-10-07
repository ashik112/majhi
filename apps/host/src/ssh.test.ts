import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyringItem, PassphraseKeeping } from "./platform/types.ts";
import {
  createSsh,
  type RunFn,
  type RunOptions,
  type RunResult,
  SSH_ADD,
  type SshDeps,
  SshUnlockError,
} from "./ssh.ts";

const execFileAsync = promisify(execFile);
const HOME = "/Users/o";
const SOCK = "/private/tmp/com.apple.launchd.x/Listeners";
const fp = (n: string) => `SHA256:${n.padEnd(43, "A")}`;

interface World {
  /** Key file -> "none" | "pass" | "broken". */
  keys: Record<string, "none" | "pass" | "broken">;
  agent: Set<string>;
  /** The passphrase that opens each key. */
  unlockWith: Record<string, string>;
  calls: string[];
  agentDown: boolean;
  /** Per ssh-add with a passphrase: the askpass folder's and file's modes, and each answer it gave. */
  askpassSeen: { mode: number; dirMode: number; answers: (string | undefined)[] }[];
}

function fakeWorld(keys: World["keys"], loaded: string[] = []): World {
  return {
    keys,
    agent: new Set(loaded),
    unlockWith: {},
    calls: [],
    agentDown: false,
    askpassSeen: [],
  };
}

const keyFp = (key: string) => fp((key.split("/").pop() ?? key).replaceAll("_", ""));
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr = ""): RunResult => ({ code, stdout: "", stderr });

/** The askpass's answer, cut at the first line break as ssh-add does. Undefined when it exits non-zero. */
async function ask(options: RunOptions, prompt: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(options.env.SSH_ASKPASS ?? "", [prompt], { env: options.env });
    return stdout.split(/[\r\n]/)[0];
  } catch {
    return undefined;
  }
}

/**
 * ssh-add and ssh-keygen as fakes, matched by name. The real agent and Keychain are never touched,
 * but a passphrase comes from running the real askpass, the way ssh-add runs it.
 */
function fakeRun(w: World): RunFn {
  return async (file, args, options) => {
    w.calls.push([file, ...args].join(" "));
    // Nothing may prompt: askpass is off unless a passphrase is given, and there is always SSH_AUTH_SOCK.
    expect(options.env.SSH_AUTH_SOCK).toBe(SOCK);
    if (basename(file) === "ssh-keygen") {
      if (args[0] === "-lf") {
        const key = (args[1] ?? "").replace(/\.pub$/, "");
        return key in w.keys ? ok(`256 ${keyFp(key)} c (ED25519)\n`) : fail(1);
      }
      const key = args.at(-1) ?? "";
      const kind = w.keys[key];
      if (kind === "none") return ok("ssh-ed25519 AAAA\n");
      if (kind === "pass")
        return fail(1, `Load key "${key}": incorrect passphrase supplied to decrypt private key`);
      return fail(1, `Load key "${key}": invalid format`);
    }
    if (basename(file) === "ssh-add") {
      if (args[0] === "-l") {
        if (w.agentDown) return fail(2, "Error connecting to agent");
        if (w.agent.size === 0) return fail(1, "The agent has no identities.");
        return ok([...w.agent].map((f) => `256 ${f} c (ED25519)`).join("\n"));
      }
      if (args[0] === "--apple-load-keychain") return ok();
      const key = args.at(-1) ?? "";
      if (options.env.SSH_ASKPASS_REQUIRE === "force") {
        const dir = dirname(options.env.SSH_ASKPASS ?? "");
        const seen = {
          mode: (await stat(join(dir, "p"))).mode & 0o777,
          dirMode: (await stat(dir)).mode & 0o777,
          answers: [] as (string | undefined)[],
        };
        w.askpassSeen.push(seen);
        // Like ssh-add: a wrong answer gets the question again, until the answer is empty.
        let prompt = `Enter passphrase for ${key}: `;
        while (seen.answers.length < 5) {
          const answer = await ask(options, prompt);
          seen.answers.push(answer);
          if (answer === undefined || answer === "") break;
          if (answer === w.unlockWith[key]) {
            w.agent.add(keyFp(key));
            return ok(`Identity added: ${key}\n`);
          }
          prompt = `Bad passphrase, try again for ${key}: `;
        }
        return fail(1);
      }
      expect(options.env.SSH_ASKPASS_REQUIRE).toBe("never");
      w.agent.add(keyFp(key));
      return ok();
    }
    throw new Error(`unexpected ${file}`);
  };
}

/** A keyring in memory, by account. */
function fakeKeyring(held: Record<string, string> = {}) {
  const items = new Map(Object.entries(held));
  const writes: { item: KeyringItem; secret: string }[] = [];
  const keyring: SshDeps["keyring"] = {
    read: async (item) => items.get(item.account),
    write: async (item, secret) => {
      writes.push({ item, secret });
      items.set(item.account, secret);
    },
    remove: async (item) => {
      items.delete(item.account);
    },
  };
  return { items, writes, keyring };
}

describe("the key loader", () => {
  let tmp: string;
  let logs: string[];
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "majhi-ssh-test-"));
    logs = [];
  });
  afterEach(() => rm(tmp, { recursive: true, force: true }));

  const KEY_A = "/Users/o/.ssh/id_ed25519";
  const KEY_B = "/Users/o/.ssh/id_work";
  const KEY_C = "/Users/o/.ssh/id_rsa";

  /** macOS unless `keeping` says otherwise: Apple's tools, and the Keychain keeps passphrases. */
  function setup(w: World, extra: Partial<SshDeps> & { keeping?: PassphraseKeeping } = {}) {
    const { keeping = "apple", ...rest } = extra;
    const present = new Set([...Object.keys(w.keys), ...Object.keys(w.keys).map((k) => `${k}.pub`)]);
    return createSsh({
      run: fakeRun(w),
      readText: async (path) => (path === `${HOME}/.ssh/config` ? `IdentityFile ${KEY_B}\n` : undefined),
      exists: async (path) => present.has(path),
      home: HOME,
      path: "/usr/local/bin:/usr/bin:/bin",
      find: async (name) => `/usr/local/bin/${name}`,
      agent: { socket: async () => SOCK, passphrases: async () => keeping },
      keyring: fakeKeyring().keyring,
      log: (m) => logs.push(m),
      now: () => new Date("2026-09-29T10:00:00.000Z"),
      tmpRoot: tmp,
      ...rest,
    });
  }

  it("loads a key without a passphrase, skips one already loaded, and reports one that needs a passphrase", async () => {
    const w = fakeWorld({ [KEY_A]: "none", [KEY_B]: "pass", [KEY_C]: "none" }, [keyFp(KEY_C)]);
    const status = await setup(w).reload();
    expect(status).toEqual({
      loaded: 2,
      needsPassphrase: ["~/.ssh/id_work"],
      checkedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(w.calls).toContain(`${SSH_ADD} --apple-load-keychain`);
    expect(w.calls).toContain(`${SSH_ADD} ${KEY_A}`);
    expect(w.calls).not.toContain(`${SSH_ADD} ${KEY_C}`);
    expect(w.calls).not.toContain(`${SSH_ADD} ${KEY_B}`);
    // The Keychain load comes first.
    expect(w.calls.findIndex((c) => c.includes("--apple-load-keychain"))).toBeLessThan(
      w.calls.indexOf(`${SSH_ADD} ${KEY_A}`),
    );
  });

  it("logs paths and short fingerprints only, and skips an unreadable key", async () => {
    const w = fakeWorld({ [KEY_A]: "none", [KEY_B]: "broken" });
    const status = await setup(w).reload();
    expect(status.loaded).toBe(1);
    expect(status.needsPassphrase).toEqual([]);
    const text = logs.join("\n");
    expect(text).toContain("loaded ~/.ssh/id_ed25519 (ided2551)");
    expect(text).not.toContain("SHA256:");
    expect(text).not.toContain("AAAA");
  });

  it("reports an agent it cannot reach, and no socket at all", async () => {
    const w = fakeWorld({ [KEY_A]: "none" });
    w.agentDown = true;
    expect((await setup(w).reload()).error).toBe(`Cannot reach the SSH agent at ${SOCK}.`);

    const none = setup(fakeWorld({}), {
      agent: { socket: async () => undefined, passphrases: async () => "apple" },
      run: async () => fail(1),
    });
    const status = await none.reload();
    expect(status.loaded).toBe(0);
    expect(status.error).toBe("The SSH agent is not running, so there is nothing to load keys into.");
  });

  describe("unlock", () => {
    it("adds a key with its passphrase through a private askpass file and cleans up", async () => {
      const w = fakeWorld({ [KEY_B]: "pass" });
      w.unlockWith[KEY_B] = "correct horse";
      const ssh = setup(w);
      await ssh.reload();
      const status = await ssh.unlock(
        "~/.ssh/id_work".replace("~", HOME).replace(HOME, "~"),
        "correct horse",
      );
      expect(status.loaded).toBe(1);
      expect(status.needsPassphrase).toEqual([]);
      expect(w.calls).toContain(`${SSH_ADD} --apple-use-keychain ${KEY_B}`);
      expect(w.askpassSeen).toEqual([{ mode: 0o600, dirMode: 0o700, answers: ["correct horse"] }]);
      expect(await readdir(tmp)).toEqual([]);
    });

    it("says only that the passphrase did not work, and never logs it", async () => {
      const w = fakeWorld({ [KEY_B]: "pass" });
      w.unlockWith[KEY_B] = "right";
      const ssh = setup(w);
      await ssh.reload();
      const error = await ssh.unlock("~/.ssh/id_work", "wrong-phrase-123").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SshUnlockError);
      expect((error as Error).message).toBe("That passphrase did not unlock ~/.ssh/id_work.");
      // ssh-add asked again after the wrong answer, got nothing, and stopped at once.
      expect(w.askpassSeen.map((s) => s.answers)).toEqual([["wrong-phrase-123", undefined]]);
      expect(logs.join("\n")).not.toContain("wrong-phrase-123");
      expect(w.calls.join("\n")).not.toContain("wrong-phrase-123");
      expect(await readdir(tmp)).toEqual([]);
      expect((await ssh.reload()).needsPassphrase).toEqual(["~/.ssh/id_work"]);
    });

    it("does not blame the passphrase when ssh-add took it and still failed, and logs why", async () => {
      const w = fakeWorld({ [KEY_B]: "pass" });
      w.unlockWith[KEY_B] = "correct horse";
      const run: RunFn = async (file, args, options) => {
        if (options.env.SSH_ASKPASS_REQUIRE !== "force") return fakeRun(w)(file, args, options);
        // ssh-add reads the passphrase once, then the agent refuses the key.
        await ask(options, `Enter passphrase for ${KEY_B}: `);
        return fail(1, `Could not add identity "${KEY_B}": agent refused operation`);
      };
      const ssh = setup(w, { run });
      await ssh.reload();
      await expect(ssh.unlock("~/.ssh/id_work", "correct horse")).rejects.toThrow(
        "ssh-add could not load ~/.ssh/id_work. Unlock it in a terminal to see why: ssh-add --apple-use-keychain ~/.ssh/id_work",
      );
      expect(logs.join("\n")).toContain("agent refused operation");
      expect(logs.join("\n")).not.toContain("correct horse");
      expect(await readdir(tmp)).toEqual([]);
    });

    it("refuses a key that is not waiting for a passphrase", async () => {
      const w = fakeWorld({ [KEY_A]: "none", [KEY_B]: "pass" });
      const ssh = setup(w);
      await ssh.reload();
      await expect(ssh.unlock("~/.ssh/id_ed25519", "x")).rejects.toThrow(
        "~/.ssh/id_ed25519 is not waiting for a passphrase.",
      );
      await expect(ssh.unlock("/etc/passwd", "x")).rejects.toThrow("is not waiting for a passphrase");
      expect(w.calls.some((c) => c.includes("--apple-use-keychain"))).toBe(false);
    });
  });

  describe("passphrases in the keyring", () => {
    it("keeps the passphrase after an unlock and loads the key with it at the next check", async () => {
      const w = fakeWorld({ [KEY_B]: "pass" });
      w.unlockWith[KEY_B] = "correct horse";
      const held = fakeKeyring();
      const ssh = setup(w, { keeping: "keyring", keyring: held.keyring });
      await ssh.reload();
      await ssh.unlock("~/.ssh/id_work", "correct horse");
      expect(held.writes).toEqual([
        {
          item: {
            label: "majhi SSH key passphrase for ~/.ssh/id_work",
            service: "majhi ssh key",
            account: "~/.ssh/id_work",
          },
          secret: "correct horse",
        },
      ]);
      w.agent.clear(); // the agent restarted and dropped its keys
      expect(await ssh.reload()).toMatchObject({ loaded: 1, needsPassphrase: [] });
      expect(logs.join("\n")).toContain("loaded ~/.ssh/id_work (idworkAA) with its kept passphrase");
      expect(logs.join("\n")).not.toContain("correct horse");
      expect(w.calls.join("\n")).not.toContain("correct horse");
      expect(await readdir(tmp)).toEqual([]);
    });

    it("removes a kept passphrase that no longer unlocks its key, and asks for one again", async () => {
      const w = fakeWorld({ [KEY_B]: "pass" });
      w.unlockWith[KEY_B] = "new phrase";
      const held = fakeKeyring({ "~/.ssh/id_work": "old phrase" });
      const status = await setup(w, { keeping: "keyring", keyring: held.keyring }).reload();
      expect(status.needsPassphrase).toEqual(["~/.ssh/id_work"]);
      expect(held.items.size).toBe(0);
      expect(w.askpassSeen.map((s) => s.answers)).toEqual([["old phrase", undefined]]);
      expect(logs.join("\n")).toContain("no longer unlocks it, so it was removed from the keyring");
      expect(logs.join("\n")).not.toContain("old phrase");
    });

    it("keeps nothing when there is no keyring", async () => {
      const w = fakeWorld({ [KEY_B]: "pass" });
      w.unlockWith[KEY_B] = "correct horse";
      const held = fakeKeyring();
      const ssh = setup(w, { keeping: "none", keyring: held.keyring });
      await ssh.reload();
      expect((await ssh.unlock("~/.ssh/id_work", "correct horse")).loaded).toBe(1);
      expect(held.writes).toEqual([]);
      w.agent.clear();
      expect((await ssh.reload()).needsPassphrase).toEqual(["~/.ssh/id_work"]);
    });
  });
});
