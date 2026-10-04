import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { freshCaptainAfterUpdate } from "./fresh-after-update.ts";

describe("a captain thread after a majhi update", () => {
  it("starts fresh once per new version, and not again until the next one", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = join(dir, "captain-version");
      const fresh: string[] = [];
      const deps = (commit: string) => ({
        commit,
        file,
        chats: () => ["ACM-1", "GLX-1"],
        fresh: async (chat: string) => {
          fresh.push(`${commit} ${chat}`);
        },
      });
      expect(await freshCaptainAfterUpdate(deps("abc"))).toEqual(["ACM-1", "GLX-1"]);
      expect(await freshCaptainAfterUpdate(deps("abc"))).toEqual([]);
      expect(await freshCaptainAfterUpdate(deps("def"))).toEqual(["ACM-1", "GLX-1"]);
      expect(await freshCaptainAfterUpdate(deps("dev"))).toEqual([]);
      expect(fresh).toEqual(["abc ACM-1", "abc GLX-1", "def ACM-1", "def GLX-1"]);
      expect((await readFile(file, "utf8")).trim()).toBe("def");
    } finally {
      await cleanup();
    }
  });

  it("tries again at the next start when a refresh fails", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = join(dir, "captain-version");
      const failing = {
        commit: "abc",
        file,
        chats: () => ["ACM-1"],
        fresh: async () => Promise.reject(new Error("busy")),
      };
      await expect(freshCaptainAfterUpdate(failing)).rejects.toThrow("busy");
      expect(await readFile(file, "utf8").catch(() => "none")).toBe("none");
    } finally {
      await cleanup();
    }
  });
});
