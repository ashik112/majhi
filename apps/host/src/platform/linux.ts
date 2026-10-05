/**
 * Linux: a Secret Service keyring, the session's SSH agent or majhi's own, a forwarder for the
 * container's agent socket, `notify-send`, `xdg-open`, and Docker Engine, a system service the
 * helper cannot start.
 */
import { isAbsolute, join, resolve } from "node:path";
import { openUrl } from "./openUrl.ts";
import { createSecretService } from "./secretService.ts";
import { reachable, serveAgent } from "./sshForwarder.ts";
import type { Platform, PlatformDeps } from "./types.ts";

const SYSTEMCTL_TIMEOUT_MS = 5_000;
const NOTIFY_TIMEOUT_MS = 10_000;

/** What a desktop program may need from the session, besides PATH and HOME. */
export const LINUX_DESKTOP_VARS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "BROWSER",
] as const;

const SKIPPED_AT_HOME = new Set(["Music", "Pictures", "Public", "Templates", "Videos", "snap"]);

const DOCKER_HELP =
  "Docker is not running. Run sudo systemctl enable --now docker, and majhi starts by itself.";
const NOT_SHOWN =
  "This computer did not show the notification. Install libnotify-bin (Debian, Ubuntu) or libnotify.";

const C_ESCAPES: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** The text inside systemd's `$'...'`: C escapes, and octal ones for other bytes. */
function unquote(text: string): string {
  // Octal escapes are bytes of UTF-8, so the work is done on bytes, one per character.
  const bytes = Buffer.from(text, "utf8").toString("latin1");
  const decoded = bytes.replace(/\\([0-7]{3}|x[0-9a-fA-F]{2}|[\s\S])/g, (_match, code: string) => {
    if (/^[0-7]{3}$/.test(code)) return String.fromCharCode(Number.parseInt(code, 8) & 0xff);
    if (code.length === 3) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    return C_ESCAPES[code] ?? code;
  });
  return Buffer.from(decoded, "latin1").toString("utf8");
}

/** `systemctl --user show-environment` output: `NAME=value`, with `$'...'` around a value that needs it. */
export function parseEnvironment(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const value = line.slice(eq + 1);
    const quoted = value.length >= 3 && value.startsWith("$'") && value.endsWith("'");
    env[line.slice(0, eq)] = quoted ? unquote(value.slice(2, -1)) : value;
  }
  return env;
}

/**
 * The systemd user manager's environment, which a desktop session tells its display, D-Bus address
 * and agent. It may hold other secrets, so callers read only the names they need, and none of it is
 * logged. Empty when there is no user manager.
 */
