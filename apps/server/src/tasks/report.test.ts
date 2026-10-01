import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReport } from "./report.ts";

describe("readReport", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-report-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the content and the modified time, or nothing before the file exists", async () => {
    expect(await readReport(dir)).toBeUndefined();
    await writeFile(join(dir, "REPORT.md"), "# Summary\n");
    const report = await readReport(dir);
    expect(report?.content).toBe("# Summary\n");
    expect(Number.isNaN(Date.parse(report?.modifiedAt ?? ""))).toBe(false);
  });

  it("refuses a REPORT.md that is a link, even to a file in the folder", async () => {
    const secret = join(dir, "secret.txt");
    await writeFile(secret, "token\n");
    await symlink(secret, join(dir, "REPORT.md"));
    await expect(readReport(dir)).rejects.toThrow(/not a link/);
  });

  it("refuses a folder named REPORT.md", async () => {
    await mkdir(join(dir, "REPORT.md"));
    await expect(readReport(dir)).rejects.toThrow(/regular file/);
  });
});
