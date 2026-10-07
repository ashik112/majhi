import { describe, expect, it } from "vitest";
import { clickUrl, plainLine, showNotification } from "./notify.ts";
import { type FakeProgram, failed, fakeOs, ok } from "./platform/fakeOs.ts";
import { linuxPlatform } from "./platform/linux.ts";
import { POWERSHELL_APP_ID } from "./platform/toast.ts";
import { wslPlatform } from "./platform/wsl.ts";

describe("clickUrl", () => {
  it("joins a path to majhi's address and refuses anything else", () => {
    expect(clickUrl("http://127.0.0.1:7070", "/t/ACM-12")).toBe("http://127.0.0.1:7070/t/ACM-12");
    expect(clickUrl("http://127.0.0.1:7070", "//evil.example/x")).toBeUndefined();
    expect(clickUrl("http://127.0.0.1:7070", "https://evil.example")).toBeUndefined();
    expect(clickUrl("http://127.0.0.1:7070", undefined)).toBeUndefined();
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
    expect(out).toEqual({ kind: "shown", clickable: false });
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
    expect(await showNotification(notifier, base, params)).toEqual({ kind: "shown", clickable: true });

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
});