async function userManagerEnv(deps: PlatformDeps): Promise<Record<string, string>> {
  const systemctl = await deps.find("systemctl");
  if (systemctl === undefined) return {};
  const env: Record<string, string> = { PATH: deps.path, HOME: deps.home };
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = deps.env[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  const result = await deps.run(systemctl, ["--user", "show-environment"], {
    env,
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  return result.code === 0 ? parseEnvironment(result.stdout) : {};
}

/**
 * `desktopEnv()` for Linux and WSL2: PATH and HOME, plus `names` from the helper's environment,
 * filled in from the systemd user manager, since a login service can start before the desktop
 * session tells it anything. D-Bus falls back to `$XDG_RUNTIME_DIR/bus` when that socket is there.
 */
export function sessionEnv(
  deps: PlatformDeps,
  names: readonly string[],
): () => Promise<Record<string, string>> {
  return async () => {
    const env: Record<string, string> = { PATH: deps.path, HOME: deps.home };
    for (const name of names) {
      const value = deps.env[name];
      if (value !== undefined && value !== "") env[name] = value;
    }
    if (names.some((name) => env[name] === undefined)) {
      const manager = await userManagerEnv(deps).catch(() => ({}) as Record<string, string>);
      for (const name of names) {
        const value = manager[name];
        if (env[name] === undefined && value !== undefined && value !== "") env[name] = value;
      }
    }
    if (names.includes("DBUS_SESSION_BUS_ADDRESS") && env.DBUS_SESSION_BUS_ADDRESS === undefined) {
      const bus = env.XDG_RUNTIME_DIR === undefined ? undefined : join(env.XDG_RUNTIME_DIR, "bus");
      if (bus !== undefined && (await deps.exists(bus))) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
    }
    return env;
  };
}

/** `&`, `<` and `>` as markup entities, and backslashes doubled: notify-send reads escapes in the body. */
function notifyBody(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function linuxPlatform(
  deps: PlatformDeps,
  desktopEnv: () => Promise<Record<string, string>> = sessionEnv(deps, LINUX_DESKTOP_VARS),
): Platform {
  const keyring = createSecretService({ run: deps.run, find: deps.find, env: desktopEnv });
  const composeSocket = join(deps.majhiHome, "run", "ssh-agent.sock");
  const ownAgent = join(deps.majhiHome, "run", "agent.sock");
  let current: string | undefined;
  let lastNote = "";

  /**
   * `path` when something answers on it, so a dead socket left by a stopped agent is passed over.
   * Never the forwarder's own socket, which would forward to itself.
   */
  const candidate = async (
    path: string | undefined,
    source: string,
  ): Promise<{ path: string; source: string } | undefined> => {
    if (path === undefined || !isAbsolute(path) || resolve(path) === resolve(composeSocket)) return undefined;
    return (await reachable(path)) ? { path, source } : undefined;
  };
  const managerSocket = async (): Promise<string | undefined> =>
    (await userManagerEnv(deps).catch(() => ({}) as Record<string, string>)).SSH_AUTH_SOCK?.trim();

  const socket = async (): Promise<string | undefined> => {
    const found =
      (await candidate(deps.env.SSH_AUTH_SOCK?.trim(), "the helper's environment")) ??
      (await candidate(await managerSocket(), "the systemd user manager")) ??
      (await candidate(ownAgent, "majhi's own agent"));
    current = found?.path;
    const note = found === undefined ? "none" : `${found.path}|${found.source}`;
    if (note !== lastNote) {
      lastNote = note;
      if (found === undefined) {
        deps.log(`no SSH agent socket in the helper's environment, the systemd user manager or ${ownAgent}`);
      } else {
        deps.log(`SSH agent socket ${found.path} (from ${found.source})`);
      }
    }
    return current;
  };

  return {
    os: "linux",
    keyring,
    sshAgent: {
      socket,
      passphrases: async () => ((await keyring.check()).kind === "none" ? "none" : "keyring"),
      composeSocket,
      serve: () =>
        serveAgent({
          path: composeSocket,
          // The agent found last, so the container signs with the keys `ssh` loaded.
          upstream: async (failed) => (failed === undefined && current !== undefined ? current : socket()),
          log: deps.log,
        }),
    },
    notifier: {
      async show(request) {
        const notifySend = await deps.find("notify-send");
        if (notifySend !== undefined) {
          const args = ["--app-name=majhi", "--", request.title || "majhi", notifyBody(request.message)];
          const result = await deps.run(notifySend, args, {
            env: await desktopEnv(),
            timeoutMs: NOTIFY_TIMEOUT_MS,
          });
          if (result.code === 0) return { kind: "shown", clickable: false };
        }
        throw new Error(NOT_SHOWN);
      },
    },
    // `code` and `cursor` are on PATH, which takes in /snap/bin and ~/.local/bin.
    editor: { cliCandidates: async () => [] },
    docker: { start: async () => false, help: () => DOCKER_HELP },
    folders: { skippedAtHome: SKIPPED_AT_HOME },
    desktopEnv,
    openUrl: (url) => openUrl({ run: deps.run, find: deps.find, env: desktopEnv }, ["xdg-open"], url),
  };
}
