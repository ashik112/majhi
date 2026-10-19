import { describe, expect, it } from "vitest";
import { classifyAddress, selfHostIssue } from "./self-host.ts";

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.9", "private"],
    ["100.64.0.1", "private"],
    ["169.254.169.254", "metadata"],
    ["169.254.1.1", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "link-local"],
    ["fd00:ec2::254", "metadata"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["2606:4700::1111", "public"],
  ] as const)("%s is %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it("is undefined for a name", () => {
    expect(classifyAddress("gitlab.com")).toBeUndefined();
  });
});

describe("selfHostIssue", () => {
  it("accepts a public host name, with or without a port", () => {
    expect(selfHostIssue("git.acme.test")).toBeUndefined();
    expect(selfHostIssue("git.acme.test:8443")).toBeUndefined();
    expect(selfHostIssue("203.0.114.5")).toBeUndefined();
  });

  it("refuses text that is not a bare host", () => {
    for (const host of [
      "https://git.acme.test",
      "git.acme.test/path",
      "user@git.acme.test",
      "a b",
      "",
      "git.acme.test?x=1",
    ]) {
      expect(selfHostIssue(host)).toMatchObject({ kind: "invalid" });
    }
  });
});
