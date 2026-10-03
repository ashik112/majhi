/**
 * WSL2: Linux, with Docker Desktop, the browser, the editor and notifications on the Windows side,
 * reached through WSL interop. A Windows program is found on PATH (WSL adds the Windows PATH by
 * default), else at its usual place through `wslpath -u`.
 */
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LINUX_DESKTOP_VARS, linuxPlatform, sessionEnv } from "./linux.ts";
import { openUrl } from "./openUrl.ts";
import { powershellArgs, toastNotifier } from "./toast.ts";
import type { DockerHelpReason, Platform, PlatformDeps } from "./types.ts";

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const EXPLORER = "C:\\Windows\\explorer.exe";
const CMD = "C:\\Windows\\System32\\cmd.exe";
const DOCKER_DESKTOP = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
const WSLPATH_TIMEOUT_MS = 5_000;
const CMD_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;

/** Folders in C:\Users that are not a person's. */
const NOT_A_USER = new Set(["Public", "Default", "Default User", "All Users"]);

const DOCKER_HELP: Record<DockerHelpReason, string> = {
  "not-started":
    "Open Docker Desktop in Windows with WSL integration on for this distro, and majhi starts by itself.",
  slow: "Docker Desktop did not start in 2 minutes. Open it in Windows, and majhi starts by itself.",
};

export interface WslPaths {
  /** Where Windows' C:\Users shows in the distro. */
  usersDir?: string;
  /** Where WSL keeps its interop sockets. */
  interopDir?: string;
}

/** The newest `*_interop` socket in `dir`, which belongs to the distro's latest session. */
async function newestInterop(dir: string): Promise<string | undefined> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let newest: { path: string; time: number } | undefined;
  for (const name of names) {
    if (!name.endsWith("_interop")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isSocket() !== true) continue;
    if (newest === undefined || info.mtimeMs > newest.time) newest = { path, time: info.mtimeMs };
  }
  return newest?.path;
}

/** The distro's name from `wslpath -w /`, which prints `\\wsl.localhost\<name>\` or `\\wsl$\<name>\`. */
export function distroOf(windowsRoot: string): string | undefined {
  return /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?$/i.exec(windowsRoot.trim())?.[1];
}

export function wslPlatform(deps: PlatformDeps, paths: WslPaths = {}): Platform {
  const usersDir = paths.usersDir ?? "/mnt/c/Users";
  const interopDir = paths.interopDir ?? "/run/WSL";
  const session = sessionEnv(deps, [...LINUX_DESKTOP_VARS, "WSL_DISTRO_NAME", "WSL_INTEROP"]);

  /** `wslpath` with `args`, or undefined when it is missing or failed. */
  const wslpath = async (args: string[]): Promise<string | undefined> => {
    const bin = await deps.find("wslpath");
    if (bin === undefined) return undefined;
    const result = await deps.run(bin, args, {
      env: { PATH: deps.path, HOME: deps.home },
      timeoutMs: WSLPATH_TIMEOUT_MS,
    });
    const out = result.code === 0 ? result.stdout.trim() : "";
    return out === "" ? undefined : out;
  };

  /** A Windows path as the distro sees it, when something is there. */
  const toLinux = async (windowsPath: string): Promise<string | undefined> => {
    const path = await wslpath(["-u", windowsPath]);
    return path !== undefined && (await deps.exists(path)) ? path : undefined;
  };

  /** A Windows program on PATH, else at its usual place. */
  const program = async (name: string, windowsPath: string): Promise<string | undefined> =>
    (await deps.find(name)) ?? (await toLinux(windowsPath));

  let distro: string | undefined;
  /**
   * The Linux variables, plus what interop needs. A login service has no WSL_INTEROP, so the newest
   * interop socket stands in, and Windows' `code` script needs WSL_DISTRO_NAME to open the distro.
   */
  const desktopEnv = async (): Promise<Record<string, string>> => {
    const env = await session();
    if (env.WSL_INTEROP === undefined) {
      const interop = await newestInterop(interopDir);
      if (interop !== undefined) env.WSL_INTEROP = interop;
    }
    if (env.WSL_DISTRO_NAME === undefined) {
      distro ??= distroOf((await wslpath(["-w", "/"])) ?? "");
      if (distro !== undefined) env.WSL_DISTRO_NAME = distro;
    }
    return env;
  };

  let powershellPath: string | undefined;
  const powershell = async (): Promise<string | undefined> => {
    powershellPath ??= await program("powershell.exe", POWERSHELL);
    return powershellPath;
  };

  let userPath: string | undefined;
  /** The Windows user's folder: the one person's folder in C:\Users, else %USERPROFILE% from cmd.exe. */
  const userFolder = async (): Promise<string | undefined> => {
    if (userPath !== undefined) return userPath;
    const entries = await readdir(usersDir, { withFileTypes: true }).catch(() => []);
    // "Default User" and "All Users" are junctions, which show as links, not folders.
    const people = entries.filter((entry) => entry.isDirectory() && !NOT_A_USER.has(entry.name));
    if (people.length === 1 && people[0] !== undefined) {
      userPath = join(usersDir, people[0].name);
      return userPath;
    }
    const cmd = await program("cmd.exe", CMD);
    if (cmd === undefined) return undefined;
    // cmd.exe warns about a folder it cannot use unless it starts on a Windows drive.
    const result = await deps.run(cmd, ["/c", "echo", "%USERPROFILE%"], {
      env: await desktopEnv(),
      timeoutMs: CMD_TIMEOUT_MS,
      cwd: dirname(usersDir),
    });
    const line = result.stdout
      .split(/\r?\n/)
      .map((text) => text.trim())
      .find((text) => /^[A-Za-z]:\\/.test(text));
    if (result.code !== 0 || line === undefined) return undefined;
    userPath = await toLinux(line);
    return userPath;
  };

  return {
    ...linuxPlatform(deps, desktopEnv),
    os: "wsl",
    notifier: toastNotifier({ run: deps.run, powershell, env: desktopEnv }),
    editor: {
      async cliCandidates(app) {
        const user = await userFolder();
        const programs = user === undefined ? undefined : join(user, "AppData", "Local", "Programs");
        if (app === "cursor") {
          return programs === undefined
            ? []
            : [join(programs, "cursor", "resources", "app", "bin", "cursor")];
        }
        // An install for this user, then one for all users.
        const forAll = join(dirname(usersDir), "Program Files", "Microsoft VS Code", "bin", "code");
        return programs === undefined
          ? [forAll]
          : [join(programs, "Microsoft VS Code", "bin", "code"), forAll];
      },
    },
    docker: {
      async start() {
        const app = await toLinux(DOCKER_DESKTOP);
        const shell = app === undefined ? undefined : await powershell();
        if (shell === undefined) {
          deps.log("startup: Docker Desktop or powershell.exe was not found");
          return false;
        }
        const started = await deps.run(shell, powershellArgs(`Start-Process -FilePath '${DOCKER_DESKTOP}'`), {
          env: await desktopEnv(),
          timeoutMs: START_TIMEOUT_MS,
        });
        if (started.code !== 0) {
          deps.log("startup: could not start Docker Desktop");
          return false;
        }
        deps.log("startup: started Docker Desktop");
        return true;
      },
      help: (reason) => DOCKER_HELP[reason],
    },
    desktopEnv,
    openUrl: (url) =>
      openUrl(
        {
          run: deps.run,
          find: (name) => (name === "explorer.exe" ? program(name, EXPLORER) : deps.find(name)),
          env: desktopEnv,
        },
        ["wslview", "explorer.exe"],
        url,
      ),
  };
}
