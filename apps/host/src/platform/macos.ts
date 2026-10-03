/**
 * macOS, as the helper always ran there: the login Keychain through `security`, launchd's SSH agent
 * with Apple's ssh-add keeping passphrases, the agent socket Docker Desktop and OrbStack give
 * containers, terminal-notifier (installed by majhi) or osascript, `open`, and OrbStack or Docker Desktop to start.
 */
import { join } from "node:path";
import type { EditorApp } from "@majhi/shared";
import { plainLine } from "../notify.ts";
import { openUrl } from "./openUrl.ts";
import { type NotifierRelease, TERMINAL_NOTIFIER, terminalNotifier } from "./terminalNotifier.ts";
import type { DockerHelpReason, Keyring, KeyringItem, Platform, PlatformDeps } from "./types.ts";

const SECURITY = "/usr/bin/security";
const LAUNCHCTL = "/bin/launchctl";
const OPEN = "/usr/bin/open";
const OSASCRIPT = "/usr/bin/osascript";
/** `security` exits with this when the item is not there. */
const NOT_FOUND = 44;
const KEYCHAIN_TIMEOUT_MS = 15_000;
const LAUNCHCTL_TIMEOUT_MS = 10_000;
const NOTIFY_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 15_000;
/** What Docker Desktop and OrbStack mount for the Mac's agent. */
const HOST_SERVICES_SOCKET = "/run/host-services/ssh-auth.sock";
const DOCKER_APPS = ["OrbStack", "Docker"] as const;

/** Each editor's app, and its command inside the app for when it is not on PATH. */
const EDITOR_APPS: Record<EditorApp, { appName: string; bundle: string }> = {
  vscode: { appName: "Visual Studio Code", bundle: "Visual Studio Code.app/Contents/Resources/app/bin/code" },
  cursor: { appName: "Cursor", bundle: "Cursor.app/Contents/Resources/app/bin/cursor" },
};

/**
 * Folders in home that hold apps, media, system data or virtual machines, never projects. `OrbStack`
 * is OrbStack's view into its containers and machines: slow to read (about 50 s for a few thousand
 * folders) and never a workspace root.
 */
const SKIPPED_AT_HOME = new Set([
  "Library",
  "Applications",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "OrbStack",
]);

const DOCKER_HELP: Record<DockerHelpReason, string> = {
  "not-started": "Install OrbStack or Docker Desktop, open it once, and majhi starts by itself.",
  slow: "Docker did not start in 2 minutes. Open OrbStack or Docker Desktop, and majhi starts by itself.",
};

/** True when nothing in `value` can end or break a quoted `security -i` argument. */
function plainField(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || ch === '"' || ch === "\\") return false;
  }
  return true;
}

/** Quoted for the `security -i` command line. Only used on fields `plainField` passed. */
function quote(value: string): string {
  return `"${value}"`;
}

function keychain(deps: PlatformDeps): Keyring {
  const env = { PATH: "/usr/bin:/bin" };

  const read = async (item: KeyringItem): Promise<string | undefined> => {
    const result = await deps.run(
      SECURITY,
      ["find-generic-password", "-s", item.service, "-a", item.account, "-w"],
      {
        env,
        timeoutMs: KEYCHAIN_TIMEOUT_MS,
      },
    );
    if (result.code === NOT_FOUND) return undefined;
    if (result.code !== 0) throw new Error("The Keychain did not answer. Is it locked?");
    return result.stdout.replace(/\n$/, "");
  };

  return {
    // The login Keychain is always there. A locked one shows when a call fails.
    check: async () => ({ kind: "keychain" }),
    read,
    async write(item, secret) {
      // `security -i` reads the secret inside a command line, so only plain words may go there.
      if (!/^[A-Za-z0-9-]+$/.test(secret)) throw new Error("This secret cannot go to the Keychain.");
      const fields = [item.service, item.account, item.label, item.comment ?? ""];
      if (!fields.every(plainField)) throw new Error("This item cannot go to the Keychain.");
      const command = [
        "add-generic-password",
        "-U",
        "-s",
        quote(item.service),
        "-a",
        quote(item.account),
        "-l",
        quote(item.label),
        ...(item.comment === undefined ? [] : ["-j", quote(item.comment)]),
        "-w",
        secret,
      ].join(" ");
      const result = await deps.run(SECURITY, ["-i"], {
        env,
        timeoutMs: KEYCHAIN_TIMEOUT_MS,
        input: `${command}\nquit\n`,
      });
      // `security -i` can exit 0 after a failed command, so the copy is read back to be sure.
      if (result.code !== 0 || (await read(item).catch(() => undefined)) !== secret) {
        throw new Error(`The Keychain did not take the ${item.label}. Is it locked?`);
      }
    },
    async remove(item) {
      const result = await deps.run(
        SECURITY,
        ["delete-generic-password", "-s", item.service, "-a", item.account],
        {
          env,
          timeoutMs: KEYCHAIN_TIMEOUT_MS,
        },
      );
      if (result.code !== 0 && result.code !== NOT_FOUND) {
        throw new Error("The Keychain did not answer. Is it locked?");
      }
    },
  };
}

