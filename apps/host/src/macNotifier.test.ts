import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopNotifier, showNotification } from "./notify.ts";
import { type FakeProgram, failed, fakeOs, ok } from "./platform/fakeOs.ts";
import { macosPlatform } from "./platform/macos.ts";
import { NOTIFIER_STAMP, notifierApp, notifierProgram } from "./platform/majhiNotifier.ts";
import { installedProgram, type NotifierRelease } from "./platform/terminalNotifier.ts";

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
  const os = fakeOs({ home: "/Users/owner", majhiHome, exists: isFile, ...options });
  return { os, notifier: macosPlatform(os.deps, { notifierRelease: pinned }).notifier };
}

describe("a notifier that macOS has turned off", () => {
  it("is blocked on exit code 3, and nothing goes through osascript", async () => {
    const program = notifierProgram(majhiHome);
    const { os, notifier } = mac({
      programs: {
        [program]: () => failed(3, "Notifications are turned off for this application"),
        [OSASCRIPT]: () => ok(),
      },
    });
    await mkdir(join(notifierApp(majhiHome), "Contents", "MacOS"), { recursive: true });
    await writeFile(
      join(notifierApp(majhiHome), "Contents", "Info.plist"),
      `<string>${NOTIFIER_STAMP}</string>`,
    );
    await writeFile(program, "#!/bin/sh\n");

    expect(await showNotification(notifier, base, params)).toEqual({ kind: "blocked" });
    expect(os.runs.map((run) => run.file)).toEqual([program]);
  });

  it("is blocked on exit code 3 from terminal-notifier too, whatever it prints", async () => {
    const { os, notifier } = mac({
      path: "/opt/homebrew/bin:/usr/bin:/bin",
      programs: {
        "/opt/homebrew/bin/terminal-notifier": () => failed(3, "something else entirely"),
        [OSASCRIPT]: () => ok(),
      },
    });
    expect(await showNotification(notifier, base, params)).toEqual({ kind: "blocked" });
    expect(os.runs.some((run) => run.file === OSASCRIPT)).toBe(false);
  });

  it("is failed on any other exit code, from the code and not the message", async () => {
    const { os, notifier } = mac({
      path: "/opt/homebrew/bin:/usr/bin:/bin",
      programs: {
        "/opt/homebrew/bin/terminal-notifier": () => failed(1, "Notifications are turned off"),
        [OSASCRIPT]: () => ok(),
      },
    });
    expect((await showNotification(notifier, base, params)).kind).toBe("failed");
    expect(os.runs.some((run) => run.file === OSASCRIPT)).toBe(false);
  });
});

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

  it("builds the app, signs it ad hoc, checks it, and posts through it with a click", async () => {
    const { os, notifier } = withTools(() => ok("authorized"));
    await notifier.prepare?.();

    const files = os.runs.map((run) => run.file);
    expect(files).toEqual([
      "/usr/bin/xcode-select",
      "/usr/bin/swiftc",
      ...Array(9).fill("/usr/bin/sips"),
      "/usr/bin/iconutil",
      "/usr/bin/codesign",
      "/usr/bin/codesign",
      // The build's own check, then `prepare` reading the permission from the installed app.
      expect.stringContaining("majhi-notifier"),
      notifierProgram(majhiHome),
    ]);
    expect(
      os.runs.filter((run) => run.file === "/usr/bin/codesign").map((run) => run.args.slice(0, 3)),
    ).toEqual([
      ["--force", "--sign", "-"],
      ["--verify", "--strict", expect.stringContaining("majhi.app")],
    ]);
    expect(os.runs.at(-1)?.args).toEqual(["status"]);
    // Only the verified app is installed: no temporary folder is left.
    expect(await readdir(join(majhiHome, "bin"))).toEqual(["majhi-notifier"]);
    const plist = await readFile(join(notifierApp(majhiHome), "Contents", "Info.plist"), "utf8");
    expect(plist).toContain("<key>CFBundleIdentifier</key><string>dev.majhi.alerts</string>");
    expect(plist).toContain("<key>CFBundleName</key><string>majhi</string>");
    expect(plist).toContain(`<string>${NOTIFIER_STAMP}</string>`);
    expect(await readFile(notifierProgram(majhiHome), "utf8")).toBe("#!/bin/sh\n");

    os.programs.set(notifierProgram(majhiHome), () => ok());
    expect(await showNotification(notifier, base, params)).toEqual({ kind: "shown", clickable: true });
    const last = os.runs.at(-1);
    expect(last?.file).toBe(notifierProgram(majhiHome));
    expect(last?.args).toEqual([
      "post",
      "--title",
      "majhi",
      "--message",
      "ACM-12 needs approval",
      "--url",
      "http://127.0.0.1:7070/t/ACM-12",
      "--sound",
    ]);
    // terminal-notifier was never fetched, and osascript never ran.
    expect(os.deps.download).not.toHaveBeenCalled();
    expect(files.includes(OSASCRIPT)).toBe(false);
  });

  it("asks for permission with no short timeout, and reports blocked until the owner has said yes", async () => {
    // Status says not asked yet (5): `prepare` runs authorize, which waits for the owner.
    const program: FakeProgram = (args) => (args[0] === "authorize" ? ok() : failed(5));
    const { os, notifier } = withTools(program);
    os.programs.set(notifierProgram(majhiHome), program);
    await notifier.prepare?.();
    const asks = () => os.runs.filter((run) => run.args[0] === "authorize");
    await vi.waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0]?.options.timeoutMs).toBeGreaterThan(60 * 60_000);

    // An alert before the answer shows nothing, never prompts under the short timeout, and is blocked.
    expect(await showNotification(notifier, base, params)).toEqual({ kind: "blocked" });
    const posts = os.runs.filter((run) => run.args[0] === "post");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.options.timeoutMs).toBe(10_000);
    expect(os.runs.some((run) => run.file === OSASCRIPT)).toBe(false);
  });

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

  it("installs nothing when the built program does not start", async () => {
    const { os, notifier } = withTools(() => failed(139));
    await notifier.prepare?.();
    expect(os.logs.join("\n")).toContain("did not start (exit 139)");
    expect(await installed()).toEqual([]);
  });

  it("falls back to terminal-notifier, installed from the pinned release, without the Command Line Tools", async () => {
    const ditto: FakeProgram = async (args) => {
      const macos = join(args[3] ?? "", "terminal-notifier.app", "Contents", "MacOS");
      await mkdir(macos, { recursive: true });
      await writeFile(join(macos, "terminal-notifier"), "#!/bin/sh\n");
      return ok();
    };
    const download = vi.fn(async () => new Uint8Array(release));
    const { os, notifier } = mac({
      programs: {
        "/usr/bin/xcode-select": () => failed(2),
        [OSASCRIPT]: () => ok(),
        "/usr/bin/ditto": ditto,
      },
      download,
    });

    // Nothing is shown until it is installed, and nothing falls back to osascript.
    await notifier.prepare?.();
    expect((await showNotification(notifier, base, params)).kind).toBe("unavailable");
    await vi.waitFor(() => expect(os.logs.join("\n")).toContain("installed terminal-notifier 9.9.9"));
    const program = installedProgram(majhiHome);
    os.programs.set(program, () => ok());
    expect(await showNotification(notifier, base, params)).toEqual({ kind: "shown", clickable: true });
    expect(os.runs.at(-1)?.args).toContain("http://127.0.0.1:7070/t/ACM-12");
    expect(os.runs.some((run) => run.file === OSASCRIPT)).toBe(false);
    expect(download).toHaveBeenCalledTimes(1);
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

  it("opens System Settings at Notifications", async () => {
    const { os, notifier } = mac({ programs: { "/usr/bin/open": () => ok() } });
    expect(await notifier.openSettings?.()).toBe(true);
    expect(os.runs[0]?.args).toEqual([
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    ]);
  });

  it("builds and downloads nothing with MAJHI_HOST_NOTIFY=off", async () => {
    const { os, notifier } = withTools(() => ok());
    const logs: string[] = [];
    const off = desktopNotifier(false, notifier, (line) => logs.push(line));
    await off.prepare?.();
    expect(await showNotification(off, base, params)).toEqual({ kind: "shown", clickable: false });
    expect(os.runs).toEqual([]);
    expect(logs).toEqual(["notify (off): majhi: ACM-12 needs approval"]);
  });
});
