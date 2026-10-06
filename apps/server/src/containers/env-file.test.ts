import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerRefused, type Safety } from "./args.ts";
import { parseEnvFile, readEnvFile } from "./env-file.ts";

const dir = mkdtempSync(join(tmpdir(), "majhi-env-file-"));
const folder = join(dir, "tasks", "ACM-1");
const safety: Safety = {
  task: "ACM-1",
  runnerNetwork: "majhi-runners",
  majhiHome: join(dir, "home", ".majhi"),
  hostHome: join(dir, "home"),
  protectedPaths: [join(dir, "keys", "secrets.key")],
  taskFolder: folder,
};

beforeAll(() => {
  mkdirSync(join(folder, "api"), { recursive: true });
  mkdirSync(join(dir, "home", ".majhi"), { recursive: true });
  writeFileSync(join(folder, "api", ".env"), "A=1\n# c\nexport B=two words\n");
  writeFileSync(join(dir, "home", ".majhi", "secrets.env"), "KEY=leak\n");
  writeFileSync(join(dir, "other.env"), "X=1\n");
  symlinkSync(join(dir, "other.env"), join(folder, "api", "link.env"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("env files", () => {
  it("reads quotes, comments and export, and skips a bare name, which would copy a value of the caller's environment", () => {
    expect(
      parseEnvFile(`A=1\n# comment\n\nexport B="x y" # note\nC='a#b'\nD=plain # trailing\nBARE\nE=\n`),
    ).toEqual(["A=1", "B=x y", "C=a#b", "D=plain", "E="]);
    expect(() => parseEnvFile("1BAD=x")).toThrow(ContainerRefused);
    expect(() => parseEnvFile("A B=x")).toThrow(ContainerRefused);
  });

  it("reads a file of the task, and refuses one outside it, through a symlink, or of majhi's", () => {
    expect(readEnvFile(".env", join(folder, "api"), safety)).toEqual(["A=1", "B=two words"]);
    for (const path of [
      join(dir, "other.env"),
      "link.env",
      "../../../other.env",
      join(dir, "home", ".majhi", "secrets.env"),
    ]) {
      try {
        readEnvFile(path, join(folder, "api"), safety);
        throw new Error(`${path} was read`);
      } catch (err) {
        expect(err).toBeInstanceOf(ContainerRefused);
        expect((err as ContainerRefused).refusal).toBe("env_file_outside");
      }
    }
  });
});
