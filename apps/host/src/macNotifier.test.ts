import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showNotification } from "./notify.ts";
import { type FakeProgram, failed, fakeOs, ok } from "./platform/fakeOs.ts";
import { macosPlatform } from "./platform/macos.ts";
import type { NotifierRelease } from "./platform/terminalNotifier.ts";

const base = "http://127.0.0.1:7070";
const params = { title: "majhi", message: "ACM-12 needs approval", path: "/t/ACM-12", sound: true };
const OSASCRIPT = "/usr/bin/osascript";
const release = Buffer.from("a terminal-notifier release");
const pinned: NotifierRelease = {
  version: "9.9.9",
  url: "https://downloads.example/terminal-notifier.zip",
  sha256: createHash("sha256").update(release).digest("hex"),
};

let majhiHome: string;
const isFile = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
beforeEach(async () => {
  majhiHome = await mkdtemp(join(tmpdir(), "majhi-notifier-"));
});
afterEach(async () => {
  await rm(majhiHome, { recursive: true, force: true });
});

function mac(options: Parameters<typeof fakeOs>[0] = {}) {
  // The fake programs count as installed, so the test does not depend on the machine running it being a Mac.
  const exists = (path: string) =>
    options.programs?.[path] !== undefined ? Promise.resolve(true) : isFile(path);
  const os = fakeOs({ home: "/Users/owner", majhiHome, exists, ...options });
  return { os, notifier: macosPlatform(os.deps, { notifierRelease: pinned }).notifier };
}

describe("majhi's own notifier on macOS", () => {
  /** What the build left in bin: nothing, unless a verified app was installed. */
  const installed = async () =>
    (await readdir(join(majhiHome, "bin"))).filter((n) => n.includes("majhi-notifier"));

  const swiftc = (os: ReturnType<typeof fakeOs>, status: FakeProgram): FakeProgram => {
    return async (args) => {
      const out = args[args.indexOf("-o") + 1] ?? "";
      await writeFile(out, "#!/bin/sh\n");
      os.programs.set(out, status);
      return ok();
    };
  };

  /** A Mac with the Command Line Tools: every program the build runs is there. */
  function withTools(status: FakeProgram, options: { verify?: number } = {}) {
    const holder: { os?: ReturnType<typeof fakeOs> } = {};
    const programs: Record<string, FakeProgram> = {
      "/usr/bin/xcode-select": () => ok("/Library/Developer/CommandLineTools\n"),
      "/usr/bin/swiftc": (args, run) =>
        holder.os === undefined ? failed() : swiftc(holder.os, status)(args, run),
      "/usr/bin/sips": () => ok(),
      "/usr/bin/iconutil": async (args) => {
        await writeFile(args[args.indexOf("-o") + 1] ?? "", "icns");
        return ok();
      },
      "/usr/bin/codesign": (args) =>
        args[0] === "--verify" ? { code: options.verify ?? 0, stdout: "", stderr: "" } : ok(),
      [OSASCRIPT]: () => ok(),
    };
    const made = mac({ programs, download: vi.fn(async () => new Uint8Array(release)) });
    holder.os = made.os;
    return made;
  }

  it("installs nothing when the signature does not verify, and tries again only after an hour", async () => {
    const { os, notifier } = withTools(() => ok(), { verify: 1 });
    await notifier.prepare?.();
    expect(os.logs.join("\n")).toContain("ad-hoc signature did not verify");
    expect(await installed()).toEqual([]);
    const swiftcRuns = () => os.runs.filter((run) => run.file === "/usr/bin/swiftc").length;
    expect(swiftcRuns()).toBe(1);

    // The next notification does not build again; it uses terminal-notifier's install instead.
    expect((await showNotification(notifier, base, params)).kind).toBe("unavailable");
    expect(swiftcRuns()).toBe(1);
  });

  it("never installs a terminal-notifier download whose hash does not match", async () => {
    const download = vi.fn(async () => new Uint8Array(Buffer.from("something else")));
    const { os, notifier } = mac({ programs: { "/usr/bin/xcode-select": () => failed(2) }, download });
    await notifier.prepare?.();
    expect((await showNotification(notifier, base, params)).kind).toBe("unavailable");
    await vi.waitFor(() => expect(os.logs.join("\n")).toContain("did not match its pinned SHA-256"));
    expect((await showNotification(notifier, base, params)).kind).toBe("unavailable");
    expect(download).toHaveBeenCalledTimes(1);
    expect(await readdir(majhiHome)).toEqual([]);
  });
});
