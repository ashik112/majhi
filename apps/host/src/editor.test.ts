import { describe, expect, it } from "vitest";
import { createEditorOpener, type EditorDeps } from "./editor.ts";

interface Call {
  file: string;
  args: readonly string[];
}

function setup(options: {
  onPath?: Record<string, string>;
  executables?: string[];
  kind?: "file" | "directory" | undefined;
  platform?: string;
  code?: number | null;
}) {
  const calls: Call[] = [];
  const deps: EditorDeps = {
    run: async (file, args) => {
      calls.push({ file, args });
      return { code: options.code ?? 0, stdout: "", stderr: "secret output" };
    },
    path: "/usr/local/bin:/usr/bin",
    home: "/Users/a",
    platform: options.platform ?? "darwin",
    find: async (name) => options.onPath?.[name],
    kind: async () => ("kind" in options ? options.kind : "directory"),
    isExecutable: async (file) => options.executables?.includes(file) ?? false,
  };
  return { open: createEditorOpener(deps), calls };
}

describe("editor opener", () => {
  it("runs the editor's command on the path, without a shell", async () => {
    const { open, calls } = setup({ onPath: { code: "/usr/local/bin/code" } });
    await open({ app: "vscode", path: "/Users/a/Work/x; rm -rf ~" });
    expect(calls).toEqual([{ file: "/usr/local/bin/code", args: ["/Users/a/Work/x; rm -rf ~"] }]);
  });

  it("uses cursor for Cursor", async () => {
    const { open, calls } = setup({ onPath: { cursor: "/usr/local/bin/cursor" } });
    await open({ app: "cursor", path: "/Users/a/Work/x" });
    expect(calls[0]?.file).toBe("/usr/local/bin/cursor");
  });

  it("jumps to a line in a file, and ignores the line for a folder", async () => {
    const file = setup({ onPath: { code: "/bin/code" }, kind: "file" });
    await file.open({ app: "vscode", path: "/Users/a/Work/x/a.ts", line: 12 });
    expect(file.calls[0]?.args).toEqual(["--goto", "/Users/a/Work/x/a.ts:12"]);

    const folder = setup({ onPath: { code: "/bin/code" } });
    await folder.open({ app: "vscode", path: "/Users/a/Work/x", line: 12 });
    expect(folder.calls[0]?.args).toEqual(["/Users/a/Work/x"]);
  });

  it("finds the command inside the app when it is not on the PATH", async () => {
    const cli = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const { open, calls } = setup({ executables: [cli] });
    await open({ app: "cursor", path: "/Users/a/Work/x" });
    expect(calls[0]?.file).toBe(cli);
  });

  it("falls back to `open -a` on a Mac with the app but no command", async () => {
    const { open, calls } = setup({});
    await open({ app: "vscode", path: "/Users/a/Work/x" });
    expect(calls).toEqual([{ file: "/usr/bin/open", args: ["-a", "Visual Studio Code", "/Users/a/Work/x"] }]);
  });

  it("says the editor is missing on other systems", async () => {
    const { open, calls } = setup({ platform: "linux" });
    await expect(open({ app: "vscode", path: "/home/a/x" })).rejects.toThrow(/VS Code is not installed/);
    expect(calls).toEqual([]);
  });

  it("refuses a relative path and a path that does not exist", async () => {
    const { open, calls } = setup({ onPath: { code: "/bin/code" } });
    await expect(open({ app: "vscode", path: "--wait" })).rejects.toThrow("The path must be absolute.");
    const none = setup({ onPath: { code: "/bin/code" }, kind: undefined });
    await expect(none.open({ app: "vscode", path: "/Users/a/nope" })).rejects.toThrow(
      "There is nothing at /Users/a/nope on this Mac.",
    );
    expect([...calls, ...none.calls]).toEqual([]);
  });

  it("reports a failing editor with a fixed sentence, not its output", async () => {
    const { open } = setup({ onPath: { code: "/bin/code" }, code: 1 });
    const error = await open({ app: "vscode", path: "/Users/a/Work/x" }).catch((e: Error) => e);
    expect((error as Error).message).toBe("VS Code did not open /Users/a/Work/x.");
  });
});
