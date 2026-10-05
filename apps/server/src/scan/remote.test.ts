import { describe, expect, it } from "vitest";
import { classifyHost } from "./remote.ts";

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
