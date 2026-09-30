import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { EDITOR_LABEL, type EditorApp } from "@majhi/shared";
import type { RunFn } from "./ssh.ts";

const OPEN_TIMEOUT_MS = 15_000;

/** The shell command each editor installs, and the macOS app it can fall back to. */
const EDITORS: Record<EditorApp, { cli: string; bundle: string; appName: string }> = {
  vscode: {
    cli: "code",
    bundle: "Visual Studio Code.app/Contents/Resources/app/bin/code",
    appName: "Visual Studio Code",
  },
  cursor: { cli: "cursor", bundle: "Cursor.app/Contents/Resources/app/bin/cursor", appName: "Cursor" },
};

export interface EditorDeps {
  run: RunFn;
  /** The helper's PATH, already extended with the usual tool folders. */
  path: string;
  home: string;
  platform: string;
  /** The absolute path of the first executable `name` on `path`, or undefined. */
  find: (name: string, path: string) => Promise<string | undefined>;
  /** The kind of thing at `path`, or undefined when there is nothing there. */
  kind: (path: string) => Promise<"file" | "directory" | undefined>;
  /** True when the executable exists. */
  isExecutable: (path: string) => Promise<boolean>;
}

export type EditorOpen = (params: {
  app: EditorApp;
  path: string;
  line?: number | undefined;
}) => Promise<void>;

/**
 * Opens a file or folder in VS Code or Cursor. The program is run directly, never through a shell,
 * and the path must be absolute and exist, so it cannot be read as an option. Messages are fixed
 * sentences: the editor's own output is not passed on.
 */
export function createEditorOpener(deps: EditorDeps): EditorOpen {
  const env = { PATH: deps.path, HOME: deps.home };
  return async ({ app, path, line }) => {
    const label = EDITOR_LABEL[app];
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("The path must be absolute.");
    const kind = await deps.kind(path);
    if (kind === undefined) throw new Error(`There is nothing at ${path} on this Mac.`);
    const editor = EDITORS[app];
    const cli = await findCli(deps, editor);
    if (cli !== undefined) {
      const args = line !== undefined && kind === "file" ? ["--goto", `${path}:${line}`] : [path];
      const result = await deps.run(cli, args, { env, timeoutMs: OPEN_TIMEOUT_MS });
      if (result.code === 0) return;
      throw new Error(`${label} did not open ${path}.`);
    }
    if (deps.platform !== "darwin") {
      throw new Error(`${label} is not installed, or its \`${editor.cli}\` command is not on the PATH.`);
    }
    const result = await deps.run("/usr/bin/open", ["-a", editor.appName, path], {
      env,
      timeoutMs: OPEN_TIMEOUT_MS,
    });
    if (result.code !== 0) throw new Error(`${label} is not installed, so ${path} was not opened.`);
  };
}

async function findCli(deps: EditorDeps, editor: (typeof EDITORS)[EditorApp]): Promise<string | undefined> {
  const onPath = await deps.find(editor.cli, deps.path);
  if (onPath !== undefined) return onPath;
  for (const apps of ["/Applications", join(deps.home, "Applications")]) {
    const candidate = join(apps, editor.bundle);
    if (await deps.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** The real file checks for `EditorDeps`. */
export async function pathKind(path: string): Promise<"file" | "directory" | undefined> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "directory" : "file";
  } catch {
    return undefined;
  }
}
