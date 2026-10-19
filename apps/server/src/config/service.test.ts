import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { ConfigService } from "./service.ts";
import { ConfigConflictError } from "./write.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };

/** What the next write of majhi.yaml does wrong, set per test. */
const crash = vi.hoisted(() => ({ mode: undefined as "halfway" | "rename" | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // A write that dies after the first half of the file reached the disk.
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [file, content] = args;
      if (crash.mode === "halfway" && String(file).endsWith(".tmp")) {
        await actual.writeFile(file, String(content).slice(0, Math.floor(String(content).length / 2)));
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.writeFile(...args);
    },
    // A swap that never happens, as when the process is killed before it.
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (crash.mode === "rename") throw new Error("killed before the swap");
      return actual.rename(...args);
    },
  };
});

function change(meta: CommandMeta = OWNER, summary = "set workspaces") {
  return { command: "workspaces.set", meta, summary };
}

describe("ConfigService.setWorkspaces", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let majhiHome: string;
  let service: ConfigService;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    majhiHome = join(dir, ".majhi");
    service = new ConfigService({ majhiHome, hostHome: dir });
  });
  afterEach(async () => {
    crash.mode = undefined;
    await cleanup();
  });

  it("refuses to rewrite a file with YAML errors", async () => {
    await mkdir(majhiHome);
    const broken = "workspaces: [~/Work\n";
    await writeFile(service.file, broken);
    await expect(service.setWorkspaces({ workspaces: ["~/x"] }, change())).rejects.toBeInstanceOf(
      ConfigConflictError,
    );
    expect(await readFile(service.file, "utf8")).toBe(broken);
  });

  it.each(["halfway", "rename"] as const)(
    "keeps the old majhi.yaml whole when a write fails (%s)",
    async (mode) => {
      await mkdir(majhiHome);
      const before = "# Acme setup\nworkspaces: [~/Work]\ntasks_dir: ~/Tasks\n";
      await writeFile(service.file, before);
      crash.mode = mode;
      await expect(service.setWorkspaces({ workspaces: ["~/x", "~/y"] }, change())).rejects.toThrow();
      crash.mode = undefined;
      expect(await readFile(service.file, "utf8")).toBe(before);
    },
  );
});
