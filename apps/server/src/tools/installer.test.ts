import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolInstaller, verifiedBin } from "./installer.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function setup(
  files: Record<string, Buffer | string | { redirect: string }>,
  hosts: Record<string, string[]> = {},
) {
  const home = mkdtempSync(join(tmpdir(), "majhi-tools-"));
  const asked: string[] = [];
  const installer = new ToolInstaller({
    majhiHome: home,
    cpu: "arm64",
    lookup: async (h) => hosts[h] ?? ["93.184.216.34"],
    fetch: async (url) => {
      asked.push(url);
      const f = files[url];
      if (f === undefined) return new Response("no", { status: 404 });
      if (typeof f === "object" && "redirect" in f) {
        return new Response(null, { status: 302, headers: { location: f.redirect } });
      }
      return new Response(typeof f === "string" ? f : new Uint8Array(f));
    },
  });
  return { home, installer, asked };
}

const PROGRAM = "#!/bin/sh\necho tool 1.0\n";

describe("toolbox installs", () => {
  it("installs nothing when the checksum does not match", async () => {
    const t = setup({ "https://dl.acme.example/tool": PROGRAM });
    await expect(
      t.installer.install("acme", {
        name: "acmectl",
        url: "https://dl.acme.example/tool",
        sha256: sha("something else"),
        archive: "binary",
      }),
    ).rejects.toThrow();
    expect(existsSync(join(t.home, "tools", "acme", "bin", "acmectl"))).toBe(false);
    expect(existsSync(join(verifiedBin(t.home, "acme"), "acmectl"))).toBe(false);
    expect((await t.installer.list("acme")).tools).toEqual([]);
  });
});
