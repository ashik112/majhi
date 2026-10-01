import { describe, expect, it } from "vitest";
import { clickUrl, showNotification } from "./notify.ts";
import type { RunFn } from "./ssh.ts";
import { notificationScript } from "./startup.ts";

function recorder(code = 0) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: RunFn = async (file, args) => {
    calls.push({ file, args });
    return { code, stdout: "", stderr: "" };
  };
  return { calls, run };
}

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

describe("showNotification", () => {
  const base = { env: {}, baseUrl: "http://127.0.0.1:7070" };
  it("opens majhi on click through terminal-notifier when it is installed", async () => {
    const r = recorder();
    const out = await showNotification(
      { ...base, run: r.run, terminalNotifier: "/opt/homebrew/bin/terminal-notifier" },
      { title: "majhi", message: "ACM-12 needs approval", path: "/t/ACM-12", sound: false },
    );
    expect(out.clickable).toBe(true);
    expect(r.calls[0]?.args).toContain("http://127.0.0.1:7070/t/ACM-12");
  });
  it("falls back to osascript without a click", async () => {
    const r = recorder();
    const out = await showNotification(
      { ...base, run: r.run, terminalNotifier: undefined },
      { title: "majhi", message: "ACM-12 needs approval", path: "/t/ACM-12", sound: true },
    );
    expect(out.clickable).toBe(false);
    expect(r.calls[0]?.file).toBe("/usr/bin/osascript");
    expect(r.calls[0]?.args[1]).toContain('sound name "Glass"');
  });
});
