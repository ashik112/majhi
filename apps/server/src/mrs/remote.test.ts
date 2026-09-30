import { describe, expect, it } from "vitest";
import { hostNameOf, mrHostOf, mrRemoteName, repoSlug, rewriteRemoteUrl } from "./remote.ts";

describe("rewriteRemoteUrl", () => {
  it("sends an scp-like URL through the alias", () => {
    expect(rewriteRemoteUrl("git@github.com:acme/api.git", "github-acme")).toBe(
      "git@github-acme:acme/api.git",
    );
  });

  it("sends an https URL through the alias, as the git user", () => {
    expect(rewriteRemoteUrl("https://github.com/acme/api.git", "github-acme")).toBe(
      "git@github-acme:acme/api.git",
    );
  });

  it("keeps the user of an ssh:// URL and drops its port", () => {
    expect(rewriteRemoteUrl("ssh://deploy@gitlab.acme.dev:2222/team/web.git", "gitlab-acme")).toBe(
      "deploy@gitlab-acme:team/web.git",
    );
  });

  it("keeps the whole path of nested groups", () => {
    expect(rewriteRemoteUrl("git@gitlab.com:acme/platform/web.git", "gl")).toBe(
      "git@gl:acme/platform/web.git",
    );
  });

  it("leaves a URL that already uses the alias", () => {
    expect(rewriteRemoteUrl("git@github-acme:acme/api.git", "github-acme")).toBe(
      "git@github-acme:acme/api.git",
    );
  });

  it("leaves local paths and file URLs, and does nothing without an alias", () => {
    expect(rewriteRemoteUrl("/tmp/remotes/api.git", "github-acme")).toBe("/tmp/remotes/api.git");
    expect(rewriteRemoteUrl("file:///tmp/remotes/api.git", "github-acme")).toBe(
      "file:///tmp/remotes/api.git",
    );
    expect(rewriteRemoteUrl("git@github.com:acme/api.git", undefined)).toBe("git@github.com:acme/api.git");
  });
});

describe("repoSlug", () => {
  it("reads owner and repo from every URL form", () => {
    expect(repoSlug("git@github.com:acme/api.git")).toBe("acme/api");
    expect(repoSlug("https://github.com/acme/api")).toBe("acme/api");
    expect(repoSlug("ssh://git@gitlab.com/acme/platform/web.git")).toBe("acme/platform/web");
    expect(repoSlug("/tmp/remotes/acme/api.git")).toBe("acme/api");
  });
});

describe("mrRemoteName and mrHostOf", () => {
  it("picks the remote marked mr, else origin", () => {
    expect(mrRemoteName({ origin: {}, fork: { mr: true } })).toBe("fork");
    expect(mrRemoteName({ origin: {} })).toBe("origin");
    expect(mrRemoteName(undefined)).toBe("origin");
  });

  it("takes the host from majhi.yaml, then the URL, then the alias", () => {
    expect(mrHostOf({ host: "gitlab" }, "git@github.com:a/b.git")).toBe("gitlab");
    expect(mrHostOf({}, "git@gitlab.acme.dev:a/b.git")).toBe("gitlab");
    expect(mrHostOf({ ssh: "bitbucket-acme" }, "git@work:a/b.git")).toBe("bitbucket");
    expect(mrHostOf({}, "/tmp/x.git")).toBeUndefined();
  });

  it("names the host of a URL", () => {
    expect(hostNameOf("git@gitlab.acme.dev:a/b.git")).toBe("gitlab.acme.dev");
    expect(hostNameOf("/tmp/x.git")).toBeUndefined();
  });
});
