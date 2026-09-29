import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyProbe, probeHosts, SshHostProbe, type SshRun, sshTargetOf, sshTargets } from "./hosts.ts";

describe("sshTargetOf", () => {
  it("keeps the alias or user@host of ssh remotes, and skips the rest", () => {
    expect(sshTargetOf("gitlab-ashik112:group/repo.git")).toBe("gitlab-ashik112");
    expect(sshTargetOf("git@github.com:o/r.git")).toBe("git@github.com");
    expect(sshTargetOf("ssh://git@host.test:2222/o/r.git")).toBe("git@host.test");
    expect(sshTargetOf("ssh://host.test/o/r.git")).toBe("host.test");
    expect(sshTargetOf("https://github.com/o/r.git")).toBeUndefined();
    expect(sshTargetOf("/srv/git/r.git")).toBeUndefined();
    expect(sshTargetOf("../r.git")).toBeUndefined();
  });
});

describe("classifyProbe", () => {
  const out = (code: number | null, output: string): SshRun => ({ code, output });
  it("tells reachable, auth failed and unreachable apart, with fixed sentences", () => {
    expect(classifyProbe(out(0, "Welcome to GitLab, @me!")).state).toBe("reachable");
    expect(classifyProbe(out(1, "Hi me! You've successfully authenticated")).state).toBe("reachable");
    const denied = classifyProbe(out(255, "git@gitlab.com: Permission denied (publickey)."));
    expect(denied).toEqual({ state: "auth-failed", detail: "The host did not accept any key ssh offered." });
    expect(classifyProbe(out(255, "ssh: Could not resolve hostname x")).state).toBe("unreachable");
    expect(classifyProbe(out(255, "Connection timed out during banner exchange")).state).toBe("unreachable");
    expect(classifyProbe(out(null, "")).state).toBe("unreachable");
  });

  it("never returns ssh's own text", () => {
    const secret = "SHA256:abcdefSECRETlooking";
    for (const code of [0, 255, null]) {
      const r = classifyProbe(out(code, `Offering public key ${secret} Permission denied`));
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  });
});

describe("probeHosts and the cache", () => {
  it("runs ssh -T with BatchMode and a 5 s connect timeout against each target", async () => {
    const calls: string[][] = [];
    const results = await probeHosts(["a", "git@b"], async (args) => {
      calls.push([...args]);
      return { code: 255, output: "Permission denied (publickey)." };
    });
    expect(calls).toEqual([
      ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "a"],
      ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "git@b"],
    ]);
    expect(results.map((r) => [r.host, r.state])).toEqual([
      ["a", "auth-failed"],
      ["git@b", "auth-failed"],
    ]);
  });

  it("caches results and refreshes when they are old", async () => {
    let now = 0;
    let runs = 0;
    const probe = new SshHostProbe(
      async () => ["a"],
      async () => {
        runs++;
        return { code: 0, output: "" };
      },
      1000,
      () => now,
    );
    expect(await probe.refresh()).toHaveLength(1);
    now = 500;
    expect(probe.cached()).toHaveLength(1);
    expect(runs).toBe(1);
    now = 2000;
    probe.cached();
    await probe.refresh();
    expect(runs).toBe(2);
  });
});

describe("sshTargets", () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));
  it("reads each project's remotes and lists every ssh target once", async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-targets-"));
    const repo = async (name: string, urls: string[]) => {
      await mkdir(join(dir, name, ".git"), { recursive: true });
      const text = urls.map((u, i) => `[remote "r${i}"]\n\turl = ${u}\n`).join("");
      await writeFile(join(dir, name, ".git", "config"), text);
      return join(dir, name);
    };
    const a = await repo("a", ["gitlab-ashik112:g/a.git", "https://github.com/o/a.git"]);
    const b = await repo("b", ["gitlab-ashik112:g/b.git", "git@github.com:o/b.git"]);
    expect(await sshTargets([a, b, join(dir, "missing")])).toEqual(["git@github.com", "gitlab-ashik112"]);
  });
});
