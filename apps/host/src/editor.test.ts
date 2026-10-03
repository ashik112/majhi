import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HostOs } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorOpener } from "./editor.ts";
import { type FakeProgram, failed, fakeOs, ok } from "./platform/fakeOs.ts";
import { createPlatform } from "./platform/index.ts";
import type { Platform, PlatformDeps } from "./platform/types.ts";
import { wslPlatform } from "./platform/wsl.ts";

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

  it("uses cursor for Cursor", async () => {
    const { open, calls } = setup({ programs: { "/usr/local/bin/cursor": () => ok() } });
    await open({ app: "cursor", path: "/Users/owner/Work/x" });
    expect(calls()[0]?.file).toBe("/usr/local/bin/cursor");
  });

  it("jumps to a line in a file, and ignores the line for a folder", async () => {
    const file = setup({ programs: { "/usr/bin/code": () => ok() }, kind: "file" });
    await file.open({ app: "vscode", path: "/Users/owner/Work/x/a.ts", line: 12 });
    expect(file.calls()[0]?.args).toEqual(["--goto", "/Users/owner/Work/x/a.ts:12"]);

    const folder = setup({ programs: { "/usr/bin/code": () => ok() } });
    await folder.open({ app: "vscode", path: "/Users/owner/Work/x", line: 12 });
    expect(folder.calls()[0]?.args).toEqual(["/Users/owner/Work/x"]);
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

  it("reports a failing editor with a fixed sentence, not its output", async () => {
    const { open } = setup({ programs: { "/usr/bin/code": () => failed(1, "secret output") } });
    const error = await open({ app: "vscode", path: "/Users/owner/Work/x" }).catch((e: Error) => e);
    expect((error as Error).message).toBe("VS Code did not open /Users/owner/Work/x.");
  });
});

describe("editor opener on macOS", () => {
  it("finds the command inside the app when it is not on the PATH", async () => {
    const cli = "/Users/owner/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const { open, calls } = setup({ programs: { [cli]: () => ok() } });
    await open({ app: "cursor", path: "/Users/owner/Work/x" });
    expect(calls()).toEqual([{ file: cli, args: ["/Users/owner/Work/x"] }]);
  });

  it("falls back to `open -a` with the app but no command, and says when the app is missing", async () => {
    const { open, calls } = setup({ programs: { "/usr/bin/open": () => ok() } });
    await open({ app: "vscode", path: "/Users/owner/Work/x" });
    expect(calls()).toEqual([
      { file: "/usr/bin/open", args: ["-a", "Visual Studio Code", "/Users/owner/Work/x"] },
    ]);

    const missing = setup({ programs: { "/usr/bin/open": () => failed() } });
    await expect(missing.open({ app: "cursor", path: "/Users/owner/Work/x" })).rejects.toThrow(
      "Cursor is not installed, so /Users/owner/Work/x was not opened.",
    );
  });
});

describe("editor opener on Linux", () => {
  it("says the editor is missing when its command is not on the PATH", async () => {
    const { open, calls } = setup({ os: "linux" });
    await expect(open({ app: "vscode", path: "/home/owner/x" })).rejects.toThrow(
      "VS Code is not installed, or its `code` command is not on the PATH.",
    );
    expect(calls()).toEqual([]);
  });

  it("gives the editor the desktop session's display", async () => {
    const { open, runs } = setup({
      os: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", SSH_AUTH_SOCK: "/run/user/1000/ssh-agent" },
      programs: { "/usr/bin/code": () => ok() },
    });
    await open({ app: "vscode", path: "/home/owner/x" });
    expect(runs[0]?.options.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/owner",
      WAYLAND_DISPLAY: "wayland-0",
    });
  });
});

describe("editor opener on WSL2", () => {
  let root: string;
  let usersDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "majhi-wsl-"));
    usersDir = join(root, "c", "Users");
    for (const name of ["owner", "Public", "Default"]) await mkdir(join(usersDir, name), { recursive: true });
    await symlink(join(usersDir, "Default"), join(usersDir, "All Users"));
    await writeFile(join(usersDir, "desktop.ini"), "");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const wsl = (deps: PlatformDeps) => wslPlatform(deps, { usersDir, interopDir: join(root, "WSL") });
  const env = { WSL_INTEROP: "/run/WSL/12_interop", WSL_DISTRO_NAME: "Ubuntu" };

  it("finds the Windows install in the one person's folder in C:\\Users", async () => {
    const code = join(usersDir, "owner", "AppData", "Local", "Programs", "Microsoft VS Code", "bin", "code");
    const { open, runs } = setup({ os: "wsl", platform: wsl, env, programs: { [code]: () => ok() } });
    await open({ app: "vscode", path: "/home/owner/x" });
    expect(runs.map((r) => [r.file, ...r.args])).toEqual([[code, "/home/owner/x"]]);
    expect(runs[0]?.options.env).toMatchObject(env);
  });

  it("falls back to the install for all users", async () => {
    const code = join(dirname(usersDir), "Program Files", "Microsoft VS Code", "bin", "code");
    const { open, calls } = setup({ os: "wsl", platform: wsl, env, programs: { [code]: () => ok() } });
    await open({ app: "vscode", path: "/home/owner/x" });
    expect(calls()).toEqual([{ file: code, args: ["/home/owner/x"] }]);
  });

  it("asks cmd.exe for %USERPROFILE% when C:\\Users holds more than one person", async () => {
    await mkdir(join(usersDir, "guest"));
    const cmd = "/mnt/c/Windows/System32/cmd.exe";
    const cursor = join(
      usersDir,
      "owner",
      "AppData",
      "Local",
      "Programs",
      "cursor",
      "resources",
      "app",
      "bin",
      "cursor",
    );
    const { open, runs } = setup({
      os: "wsl",
      platform: wsl,
      env,
      path: "/usr/bin:/mnt/c/Windows/System32",
      files: [join(usersDir, "owner")],
      programs: {
        [cmd]: () => ok("C:\\Users\\owner\r\n"),
        "/usr/bin/wslpath": (args) =>
          args.join(" ") === "-u C:\\Users\\owner" ? ok(`${usersDir}/owner\n`) : failed(),
        [cursor]: () => ok(),
      },
    });
    await open({ app: "cursor", path: "/home/owner/x" });
    expect(runs.map((r) => [r.file, ...r.args])).toEqual([
      [cmd, "/c", "echo", "%USERPROFILE%"],
      ["/usr/bin/wslpath", "-u", "C:\\Users\\owner"],
      [cursor, "/home/owner/x"],
    ]);
    // cmd.exe starts on the Windows drive, so it does not warn about a Linux folder.
    expect(runs[0]?.options.cwd).toBe(dirname(usersDir));
  });
});
