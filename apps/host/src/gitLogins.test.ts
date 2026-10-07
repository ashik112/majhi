import { describe, expect, it } from "vitest";
import { detectGitLogins, readGitToken } from "./gitLogins.ts";
import type { RunFn } from "./ssh.ts";

describe("detectGitLogins", () => {
  const calls: string[] = [];
  const run: RunFn = async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`);
    if (file.endsWith("/gh")) {
      return {
        code: 0,
        stdout: "github.com\n  ✓ Logged in to github.com account acme-dev (keyring)\n",
        stderr: "",
      };
    }
    const target = args[args.length - 1];
    if (target === "git@github.com")
      return { code: 1, stdout: "", stderr: "Hi acme-dev! You've successfully authenticated" };
    if (target === "git@gh-globex")
      return { code: 1, stdout: "", stderr: "Hi globex-dev! You've successfully authenticated" };
    if (target === "git@gitlab.com") return { code: null, stdout: "", stderr: "" };
    return { code: 255, stdout: "", stderr: "Permission denied (publickey)." };
  };
  const deps = {
    run,
    readText: async () => "Host gh-globex\n  HostName github.com\n",
    home: "/Users/owner",
    path: "/usr/bin",
    socket: async () => "/tmp/agent.sock",
    find: async (name: "gh" | "glab") => (name === "gh" ? "/opt/homebrew/bin/gh" : undefined),
    ssh: "/usr/bin/ssh",
  };

  it("keeps going when a probe fails and never reads a token", async () => {
    const hosts = await detectGitLogins(deps, ["git.acme.test"]);
    expect(hosts).toEqual([
      {
        host: "github.com",
        logins: [
          { via: "gh", account: "acme-dev" },
          { via: "ssh", account: "acme-dev" },
          { via: "ssh", alias: "gh-globex", account: "globex-dev" },
        ],
      },
    ]);
    expect(calls.some((c) => c.includes("token"))).toBe(false);
  });
});

describe("readGitToken", () => {
  it("returns the token and hides the output when there is none", async () => {
    const ok: RunFn = async () => ({ code: 0, stdout: "tok-sample\n", stderr: "" });
    const base = { home: "/Users/owner", path: "/usr/bin", find: async () => "/opt/homebrew/bin/gh" };
    await expect(readGitToken({ ...base, run: ok }, "gh", "github.com")).resolves.toBe("tok-sample");
    const bad: RunFn = async () => ({ code: 1, stdout: "", stderr: "secret-looking stderr" });
    await expect(readGitToken({ ...base, run: bad }, "gh", "github.com")).rejects.toThrow(
      "gh has no login for github.com on this computer.",
    );
    await expect(readGitToken({ ...base, run: ok }, "gh", "x; rm -rf")).rejects.toThrow("not a git host");
  });
});
