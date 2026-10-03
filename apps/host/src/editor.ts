import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { EDITOR_LABEL, type EditorApp } from "@majhi/shared";
import type { EditorPlatform } from "./platform/types.ts";
import type { RunFn } from "./ssh.ts";

const OPEN_TIMEOUT_MS = 15_000;

/** The shell command each editor installs. */
const EDITOR_CLI: Record<EditorApp, string> = { vscode: "code", cursor: "cursor" };

export interface EditorDeps {
  run: RunFn;
  /** Where the command may be when it is not on PATH, and the app to open where there is one. */
  platform: EditorPlatform;
  /** `desktopEnv()`: what the editor needs to show its window. */
  env: () => Promise<Record<string, string>>;
  /** The absolute path of the first executable `name` on the helper's PATH, or undefined. */
  find: (name: string) => Promise<string | undefined>;
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
  return async ({ app, path, line }) => {
    const label = EDITOR_LABEL[app];
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("The path must be absolute.");
    const kind = await deps.kind(path);
    if (kind === undefined) throw new Error(`There is nothing at ${path} on this computer.`);
    const cli = await findCli(deps, app);
    if (cli !== undefined) {
      const args = line !== undefined && kind === "file" ? ["--goto", `${path}:${line}`] : [path];
      const result = await deps.run(cli, args, { env: await deps.env(), timeoutMs: OPEN_TIMEOUT_MS });
      if (result.code === 0) return;
      throw new Error(`${label} did not open ${path}.`);
    }
    if (deps.platform.openApp === undefined) {
      throw new Error(`${label} is not installed, or its \`${EDITOR_CLI[app]}\` command is not on the PATH.`);
    }
    if (!(await deps.platform.openApp(app, path))) {
      throw new Error(`${label} is not installed, so ${path} was not opened.`);
    }
  };
}

async function findCli(deps: EditorDeps, app: EditorApp): Promise<string | undefined> {
  const onPath = await deps.find(EDITOR_CLI[app]);
  if (onPath !== undefined) return onPath;
  for (const candidate of await deps.platform.cliCandidates(app)) {
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
