import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSsh,
  discoverKeys,
  discoverPublicKeys,
  isWake,
  LAUNCHCTL,
  parseFingerprints,
  parseIdentityFiles,
  type RunFn,
  type RunResult,
  SSH_ADD,
  SSH_KEYGEN,
  type SshDeps,
  SshUnlockError,
  shortFingerprint,
} from "./ssh.ts";

const HOME = "/Users/o";
const SOCK = "/private/tmp/com.apple.launchd.x/Listeners";
const fp = (n: string) => `SHA256:${n.padEnd(43, "A")}`;

describe("parseIdentityFiles", () => {
  it("reads IdentityFile lines, expands ~ and %d, and skips what it cannot resolve", () => {
    const config = [
      "Host github",
      "  IdentityFile ~/.ssh/id_work",
      "  identityfile=~/.ssh/id_two",
      '  IdentityFile "/keys/quoted key"',
      "  IdentityFile %d/.ssh/id_pct",
      "  IdentityFile ~/.ssh/%h_key",
      "  IdentityFile ~/.ssh/id_work.pub",
      "  IdentityFile none",
      "  IdentityFile relative/key",
      "  # IdentityFile ~/.ssh/commented",
      "  IdentityFileX ~/.ssh/other",
    ].join("\n");
    expect(parseIdentityFiles(config, HOME)).toEqual([
      "/Users/o/.ssh/id_work",
      "/Users/o/.ssh/id_two",
      "/keys/quoted key",
      "/Users/o/.ssh/id_pct",
      "/Users/o/.ssh/id_work",
    ]);
  });
});

describe("discoverKeys", () => {
  it("lists config keys then default names, each once, only when the file exists", async () => {
    const files = new Set(["/Users/o/.ssh/id_work", "/Users/o/.ssh/id_ed25519", "/Users/o/.ssh/id_rsa"]);
    const keys = await discoverKeys({
      home: HOME,
      readText: async (path) =>
        path === "/Users/o/.ssh/config"
          ? "IdentityFile ~/.ssh/id_work\nIdentityFile ~/.ssh/id_ed25519\nIdentityFile ~/.ssh/gone\n"
          : undefined,
      exists: async (path) => files.has(path),
    });
    expect(keys).toEqual(["/Users/o/.ssh/id_work", "/Users/o/.ssh/id_ed25519", "/Users/o/.ssh/id_rsa"]);
  });

  it("works without an ssh config", async () => {
    const keys = await discoverKeys({
      home: HOME,
      readText: async () => undefined,
      exists: async (path) => path.endsWith("id_ecdsa"),
    });
    expect(keys).toEqual(["/Users/o/.ssh/id_ecdsa"]);
  });
});

describe("discoverPublicKeys", () => {
  it("lists .pub files that exist even when the private key is not there, and never a private path", async () => {
    const files = new Set([
      "/Users/o/.ssh/gitlab.pub",
      "/Users/o/.ssh/id_ed25519.pub",
      "/Users/o/.ssh/id_rsa",
    ]);
    const keys = await discoverPublicKeys({
      home: HOME,
      readText: async () => "Host gl\n  IdentityFile ~/.ssh/gitlab\n  IdentityFile ~/.ssh/nope\n",
      exists: async (path) => files.has(path),
    });
    expect(keys).toEqual(["/Users/o/.ssh/gitlab.pub", "/Users/o/.ssh/id_ed25519.pub"]);
    expect(keys.every((k) => k.endsWith(".pub"))).toBe(true);
  });
});

describe("fingerprints", () => {
  it("parses ssh-add and ssh-keygen output and shortens it", () => {
    const out = `256 ${fp("abc")} me@mac (ED25519)\n3072 ${fp("xyz")} work (RSA)\n`;
    expect(parseFingerprints(out)).toEqual([fp("abc"), fp("xyz")]);
    expect(parseFingerprints("The agent has no identities.\n")).toEqual([]);
    expect(shortFingerprint(fp("abcdefghij"))).toBe("abcdefgh");
  });
});

