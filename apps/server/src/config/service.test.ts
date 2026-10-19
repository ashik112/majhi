import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandMeta } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { ConfigService } from "./service.ts";
import { ConfigConflictError } from "./write.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };

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
  afterEach(() => cleanup());

  it("refuses to rewrite a file with YAML errors", async () => {
    await mkdir(majhiHome);
    const broken = "workspaces: [~/Work\n";
    await writeFile(service.file, broken);
    await expect(service.setWorkspaces({ workspaces: ["~/x"] }, change())).rejects.toBeInstanceOf(
      ConfigConflictError,
    );
    expect(await readFile(service.file, "utf8")).toBe(broken);
  });
});
