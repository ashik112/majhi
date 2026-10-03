import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickUrl, desktopNotifier, plainLine, showNotification } from "./notify.ts";
import { type FakeProgram, failed, fakeOs, ok } from "./platform/fakeOs.ts";
import { linuxPlatform } from "./platform/linux.ts";
import { macosPlatform, notificationScript } from "./platform/macos.ts";
import { installedProgram, type NotifierRelease } from "./platform/terminalNotifier.ts";
import { POWERSHELL_APP_ID } from "./platform/toast.ts";
import { wslPlatform } from "./platform/wsl.ts";

describe("notificationScript", () => {
  it("escapes quotes and backslashes and drops line breaks, so a message cannot add a command", () => {
    const script = notificationScript('run "x"\n& do shell script "rm -rf ~" \\', { title: 'a"b' });
    expect(script).toBe(
      'display notification "run \\"x\\" & do shell script \\"rm -rf ~\\" \\\\" with title "a\\"b"',
    );
    expect(script.includes("\n")).toBe(false);
  });
});

describe("clickUrl", () => {
  it("joins a path to majhi's address and refuses anything else", () => {
    expect(clickUrl("http://127.0.0.1:7070", "/t/ACM-12")).toBe("http://127.0.0.1:7070/t/ACM-12");
    expect(clickUrl("http://127.0.0.1:7070", "//evil.example/x")).toBeUndefined();
    expect(clickUrl("http://127.0.0.1:7070", "https://evil.example")).toBeUndefined();
    expect(clickUrl("http://127.0.0.1:7070", undefined)).toBeUndefined();
  });
});

describe("showNotification on macOS", () => {
  const base = "http://127.0.0.1:7070";
  const params = { title: "majhi", message: "ACM-12 needs approval", path: "/t/ACM-12" };

  it("opens majhi on click through terminal-notifier when it is installed", async () => {
    const os = fakeOs({
      home: "/Users/owner",
      path: "/opt/homebrew/bin:/usr/bin:/bin",
      programs: { "/opt/homebrew/bin/terminal-notifier": () => ok(), "/usr/bin/osascript": () => ok() },
    });
    const out = await showNotification(macosPlatform(os.deps).notifier, base, { ...params, sound: false });
    expect(out.clickable).toBe(true);
    expect(os.runs[0]?.file).toBe("/opt/homebrew/bin/terminal-notifier");
    expect(os.runs[0]?.args).toContain("http://127.0.0.1:7070/t/ACM-12");
  });

  it("falls back to osascript without a click", async () => {
    const os = fakeOs({ home: "/Users/owner", programs: { "/usr/bin/osascript": () => ok() } });
    const out = await showNotification(macosPlatform(os.deps).notifier, base, { ...params, sound: true });
    expect(out.clickable).toBe(false);
    expect(os.runs[0]?.file).toBe("/usr/bin/osascript");
    expect(os.runs[0]?.args[1]).toContain('sound name "Glass"');
  });
});

