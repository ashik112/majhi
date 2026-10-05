import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../testing/fixtures.ts";
import { checkPlace, isInside, projectPlace } from "./paths.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("the clone path rule", () => {
  const roots = ["/home/owner/Work", "~/Clients"];
  const hostHome = "/home/owner";

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
});