/** AppleScript string text: one plain line, with quotes and backslashes escaped. */
function quoted(text: string): string {
  return `"${plainLine(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * AppleScript text for a notification. Quotes and backslashes are escaped and line breaks removed, so
 * a message cannot end the string or add a command.
 */
export function notificationScript(
  message: string,
  options: { title?: string; sound?: boolean } = {},
): string {
  const sound = options.sound === true ? ' sound name "Glass"' : "";
  return `display notification ${quoted(message)} with title ${quoted(options.title ?? "majhi")}${sound}`;
}

/** `notifierRelease` is the terminal-notifier release to install. Tests pin their own. */
export function macosPlatform(
  deps: PlatformDeps,
  options: { notifierRelease?: NotifierRelease } = {},
): Platform {
  const desktopEnv = async (): Promise<Record<string, string>> => ({ PATH: deps.path, HOME: deps.home });
  let lastSocketNote = "";
  const findTerminalNotifier = terminalNotifier(deps, options.notifierRelease ?? TERMINAL_NOTIFIER);

  return {
    os: "macos",
    keyring: keychain(deps),
    sshAgent: {
      /** The launchd agent's socket: the helper's own value, else `launchctl getenv`. */
      async socket() {
        const own = deps.env.SSH_AUTH_SOCK?.trim() || undefined;
        const got = await deps.run(LAUNCHCTL, ["getenv", "SSH_AUTH_SOCK"], {
          env: { PATH: deps.path, HOME: deps.home },
          timeoutMs: LAUNCHCTL_TIMEOUT_MS,
        });
        const launchd = got.code === 0 ? got.stdout.trim() || undefined : undefined;
        const socket = own ?? launchd;
        const note = `${socket ?? "none"}|${launchd ?? ""}`;
        if (note !== lastSocketNote) {
          lastSocketNote = note;
          if (socket === undefined) {
            deps.log("no SSH agent socket in the helper's environment or from launchctl");
          } else {
            const source = own === undefined ? "launchctl" : "the helper's environment";
            deps.log(`SSH agent socket ${socket} (from ${source})`);
            if (own !== undefined && launchd !== undefined && own !== launchd) {
              deps.log(
                `launchd holds a different agent socket, ${launchd}; the container is served by that one`,
              );
            }
          }
        }
        return socket;
      },
      passphrases: async () => "apple",
      // An older `make up` let SSH_AGENT_SOCK pick another socket, and the LaunchAgent passes it on.
      composeSocket: deps.env.SSH_AGENT_SOCK?.trim() || HOST_SERVICES_SOCKET,
      serve: () => () => undefined,
    },
    notifier: {
      /**
       * With terminal-notifier a click opens majhi at the page. When there is none the helper
       * installs its own copy in the background, and this one goes through osascript, which cannot
       * carry a click. `-group majhi` keeps majhi's notifications together. No `-sender`: 3.x
       * dropped it, and borrowing another app's identity would misattribute the notification.
       */
      async show(request) {
        const env = { PATH: deps.path };
        const program = await findTerminalNotifier();
        if (program !== undefined) {
          const args = ["-title", request.title, "-message", request.message, "-group", "majhi"];
          if (request.url !== undefined) args.push("-open", request.url);
          if (request.sound) args.push("-sound", "Glass");
          const done = await deps.run(program, args, { env, timeoutMs: NOTIFY_TIMEOUT_MS });
          if (done.code === 0) return { clickable: request.url !== undefined };
        }
        const script = notificationScript(request.message, { title: request.title, sound: request.sound });
        const done = await deps.run(OSASCRIPT, ["-e", script], { env, timeoutMs: NOTIFY_TIMEOUT_MS });
        if (done.code !== 0) {
          throw new Error("macOS did not show the notification. Check System Settings, Notifications.");
        }
        return { clickable: false };
      },
    },
    editor: {
      cliCandidates: async (app) =>
        ["/Applications", join(deps.home, "Applications")].map((dir) => join(dir, EDITOR_APPS[app].bundle)),
      async openApp(app, path) {
        const result = await deps.run(OPEN, ["-a", EDITOR_APPS[app].appName, path], {
          env: await desktopEnv(),
          timeoutMs: OPEN_TIMEOUT_MS,
        });
        return result.code === 0;
      },
    },
    docker: {
      async start() {
        for (const app of DOCKER_APPS) {
          for (const dir of ["/Applications", join(deps.home, "Applications")]) {
            if (!(await deps.exists(join(dir, `${app}.app`)))) continue;
            const opened = await deps.run(OPEN, ["-a", app], {
              env: await desktopEnv(),
              timeoutMs: OPEN_TIMEOUT_MS,
            });
            if (opened.code === 0) {
              deps.log(`startup: opened ${app}`);
              return true;
            }
            deps.log(`startup: could not open ${app}`);
          }
        }
        return false;
      },
      help: (reason) => DOCKER_HELP[reason],
    },
    folders: { skippedAtHome: SKIPPED_AT_HOME },
    desktopEnv,
    openUrl: (url) => openUrl({ run: deps.run, find: deps.find, env: desktopEnv }, ["open"], url),
  };
}
