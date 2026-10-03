import { describe, expect, it } from "vitest";
import {
  detectGitLogins,
  parseAuthStatus,
  parseGreeting,
  parseSshAliases,
  readGitToken,
} from "./gitLogins.ts";
import type { RunFn } from "./ssh.ts";

describe("parseGreeting", () => {
  it("reads the account from each host's greeting", () => {
    expect(
      parseGreeting(
        "Hi ashik-sample! You've successfully authenticated, but GitHub does not provide shell access.",
      ),
    ).toBe("ashik-sample");
    expect(parseGreeting("Welcome to GitLab, @acme-dev!")).toBe("acme-dev");
    expect(parseGreeting("logged in as globex-ci.\n\nYou can use git to connect to Bitbucket.")).toBe(
      "globex-ci",
    );
  });

  it("gives nothing for a refusal or a connection failure", () => {
    expect(parseGreeting("git@github.com: Permission denied (publickey).")).toBeUndefined();
    expect(
      parseGreeting("ssh: Could not resolve hostname nope: nodename nor servname provided"),
    ).toBeUndefined();
    expect(parseGreeting("ssh: connect to host gitlab.com port 22: Connection timed out")).toBeUndefined();
    expect(parseGreeting("")).toBeUndefined();
  });
});

describe("parseAuthStatus", () => {
  it("lists the accounts per host for gh and glab", () => {
    const gh =
      "github.com\n  ✓ Logged in to github.com account acme-dev (keyring)\n  - Active account: true\n";
    expect(parseAuthStatus(gh)).toEqual([{ host: "github.com", account: "acme-dev" }]);
    const glab =
      "gitlab.example.com\n  ✓ Logged in to gitlab.example.com as globex-ci (/Users/owner/.config/glab-cli/config.yml)";
    expect(parseAuthStatus(glab)).toEqual([{ host: "gitlab.example.com", account: "globex-ci" }]);
    expect(parseAuthStatus("You are not logged into any GitHub hosts.")).toEqual([]);
  });
});

describe("parseSshAliases", () => {
  it("pairs aliases with their host name and skips wildcards", () => {
    const text =
      "Host *\n  User git\nHost gh-acme gh-alt\n  HostName GitHub.com\nHost gl-globex\n  HostName gitlab.com\n";
    expect(parseSshAliases(text)).toEqual([
      { alias: "gh-acme", hostName: "github.com" },
      { alias: "gh-alt", hostName: "github.com" },
      { alias: "gl-globex", hostName: "gitlab.com" },
    ]);
  });
});

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
