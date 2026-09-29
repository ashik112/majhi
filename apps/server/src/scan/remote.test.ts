import { describe, expect, it } from "vitest";
import { parseHead, parseRemotes } from "./gitMeta.ts";
import { classifyHost, describeRemote, parseRemoteUrl } from "./remote.ts";
import { SshConfig } from "./sshConfig.ts";

describe("parseRemoteUrl", () => {
  it.each([
    ["git@github.com:acme/api.git", { ssh: true, host: "github.com" }],
    ["github-acme:acme/api.git", { ssh: true, host: "github-acme" }],
    ["ssh://git@gitlab.com:2222/acme/api.git", { ssh: true, host: "gitlab.com" }],
    ["git+ssh://bitbucket.org/acme/api.git", { ssh: true, host: "bitbucket.org" }],
    ["https://user:token@gitlab.acme.dev:8443/group/api.git", { ssh: false, host: "gitlab.acme.dev" }],
    ["ssh://git@[::1]:22/repo.git", { ssh: true, host: "::1" }],
    ["/srv/git/api.git", { ssh: false }],
    ["./relative/with:colon", { ssh: false }],
    ["file:///srv/git/api.git", { ssh: false }],
  ])("%s", (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected);
  });
});

describe("classifyHost", () => {
  it.each([
    ["github.com", "github"],
    ["ssh.github.com", "github"],
    ["GitLab.com", "gitlab"],
    ["gitlab.acme.dev", "gitlab"],
    ["altssh.bitbucket.org", "bitbucket"],
    ["git.example.com", "other"],
    ["notgithub.com", "other"],
    [undefined, "other"],
  ] as const)("%s is %s", (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe("describeRemote with ~/.ssh/config", () => {
  const ssh = SshConfig.parse(
    [
      "User git",
      "Host !*.corp *-work",
      "  HostName gitlab.work.dev",
      "Host gh gh-*",
      '  HostName "github.com"',
      "Match host foo",
      "  HostName bitbucket.org",
      "Host plain",
      "  User git",
    ].join("\n"),
  );

  it("resolves aliases, wildcards and negation the way ssh does", () => {
    expect(describeRemote("o", "git@gh-acme:a/b.git", ssh)).toEqual({
      name: "o",
      url: "git@gh-acme:a/b.git",
      host: "github",
      sshAlias: "gh-acme",
    });
    expect(describeRemote("o", "ssh://git@acme-work/a/b.git", ssh)).toMatchObject({
      host: "gitlab",
      sshAlias: "acme-work",
    });
    expect(describeRemote("o", "git@x-work.corp:a/b.git", ssh)).not.toHaveProperty("sshAlias");
  });

  it("ignores ssh config for https remotes and hosts without HostName", () => {
    expect(describeRemote("o", "https://gh/a/b.git", ssh)).toEqual({
      name: "o",
      url: "https://gh/a/b.git",
      host: "other",
    });
    expect(describeRemote("o", "plain:a/b.git", ssh)).not.toHaveProperty("sshAlias");
  });
});

describe("git metadata", () => {
  it("reads remotes from .git/config with quoting, comments and the old section form", () => {
    const config = [
      "[core]",
      "\turl = not-a-remote",
      '[remote "origin"]',
      "\turl = git@github.com:acme/api.git ; trailing comment",
      "\turl = git@github.com:acme/second-url-ignored.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[remote "with space"]',
      '\tURL = "https://gitlab.com/acme/has#hash.git"',
      "[remote.legacy]",
      "\turl = https://bitbucket.org/acme/legacy.git",
      '[remote "empty"]',
      "\tfetch = x",
    ].join("\n");
    expect(parseRemotes(config)).toEqual([
      { name: "origin", url: "git@github.com:acme/api.git" },
      { name: "with space", url: "https://gitlab.com/acme/has#hash.git" },
      { name: "legacy", url: "https://bitbucket.org/acme/legacy.git" },
    ]);
  });

  it("reads the branch from HEAD, and none when detached", () => {
    expect(parseHead("ref: refs/heads/feature/x-1\n")).toBe("feature/x-1");
    expect(parseHead("3f786850e387550fdab836ed7e6dc881de23001b\n")).toBeUndefined();
  });
});