describe("majhi's own terminal-notifier on macOS", () => {
  const base = "http://127.0.0.1:7070";
  const params = { title: "majhi", message: "ACM-12 needs approval", path: "/t/ACM-12", sound: true };
  const release = Buffer.from("a terminal-notifier release");
  const pinned: NotifierRelease = {
    version: "9.9.9",
    url: "https://downloads.example/terminal-notifier.zip",
    sha256: createHash("sha256").update(release).digest("hex"),
  };
  let majhiHome: string;

  beforeEach(async () => {
    majhiHome = await mkdtemp(join(tmpdir(), "majhi-notifier-"));
  });
  afterEach(async () => {
    await rm(majhiHome, { recursive: true, force: true });
  });

  /** `ditto -x -k <zip> <dir>`: unpacks the app bundle, as the real release holds it. */
  const ditto: FakeProgram = async (args) => {
    const macos = join(args[3] ?? "", "terminal-notifier.app", "Contents", "MacOS");
    await mkdir(macos, { recursive: true });
    await writeFile(join(macos, "terminal-notifier"), "#!/bin/sh\n");
    return ok();
  };

  function mac(download: (url: string) => Promise<Uint8Array>) {
    const os = fakeOs({
      home: "/Users/owner",
      majhiHome,
      programs: { "/usr/bin/osascript": () => ok(), "/usr/bin/ditto": ditto },
      download,
    });
    return { os, notifier: macosPlatform(os.deps, { notifierRelease: pinned }).notifier };
  }

  it("never installs a download whose hash does not match, and stays on osascript", async () => {
    const download = vi.fn(async () => new Uint8Array(Buffer.from("something else")));
    const { os, notifier } = mac(download);

    expect((await showNotification(notifier, base, params)).clickable).toBe(false);
    await vi.waitFor(() => expect(os.logs.join("\n")).toContain("did not match its pinned SHA-256"));
    expect((await showNotification(notifier, base, params)).clickable).toBe(false);

    expect(download).toHaveBeenCalledTimes(1);
    expect(os.runs.map((run) => run.file)).toEqual(["/usr/bin/osascript", "/usr/bin/osascript"]);
    expect(await readdir(majhiHome)).toEqual([]);
  });

  it("installs the pinned release, and the next notification opens majhi on click", async () => {
    const download = vi.fn(async () => new Uint8Array(release));
    const { os, notifier } = mac(download);

    // The first one does not wait for the download.
    expect((await showNotification(notifier, base, params)).clickable).toBe(false);
    expect(os.runs[0]?.file).toBe("/usr/bin/osascript");
    await vi.waitFor(() => expect(os.logs.join("\n")).toContain("installed terminal-notifier 9.9.9"));
    expect(download).toHaveBeenCalledWith(pinned.url);

    const program = installedProgram(majhiHome);
    expect(program).toBe(
      join(
        majhiHome,
        "bin",
        "terminal-notifier",
        "terminal-notifier.app",
        "Contents",
        "MacOS",
        "terminal-notifier",
      ),
    );
    // Only the installed app is left: the zip and the unpack folder are gone.
    expect(await readdir(join(majhiHome, "bin"))).toEqual(["terminal-notifier"]);
    expect(await readFile(program, "utf8")).toBe("#!/bin/sh\n");

    os.programs.set(program, () => ok());
    expect((await showNotification(notifier, base, params)).clickable).toBe(true);
    const last = os.runs.at(-1);
    expect(last?.file).toBe(program);
    expect(last?.args).toEqual([
      "-title",
      "majhi",
      "-message",
      "ACM-12 needs approval",
      "-group",
      "majhi",
      "-open",
      "http://127.0.0.1:7070/t/ACM-12",
      "-sound",
      "Glass",
    ]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("downloads nothing and shows nothing with MAJHI_HOST_NOTIFY=off", async () => {
    const download = vi.fn(async () => new Uint8Array(release));
    const { os, notifier } = mac(download);
    const logs: string[] = [];
    const off = desktopNotifier(false, notifier, (line) => logs.push(line));

    expect((await showNotification(off, base, params)).clickable).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(download).not.toHaveBeenCalled();
    expect(os.runs).toEqual([]);
    expect(logs).toEqual(["notify (off): majhi: ACM-12 needs approval"]);
  });
});

describe("showNotification on Linux", () => {
  const base = "http://127.0.0.1:7070";

  it("passes title and message to notify-send after --, with markup and escapes made plain", async () => {
    const os = fakeOs({
      env: {
        DISPLAY: ":0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        NORTHWIND_TOKEN: "abc123",
      },
      programs: { "/usr/bin/notify-send": () => ok() },
    });
    const params = { title: "--urgency=critical", message: "<b>Globex</b> & co \\n", path: "/t/ACM-12" };
    const out = await showNotification(linuxPlatform(os.deps).notifier, base, { ...params, sound: false });
    expect(out.clickable).toBe(false);
    expect(os.runs[0]?.args).toEqual([
      "--app-name=majhi",
      "--",
      "--urgency=critical",
      "&lt;b&gt;Globex&lt;/b&gt; &amp; co \\\\n",
    ]);
    // The desktop session's variables, never the rest of the helper's environment.
    expect(os.runs[0]?.options.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/owner",
      DISPLAY: ":0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });

    const refused = fakeOs({ programs: { "/usr/bin/notify-send": () => failed(1) } });
    await expect(
      showNotification(linuxPlatform(refused.deps).notifier, base, { ...params, sound: false }),
    ).rejects.toThrow("Install libnotify-bin (Debian, Ubuntu) or libnotify.");
  });
});

describe("the Windows toast on WSL2", () => {
  const base = "http://127.0.0.1:7070";
  const psDir = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0";

  /** WSL2 with powershell.exe on PATH, where WSL puts the Windows PATH. */
  function wsl(powershell: FakeProgram = () => ok()) {
    const os = fakeOs({
      path: `/usr/local/bin:/usr/bin:/bin:${psDir}`,
      env: { WSL_INTEROP: "/run/WSL/8_interop", WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" },
      programs: { [`${psDir}/powershell.exe`]: powershell },
    });
    return { notifier: wslPlatform(os.deps).notifier, runs: os.runs };
  }

  /** The script powershell.exe was given, from its -EncodedCommand: base64 of UTF-16LE. */
  function script(args: readonly string[] | undefined): string[] {
    expect(args?.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    return Buffer.from(args?.[3] ?? "", "base64")
      .toString("utf16le")
      .split("\n");
  }

  /** XML character references read back as the characters. */
  const fromXml = (text: string) =>
    text.replace(/&#x([0-9a-f]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));

  it("keeps hostile title, message and URL text inside one single-quoted string", async () => {
    // ' and U+2018 to U+201B all end a single-quoted PowerShell string.
    const hostile = `it's \u2018a\u2019 b\u201a \u201bc "d" $(Remove-Item -Recurse C:\\) <x>&amp;`;
    const params = {
      title: hostile,
      message: `'); Start-Process calc; ('\n${hostile}`,
      path: "/t/ACM-12/it's-$(calc)",
      sound: false,
    };
    const { notifier, runs } = wsl();
    expect((await showNotification(notifier, base, params)).clickable).toBe(true);

    const lines = script(runs[0]?.args);
    expect(lines).toHaveLength(7);
    const xml = /^\$xml\.LoadXml\('(.*)'\)$/.exec(lines[4] ?? "")?.[1] ?? "";
    expect(xml).not.toBe("");
    expect(xml).not.toMatch(/['\u2018-\u201b]/);
    // The other lines are fixed, whatever the notification says.
    expect(lines.filter((_line, i) => i !== 4).join("\n")).not.toMatch(/calc|Remove-Item|ACM/);
    expect(lines[6]).toBe(
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
    );
    // Windows reads the text back whole.
    const texts = [...xml.matchAll(/<text>([^<]*)<\/text>/g)].map((match) => fromXml(match[1] ?? ""));
    expect(texts).toEqual([plainLine(hostile, 120), plainLine(params.message)]);
    expect(xml).toContain('activationType="protocol"');
    expect(fromXml(/launch="([^"]*)"/.exec(xml)?.[1] ?? "")).toBe(
      "http://127.0.0.1:7070/t/ACM-12/it's-$(calc)",
    );
    expect(xml).toContain('<audio silent="true"/>');
  });

  it("is clickable only with a URL, and says when Windows showed nothing", async () => {
    const { notifier, runs } = wsl();
    const params = { title: "majhi", message: "ACM-12 is done", sound: true };
    expect((await showNotification(notifier, base, params)).clickable).toBe(false);
    const xml = script(runs[0]?.args).join("\n");
    expect(xml).toContain('<toast activationType="background">');
    expect(xml).not.toContain("launch=");
    expect(xml).not.toContain("<audio");
    expect(runs[0]?.options.env).toMatchObject({
      WSL_INTEROP: "/run/WSL/8_interop",
      WSL_DISTRO_NAME: "Ubuntu",
    });

    await expect(showNotification(wsl(() => failed(1)).notifier, base, params)).rejects.toThrow(
      "Windows did not show the notification. Check Settings, System, Notifications in Windows.",
    );
  });
});
