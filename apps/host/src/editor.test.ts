import type { HostOs } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { createEditorOpener } from "./editor.ts";
import { type FakeProgram, fakeOs, ok } from "./platform/fakeOs.ts";
import { createPlatform } from "./platform/index.ts";
import type { Platform, PlatformDeps } from "./platform/types.ts";

function setup(options: {
  os?: HostOs;
  programs?: Record<string, FakeProgram>;
  files?: string[];
  env?: Record<string, string>;
  path?: string;
  kind?: "file" | "directory" | undefined;
  platform?: (deps: PlatformDeps) => Platform;
}) {
  const os = fakeOs({
    home: options.os === "macos" || options.os === undefined ? "/Users/owner" : "/home/owner",
    path: options.path ?? "/usr/local/bin:/usr/bin",
    programs: options.programs ?? {},
    files: options.files ?? [],
    env: options.env ?? {},
  });
  const platform = options.platform?.(os.deps) ?? createPlatform(options.os ?? "macos", os.deps);
  const open = createEditorOpener({
    run: os.deps.run,
    platform: platform.editor,
    env: () => platform.desktopEnv(),
    find: os.deps.find,
    kind: async () => ("kind" in options ? options.kind : "directory"),
    isExecutable: async (file) => os.programs.has(file),
  });
  return { open, calls: () => os.runs.map((r) => ({ file: r.file, args: r.args })), runs: os.runs };
}

describe("editor opener", () => {
  it("runs the editor's command on the path, without a shell", async () => {
    const { open, calls } = setup({ programs: { "/usr/local/bin/code": () => ok() } });
    await open({ app: "vscode", path: "/Users/owner/Work/x; rm -rf ~" });
    expect(calls()).toEqual([{ file: "/usr/local/bin/code", args: ["/Users/owner/Work/x; rm -rf ~"] }]);
  });

  it("refuses a relative path and a path that does not exist", async () => {
    const { open, calls } = setup({ programs: { "/usr/bin/code": () => ok() } });
    await expect(open({ app: "vscode", path: "--wait" })).rejects.toThrow("The path must be absolute.");
    const none = setup({ programs: { "/usr/bin/code": () => ok() }, kind: undefined });
    await expect(none.open({ app: "vscode", path: "/Users/owner/nope" })).rejects.toThrow(
      "There is nothing at /Users/owner/nope on this computer.",
    );
    expect([...calls(), ...none.calls()]).toEqual([]);
  });
});
