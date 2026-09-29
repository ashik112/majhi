import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, gitEnv } from "./git.ts";

describe("majhi's own git", () => {
  let dir: string;
  const saved = { sock: process.env.SSH_AUTH_SOCK, ssh: process.env.GIT_SSH_COMMAND };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-git-env-"));
  });
  afterEach(async () => {
    for (const [name, value] of [
      ["SSH_AUTH_SOCK", saved.sock],
      ["GIT_SSH_COMMAND", saved.ssh],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the SSH agent socket and turns prompts off", () => {
    const env = gitEnv({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/ssh-agent.sock" });
    expect(env).toMatchObject({
      SSH_AUTH_SOCK: "/run/ssh-agent.sock",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
  });

  it("hands the socket to ssh when it fetches", async () => {
    const seen = join(dir, "seen");
    const probe = join(dir, "ssh-probe.sh");
    await writeFile(probe, `#!/bin/sh\nprintf '%s' "$SSH_AUTH_SOCK" > '${seen}'\nexit 1\n`);
    await chmod(probe, 0o755);
    process.env.SSH_AUTH_SOCK = "/run/ssh-agent.sock";
    process.env.GIT_SSH_COMMAND = probe;
    await git(dir, ["init", "-q"]);
    await expect(git(dir, ["fetch", "ssh://git@example.test/x.git"])).rejects.toThrow();
    expect(await readFile(seen, "utf8")).toBe("/run/ssh-agent.sock");
  });
});
