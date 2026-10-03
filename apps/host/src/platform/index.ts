/**
 * The helper's way into the OS: which one it runs on, the platform for it, and the deps that reach
 * the real process. main.ts is the only caller.
 */
import { access } from "node:fs/promises";
import { release } from "node:os";
import type { HostOs } from "@majhi/shared";
import { downloadBytes } from "../download.ts";
import type { Logger } from "../log.ts";
import { findExecutable, toolPath } from "../paths.ts";
import { runCommand } from "../runCommand.ts";
import { linuxPlatform } from "./linux.ts";
import { macosPlatform } from "./macos.ts";
import { detectOs } from "./os.ts";
import type { CreatePlatform, PlatformDeps } from "./types.ts";
import { wslPlatform } from "./wsl.ts";

/** Node's name for the platform, which `HostInfo.platform` carries (decision 10). */
export const nodePlatform: NodeJS.Platform = process.platform;

/** The OS the helper runs on, or undefined where it does not run. */
export function currentOs(): HostOs | undefined {
  return detectOs({ platform: process.platform, release: release(), env: process.env });
}

export const createPlatform: CreatePlatform = (os, deps) => {
  if (os === "macos") return macosPlatform(deps);
  if (os === "wsl") return wslPlatform(deps);
  return linuxPlatform(deps);
};

export interface ProcessDepsOptions {
  home: string;
  majhiHome: string;
  log: Logger;
  /** False with MAJHI_HOST_NOTIFY=off: the helper then downloads nothing. */
  downloads: boolean;
}

/** `PlatformDeps` over the real process: its environment, its PATH with `toolDirs`, real programs. */
export function processDeps(os: HostOs, options: ProcessDepsOptions): PlatformDeps {
  const path = toolPath(process.env.PATH, os, options.home);
  return {
    run: runCommand,
    env: process.env,
    home: options.home,
    majhiHome: options.majhiHome,
    path,
    find: (name) => findExecutable(name, path),
    exists: (file) =>
      access(file).then(
        () => true,
        () => false,
      ),
    log: options.log,
    ...(options.downloads ? { download: downloadBytes } : {}),
  };
}
