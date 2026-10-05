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
import { archOf, checksumFor, expandUrl, ToolInstaller, verifiedBin } from "./installer.ts";

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
      return new Response(f);
    },
  });
  return { home, installer, asked };
}

const PROGRAM = "#!/bin/sh\necho tool 1.0\n";

describe("toolbox installs", () => {
  it("installs a binary whose checksum matches into the checked folder and the workspace's tools folder", async () => {
    const t = setup({ "https://dl.acme.example/tool-arm64": PROGRAM });
    const entry = await t.installer.install("acme", {
      name: "acmectl",
      url: "https://dl.acme.example/tool-{arch}",
      sha256: sha(PROGRAM),
      archive: "binary",
    });
    expect(entry).toMatchObject({ name: "acmectl", sha256: sha(PROGRAM), verifiedBy: "given" });
    for (const path of [
      join(verifiedBin(t.home, "acme"), "acmectl"),
      join(t.home, "tools", "acme", "bin", "acmectl"),
    ]) {
      expect(readFileSync(path, "utf8")).toBe(PROGRAM);
      expect(statSync(path).mode & 0o111).not.toBe(0);
    }
    const listed = await t.installer.list("acme");
    expect(listed.arch).toEqual({ arch: "arm64", machine: "aarch64" });
    expect(listed.tools.map((x) => x.name)).toEqual(["acmectl"]);
    // The record is not in the folder a run can write to.
    expect(existsSync(join(t.home, "tools", "acme", "installed.json"))).toBe(false);
  });

  it("installs nothing when the checksum does not match", async () => {
    const t = setup({ "https://dl.acme.example/tool": PROGRAM });
    await expect(
      t.installer.install("acme", {
        name: "acmectl",
        url: "https://dl.acme.example/tool",
        sha256: sha("something else"),
        archive: "binary",
      }),
    ).rejects.toThrow(/Nothing was installed/);
    expect(existsSync(join(t.home, "tools", "acme", "bin", "acmectl"))).toBe(false);
    expect(existsSync(join(verifiedBin(t.home, "acme"), "acmectl"))).toBe(false);
    expect((await t.installer.list("acme")).tools).toEqual([]);
  });

  it("reads the hash from the vendor's checksums file by file name", async () => {
    const t = setup({
      "https://dl.acme.example/v1/tool-linux": PROGRAM,
      "https://dl.acme.example/v1/checksums.txt": `${"0".repeat(64)}  other-file\n${sha(PROGRAM)}  tool-linux\n`,
    });
    const entry = await t.installer.install("acme", {
      name: "acmectl",
      url: "https://dl.acme.example/v1/tool-linux",
      checksumUrl: "https://dl.acme.example/v1/checksums.txt",
      archive: "binary",
    });
    expect(entry.verifiedBy).toBe("checksum-file");
    const none = setup({
      "https://dl.acme.example/v1/tool-linux": PROGRAM,
      "https://dl.acme.example/v1/checksums.txt": `${sha(PROGRAM)}  another-file\n`,
    });
    await expect(
      none.installer.install("acme", {
        name: "acmectl",
        url: "https://dl.acme.example/v1/tool-linux",
        checksumUrl: "https://dl.acme.example/v1/checksums.txt",
        archive: "binary",
      }),
    ).rejects.toThrow(/no SHA-256 for tool-linux/);
    // The program itself was never fetched when its checksum could not be found.
    expect(none.asked).toEqual(["https://dl.acme.example/v1/checksums.txt"]);
  });

  it("refuses http, hosts on this machine's network, and a redirect to one", async () => {
    const t = setup(
      {
        "https://dl.acme.example/a": { redirect: "https://internal.acme.example/a" },
        "http://dl.acme.example/a": PROGRAM,
        "https://internal.acme.example/a": PROGRAM,
      },
      { "internal.acme.example": ["10.0.0.7"] },
    );
    const base = { name: "acmectl", sha256: sha(PROGRAM), archive: "binary" as const };
    await expect(t.installer.install("acme", { ...base, url: "http://dl.acme.example/a" })).rejects.toThrow(
      /https only/,
    );
    await expect(t.installer.install("acme", { ...base, url: "https://dl.acme.example/a" })).rejects.toThrow(
      /this machine's network/,
    );
    await expect(t.installer.install("acme", { ...base, url: "https://127.0.0.1/a" })).rejects.toThrow(
      /this machine's network/,
    );
    expect(t.asked).toEqual(["https://dl.acme.example/a"]);
  });

  it("takes the program out of a tar.gz, and refuses a link in it", async () => {
    const work = mkdtempSync(join(tmpdir(), "majhi-tar-"));
    mkdirSync(join(work, "pkg"));
    writeFileSync(join(work, "pkg", "acmectl"), PROGRAM);
    symlinkSync("/etc/hosts", join(work, "pkg", "evil"));
    const pack = spawnSync("tar", [
      "-czf",
      join(work, "tool.tgz"),
      "-C",
      join(work, "pkg"),
      "acmectl",
      "evil",
    ]);
    expect(pack.status).toBe(0);
    const archive = readFileSync(join(work, "tool.tgz"));
    const t = setup({ "https://dl.acme.example/tool.tgz": archive });
    const base = {
      url: "https://dl.acme.example/tool.tgz",
      sha256: sha(archive),
      archive: "tar.gz" as const,
    };
    const ok = await t.installer.install("acme", { ...base, name: "acmectl" });
    expect(ok.bytes).toBe(PROGRAM.length);
    expect(readFileSync(join(t.home, "tools", "acme", "bin", "acmectl"), "utf8")).toBe(PROGRAM);
    await expect(t.installer.install("acme", { ...base, name: "evil", path: "evil" })).rejects.toThrow(
      /not a plain file/,
    );
    expect(existsSync(join(t.home, "tools", "acme", "bin", "evil"))).toBe(false);
  });

  it("removes a tool from both folders and the record", async () => {
    const t = setup({ "https://dl.acme.example/tool": PROGRAM });
    await t.installer.install("acme", {
      name: "acmectl",
      url: "https://dl.acme.example/tool",
      sha256: sha(PROGRAM),
      archive: "binary",
    });
    await t.installer.remove("acme", "acmectl");
    expect(existsSync(join(t.home, "tools", "acme", "bin", "acmectl"))).toBe(false);
    expect(existsSync(join(verifiedBin(t.home, "acme"), "acmectl"))).toBe(false);
    expect((await t.installer.list("acme")).tools).toEqual([]);
  });

  it("refuses a workspace id that would leave the tools folder", async () => {
    const t = setup({});
    await expect(t.installer.list("../etc")).rejects.toThrow(/workspace id/);
  });
});

describe("helpers", () => {
  it("picks the CPU and fills the URL", () => {
    expect(archOf("x64")).toEqual({ arch: "amd64", machine: "x86_64" });
    expect(archOf("arm64")).toEqual({ arch: "arm64", machine: "aarch64" });
    expect(expandUrl("https://x/{machine}/{arch}", archOf("arm64"))).toBe("https://x/aarch64/arm64");
  });

  it("reads a checksums file", () => {
    const h = "a".repeat(64);
    expect(checksumFor(`${h}\n`, "x")).toBe(h);
    expect(checksumFor(`${h} *dist/x.tgz\n${"b".repeat(64)}  y.tgz`, "x.tgz")).toBe(h);
    expect(checksumFor(`${h}  y.tgz`, "x.tgz")).toBeUndefined();
  });
});
