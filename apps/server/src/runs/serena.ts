import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StdioServerSpec } from "@majhi/acp";
import type { ToolId } from "@majhi/shared";
import { errorMessage } from "../errors.ts";

/** Where Serena is in the runner image (`docker`/`Dockerfile`, the `runner` stage). */
export const SERENA_COMMAND = "/opt/serena/bin/serena";

/** The pinned release the runner image installs. Raise it there and here together. */
export const SERENA_VERSION = "1.7.0";

/** Serena can start in the runner. Undefined in `LaunchDeps` when agents do not run in a runner container. */
export interface SerenaLaunch {
  command: string;
}

/**
 * Serena's context names the client it serves, which decides which of its tools duplicate the
 * client's own and are left out. Both adapters majhi drives have one.
 */
const CONTEXT: Record<ToolId, string> = { claude: "claude-code", codex: "codex" };

/**
 * The stdio server entry for one task worktree (SPEC 5.9 item 6). The agent CLI starts it inside
 * its own runner container, with the worktree as the project. Serena's memories and onboarding are
 * off because majhi has its own memory, and its dashboard, browser tab and usage ping are off
 * because a run has no screen and nothing should leave the machine.
 */
export function serenaServer(serena: SerenaLaunch, worktree: string, tool: ToolId): StdioServerSpec {
  return {
    type: "stdio",
    name: "serena",
    command: serena.command,
    args: [
      "start-mcp-server",
      "--context",
      CONTEXT[tool],
      "--add-mode",
      "no-memories",
      "--add-mode",
      "no-onboarding",
      "--project",
      worktree,
      "--enable-web-dashboard",
      "false",
      "--open-web-dashboard",
      "false",
      "--enable-gui-log-window",
      "false",
    ],
    env: { SERENA_USAGE_REPORTING: "false" },
  };
}

/** Whether `.serena` is ready, or why Serena is left out of this run. */
export type SerenaFolder = { ok: true } | { ok: false; reason: string };

/**
 * Serena keeps a project's settings and caches in `<worktree>/.serena`, and majhi's checkpoints
 * commit everything not ignored. Serena writes its own `.gitignore` there only when the file is
 * missing, so a file that ignores everything, itself included, keeps the folder out of commits
 * without touching the owner's repo or its `.gitignore`.
 *
 * Agents can write to the worktree, so the folder is not trusted: it must be a real folder (not a
 * link) that resolves inside the worktree, and the file is created exclusively and without following
 * a link, then checked to be the file at that path. Anything else leaves Serena out of the run and
 * writes nothing.
 */
export async function keepSerenaOutOfGit(worktree: string): Promise<SerenaFolder> {
  const dir = join(worktree, ".serena");
  try {
    let info = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (info === undefined) {
      await mkdir(dir);
      info = await lstat(dir);
    }
    if (!info.isDirectory())
      return { ok: false, reason: ".serena in the worktree is not a folder (it may be a link)" };
    const realDir = await realpath(dir);
    const realWorktree = await realpath(worktree);
    if (realDir !== join(realWorktree, ".serena")) {
      return { ok: false, reason: ".serena does not resolve to a folder inside the worktree" };
    }
    const file = join(realDir, ".gitignore");
    let handle: FileHandle;
    try {
      handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" && (err as NodeJS.ErrnoException).code !== "ELOOP")
        throw err;
      // Serena leaves a .gitignore that is already there alone, so it has to be a plain file.
      const existing = await lstat(file);
      return existing.isFile()
        ? { ok: true }
        : { ok: false, reason: ".serena/.gitignore in the worktree is not a plain file" };
    }
    try {
      await handle.writeFile("*\n");
      const made = await handle.stat();
      const there = await lstat(file).catch(() => undefined);
      if (
        there === undefined ||
        there.ino !== made.ino ||
        there.dev !== made.dev ||
        (await realpath(dir)) !== realDir
      ) {
        // The folder was swapped for a link while the file was made: take back what this call wrote.
        await rm(file, { force: true }).catch(() => undefined);
        return { ok: false, reason: ".serena changed while majhi was preparing it" };
      }
    } finally {
      await handle.close();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `.serena could not be prepared: ${errorMessage(err)}` };
  }
}
