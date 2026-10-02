import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../testing/fixtures.ts";
import { remoteKey, repoKeyOf } from "./here.ts";
import { checkPlace, isInside, projectIdFor, projectPlace } from "./paths.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("the clone path rule", () => {
  const roots = ["/home/owner/Work", "~/Clients"];
  const hostHome = "/home/owner";

  it("puts a repo at <first root>/<workspace>/<repo>, Private under private", () => {
    expect(projectPlace({ roots, hostHome, org: "acme", folder: "api" })).toEqual({
      root: "/home/owner/Work",
      parent: "/home/owner/Work/acme",
      path: "/home/owner/Work/acme/api",
    });
    expect(projectPlace({ roots, hostHome, org: "private", folder: "notes" }).path).toBe(
      "/home/owner/Work/private/notes",
    );
  });

  it("takes a second root only when it is one of the configured roots, written either way", () => {
    expect(projectPlace({ roots, hostHome, root: "~/Clients", org: "globex", folder: "web" }).path).toBe(
      "/home/owner/Clients/globex/web",
    );
    expect(
      projectPlace({ roots, hostHome, root: "/home/owner/Clients/", org: "globex", folder: "web" }).root,
    ).toBe("/home/owner/Clients");
    expect(() => projectPlace({ roots, hostHome, root: "/tmp", org: "globex", folder: "web" })).toThrow(
      /not one of the project folders/,
    );
  });

  it("refuses folder names that leave the workspace folder", () => {
    for (const folder of ["..", "../x", "a/b", ".hidden", ""]) {
      expect(() => projectPlace({ roots, hostHome, org: "acme", folder }), folder).toThrow();
    }
    expect(() => projectPlace({ roots: [], hostHome, org: "acme", folder: "api" })).toThrow(
      /Pick a project folder/,
    );
  });

  it("refuses a target that is not empty, and a workspace folder that is itself a repo", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const place = projectPlace({ roots: [t.dir], hostHome: t.dir, org: "acme", folder: "api" });
    expect(await checkPlace(place)).toBe("missing");
    await mkdir(place.path, { recursive: true });
    expect(await checkPlace(place)).toBe("empty");
    await writeFile(join(place.path, "x.txt"), "x");
    await expect(checkPlace(place)).rejects.toThrow(/already exists and is not empty/);
    const nested = projectPlace({ roots: [t.dir], hostHome: t.dir, org: "globex", folder: "api" });
    await makeRepo(nested.parent);
    await expect(checkPlace(nested)).rejects.toThrow(/is itself a git repo/);
  });

  it("checks containment on resolved paths", () => {
    expect(isInside("/r", "/r/a/b")).toBe(true);
    expect(isInside("/r", "/r/../etc")).toBe(false);
    expect(isInside("/r", "/rx/a")).toBe(false);
  });

  it("makes a project id unique", () => {
    expect(projectIdFor("Api.Server", new Set())).toBe("api-server");
    expect(projectIdFor("api", new Set(["api", "api-2"]))).toBe("api-3");
  });
});

describe("remote keys", () => {
  const aliases = new Map([["github-acme", "github.com"]]);

  it("matches https and ssh forms, aliases, case, ports and .git", () => {
    const key = repoKeyOf("github.com", "Acme/API");
    for (const url of [
      "https://github.com/acme/api.git",
      "https://GitHub.com/Acme/api",
      "git@github.com:acme/api.git",
      "git@github-acme:acme/api.git",
      "ssh://git@github.com:22/acme/api.git",
      "https://x-access-token@github.com/acme/api.git",
    ]) {
      expect(remoteKey(url, aliases), url).toBe(key);
    }
    expect(remoteKey("https://github.com/acme/web.git", aliases)).not.toBe(key);
    expect(remoteKey("/home/owner/remotes/api.git", aliases)).toBeUndefined();
    expect(repoKeyOf("gitlab.acme.test:8443", "group/sub/api")).toBe(
      remoteKey("https://gitlab.acme.test:8443/group/sub/api.git", aliases),
    );
  });
});
