import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshCaptainAfterUpdate } from "./fresh-after-update.ts";

describe("fresh captain sessions after an update", () => {
  it("refreshes each thread once per version, even when one thread keeps failing", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "majhi-fresh-")), "captain-version");
    const calls: string[] = [];
    const run = (commit: string) =>
      freshCaptainAfterUpdate({
        commit,
        file,
        chats: () => ["ACM-1", "BAD-1", "GLX-1"],
        fresh: async (chat) => {
          calls.push(chat);
          if (chat === "BAD-1") throw new Error("no session");
        },
      });
    expect(await run("aaa")).toEqual(["ACM-1", "GLX-1"]);
    expect(await run("aaa")).toEqual([]);
    expect(await run("aaa")).toEqual([]);
    expect(calls).toEqual(["ACM-1", "BAD-1", "GLX-1", "BAD-1", "BAD-1"]);
    expect(await run("bbb")).toEqual(["ACM-1", "GLX-1"]);
    expect(await readFile(file, "utf8")).toBe("bbb\nACM-1\nGLX-1\n");
  });

  it("does nothing for a dev build", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "majhi-fresh-")), "captain-version");
    const fresh = async () => {
      throw new Error("must not run");
    };
    expect(await freshCaptainAfterUpdate({ commit: "dev", file, chats: () => ["ACM-1"], fresh })).toEqual([]);
  });
});