interface World {
  /** Key file -> "none" | "pass" | "broken". */
  keys: Record<string, "none" | "pass" | "broken">;
  agent: Set<string>;
  /** Passphrases the Keychain can open, by key. */
  unlockWith: Record<string, string>;
  calls: string[];
  agentDown: boolean;
  askpassSeen: { mode: number; dirMode: number; text: string }[];
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

/** ssh-add, ssh-keygen and launchctl as fakes. The real agent and Keychain are never touched. */
function fakeRun(w: World): RunFn {
  return async (file, args, options) => {
    w.calls.push([file, ...args].join(" "));
    // Nothing may prompt: askpass is off unless this is the unlock, and it always has SSH_AUTH_SOCK.
    if (file === LAUNCHCTL) return ok(`${SOCK}\n`);
    expect(options.env.SSH_AUTH_SOCK).toBe(SOCK);
    if (file === SSH_KEYGEN) {
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
    if (file === SSH_ADD) {
      if (args[0] === "-l") {
        if (w.agentDown) return fail(2, "Error connecting to agent");
        if (w.agent.size === 0) return fail(1, "The agent has no identities.");
        return ok([...w.agent].map((f) => `256 ${f} c (ED25519)`).join("\n"));
      }
      if (args[0] === "--apple-load-keychain") return ok();
      if (args[0] === "--apple-use-keychain") {
        const key = args[1] ?? "";
        expect(options.env.SSH_ASKPASS_REQUIRE).toBe("force");
        const script = options.env.SSH_ASKPASS ?? "";
        const dir = script.replace(/\/askpass\.sh$/, "");
        const secret = join(dir, "p");
        w.askpassSeen.push({
          mode: (await stat(secret)).mode & 0o777,
          dirMode: (await stat(dir)).mode & 0o777,
          text: await readFile(secret, "utf8"),
        });
        if (w.askpassSeen.at(-1)?.text === w.unlockWith[key]) {
          w.agent.add(keyFp(key));
          w.keys[key] = "none";
          return ok(`Identity added: ${key}\n`);
        }
        return fail(1, `Bad passphrase, try again for ${key}`);
      }
      // ssh-add <key>
      const key = args[0] ?? "";
      expect(options.env.SSH_ASKPASS_REQUIRE).toBe("never");
      w.agent.add(keyFp(key));
      return ok();
    }
    throw new Error(`unexpected ${file}`);
  };
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

  function setup(w: World, extra: Partial<SshDeps> = {}) {
    const present = new Set([...Object.keys(w.keys), ...Object.keys(w.keys).map((k) => `${k}.pub`)]);
    return createSsh({
      run: fakeRun(w),
      readText: async (path) => (path === `${HOME}/.ssh/config` ? `IdentityFile ${KEY_B}\n` : undefined),
      exists: async (path) => present.has(path),
      home: HOME,
      env: { PATH: "/usr/bin", SSH_AUTH_SOCK: SOCK },
      log: (m) => logs.push(m),
      now: () => new Date("2026-09-29T10:00:00.000Z"),
      tmpRoot: tmp,
      ...extra,
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
    expect(text).toContain(`SSH agent socket ${SOCK} (from the helper's environment)`);
    expect(text).not.toContain("SHA256:");
    expect(text).not.toContain("AAAA");
  });

  it("reports an agent it cannot reach, and no socket at all", async () => {
    const w = fakeWorld({ [KEY_A]: "none" });
    w.agentDown = true;
    expect((await setup(w).reload()).error).toBe(`Cannot reach the SSH agent at ${SOCK}.`);

    const none = setup(fakeWorld({}), {
      env: { PATH: "/usr/bin" },
      run: async () => fail(1),
    });
    const status = await none.reload();
    expect(status.loaded).toBe(0);
    expect(status.error).toContain("not running");
  });

  it("gets the socket from launchctl when the helper has none", async () => {
    const w = fakeWorld({ [KEY_A]: "none" });
    const status = await setup(w, { env: { PATH: "/usr/bin" } }).reload();
    expect(status.loaded).toBe(1);
    expect(logs.join("\n")).toContain(`SSH agent socket ${SOCK} (from launchctl)`);
  });

  it("in a dry run changes nothing and says what it would add", async () => {
    const w = fakeWorld({ [KEY_A]: "none", [KEY_B]: "pass" });
    const report = await setup(w, { dryRun: true }).inspect();
    expect(report.keys).toEqual([
      { path: "~/.ssh/id_work", fingerprint: "idworkAA", state: "needs-passphrase" },
      { path: "~/.ssh/id_ed25519", fingerprint: "ided2551", state: "would-add" },
    ]);
    expect(w.calls.filter((c) => c.startsWith(SSH_ADD) && !c.includes(" -l"))).toEqual([]);
    expect(w.agent.size).toBe(0);
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
      expect(w.askpassSeen).toEqual([{ mode: 0o600, dirMode: 0o700, text: "correct horse" }]);
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
      expect(logs.join("\n")).not.toContain("wrong-phrase-123");
      expect(w.calls.join("\n")).not.toContain("wrong-phrase-123");
      expect(await readdir(tmp)).toEqual([]);
      expect((await ssh.reload()).needsPassphrase).toEqual(["~/.ssh/id_work"]);
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

  it("checks at start and after a wake, not on a plain tick, and stops", async () => {
    const w = fakeWorld({ [KEY_A]: "none" });
    const ssh = setup(w);
    const loads = () => w.calls.filter((c) => c.includes("--apple-load-keychain")).length;
    let clock = 1_000_000;
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const stop = ssh.start({ tickMs: 20, now: () => clock });
    await settle();
    expect(loads()).toBe(1);
    clock += 20; // an ordinary tick: awake the whole time
    await settle();
    expect(loads()).toBe(1);
    clock += 10 * 60_000; // ten minutes passed between ticks: the Mac slept
    await settle();
    expect(loads()).toBe(2);
    stop();
    clock += 10 * 60_000;
    await settle();
    expect(loads()).toBe(2);
  });

  it("tells a wake from a normal tick", () => {
    expect(isWake(0, 60_000)).toBe(false);
    expect(isWake(0, 60_000 + 2 * 60_000)).toBe(false);
    expect(isWake(0, 60_000 + 2 * 60_000 + 1)).toBe(true);
  });
});
