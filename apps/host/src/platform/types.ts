/**
 * The host helper's per-OS parts, behind one interface. `createPlatform` builds the one `detectOs`
 * names at start. Nothing else in the helper reads `process.platform` or names an OS program.
 * Implementations run programs only through `deps.run`, so a test fakes an OS by faking its programs.
 *
 * macOS: launchd, the Keychain, Docker's host-services SSH socket, majhi's notifier app or terminal-notifier,
 * `open`. Linux: systemd user units, a Secret Service keyring through `secret-tool`, the session's
 * SSH agent, `notify-send`, `xdg-open`. WSL2: Linux, plus Docker Desktop, the browser, the editor
 * and toasts on the Windows side, reached through WSL interop.
 */
import type { EditorApp, HostOs, KeyringState } from "@majhi/shared";
import type { Download } from "../download.ts";
import type { Logger } from "../log.ts";
import type { RunFn } from "../ssh.ts";

export interface PlatformDeps {
  run: RunFn;
  /** The helper's own environment. A program gets only the variables it needs from it. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** `~/.majhi`, or MAJHI_HOME. */
  majhiHome: string;
  /** The helper's PATH with `toolDirs` added. */
  path: string;
  /** The absolute path of the first executable `name` on `path`, or undefined. */
  find: (name: string) => Promise<string | undefined>;
  exists: (path: string) => Promise<boolean>;
  log: Logger;
  /**
   * Fetches a pinned tool the helper installs itself (macOS: terminal-notifier). Absent where
   * nothing may be downloaded, as with MAJHI_HOST_NOTIFY=off.
   */
  download?: Download;
}

export interface Platform {
  os: HostOs;
  keyring: Keyring;
  sshAgent: SshAgentPlatform;
  notifier: Notifier;
  editor: EditorPlatform;
  docker: DockerPlatform;
  folders: FolderRules;
  /**
   * What a desktop program (browser, editor, notification) needs: PATH and HOME, and on Linux and
   * WSL2 the display, D-Bus and WSL interop variables. A login service can start before the desktop
   * session does, so these are read again on each call (`systemctl --user show-environment`).
   */
  desktopEnv(): Promise<Record<string, string>>;
  /** Opens an http(s) page in the owner's browser. False when nothing opened it. Never throws. */
  openUrl(url: string): Promise<boolean>;
  /** Puts `text` on the owner's clipboard through a program's stdin. False when none worked. Never throws, never logs the text. */
  clipboardCopy(text: string): Promise<boolean>;
}

export type CreatePlatform = (os: HostOs, deps: PlatformDeps) => Platform;

/** Where a secret sits in the keyring. Names are fixed strings or a key path, never other input. */
export interface KeyringItem {
  /** What Keychain Access or a keyring app lists the item as. */
  label: string;
  service: string;
  account: string;
  /** macOS only: the comment Keychain Access shows. A Secret Service item has none. */
  comment?: string;
}

/** The copy of the secrets key. The names are the ones macOS copies already use. */
export const SECRETS_KEY_ITEM: KeyringItem = {
  label: "majhi secrets key",
  service: "majhi secrets key",
  account: "secrets.key",
  comment: "Restores ~/.config/majhi/secrets.key, the key that decrypts ~/.majhi/secrets.age",
};

/** Where an SSH key's passphrase is kept on Linux and WSL2. `key` is the private key's path with `~`. */
export function sshPassphraseItem(key: string): KeyringItem {
  return { label: `majhi SSH key passphrase for ${key}`, service: "majhi ssh key", account: key };
}

export interface Keyring {
  /**
   * Looks for a keyring that answers without showing a prompt. Cheap enough to call before each
   * use. Never throws: a missing or locked keyring is `none` with the reason in plain words.
   */
  check(): Promise<KeyringState>;
  /** The secret, or undefined when there is none. Throws in plain words when the keyring did not answer. */
  read(item: KeyringItem): Promise<string | undefined>;
  /**
   * Saves `secret` over whatever the item held, then reads it back. Throws in plain words when the
   * keyring did not take it. The secret goes to the program on stdin, never in its arguments, and
   * is never logged or put in an error. macOS takes only letters, digits and dashes (the secrets
   * key), because `security -i` reads the secret inside a command line.
   */
  write(item: KeyringItem, secret: string): Promise<void>;
  /** Deletes the item. One that is not there is fine. Throws when the keyring did not answer. */
  remove(item: KeyringItem): Promise<void>;
}

/**
 * Where a passphrase given through `ssh.unlock` is kept, so the key loads again after a restart:
 * - `apple`: Apple's ssh-add keeps it in the Keychain (`--apple-use-keychain`) and loads it again
 *   (`--apple-load-keychain`).
 * - `keyring`: the helper keeps it in the keyring (`sshPassphraseItem`) and hands it to ssh-add
 *   through a throwaway askpass on each check. A kept passphrase that no longer works is removed.
 * - `none`: nowhere. The key stays loaded until its agent stops, then needs its passphrase again.
 */
export type PassphraseKeeping = "apple" | "keyring" | "none";

export interface SshAgentPlatform {
  /**
   * The agent the helper loads keys into, or undefined when none is there. macOS: the helper's
   * SSH_AUTH_SOCK, else `launchctl getenv SSH_AUTH_SOCK`. Linux and WSL2: the helper's
   * SSH_AUTH_SOCK, else the one in `systemctl --user show-environment`, else majhi's own agent at
   * `~/.majhi/run/agent.sock` (the majhi-ssh-agent user unit). A path that is not a socket is
   * skipped, and `composeSocket` is never the answer.
   */
  socket(): Promise<string | undefined>;
  /** How a passphrase is kept. Linux and WSL2 follow `keyring.check()`. */
  passphrases(): Promise<PassphraseKeeping>;
  /**
   * The agent socket majhi's server container uses, given to compose as MAJHI_SSH_AGENT. macOS:
   * `/run/host-services/ssh-auth.sock`, which Docker Desktop and OrbStack provide. Linux and WSL2:
   * the absolute `~/.majhi/run/ssh-agent.sock` that `serve` listens on, which the container reaches
   * through its `~/.majhi` mount.
   */
  composeSocket: string;
  /**
   * Linux and WSL2: listens on `composeSocket` (mode 0600, replacing a stale socket file) and pipes
   * each connection to `socket()`'s agent, so the container's path stays the same when that agent
   * restarts or changes. Failures go to the log. macOS: does nothing. Returns a function that stops it.
   */
  serve(): () => void;
}

export interface NotifyRequest {
  /** One plain line each, already made safe by `plainLine`. */
  title: string;
  message: string;
  /** The majhi page a click opens, already checked by `clickUrl`. */
  url: string | undefined;
  sound: boolean;
}

/**
 * What a desktop notification came to. `blocked`: the OS has notifications off for majhi's notifier
 * (macOS exit code 3), which only the owner can turn on. `unavailable`: no notifier is installed
 * yet. `failed`: it ran and did not show one.
 */
export type NotifyOutcome =
  | { kind: "shown"; clickable: boolean }
  | { kind: "blocked" }
  | { kind: "unavailable" }
  | { kind: "failed"; error: string };

export interface Notifier {
  /**
   * Shows a desktop notification. `clickable` is true when a click opens `url`. macOS: majhi's own
   * notifier app (clickable), else terminal-notifier, never osascript (its notifications come from
   * Script Editor); the outcome says why nothing showed. Linux: `notify-send`. WSL2: a Windows
   * toast through `powershell.exe` (clickable). Linux and WSL2 throw in plain words when nothing was
   * shown; the server then keeps the notice in the app only.
   */
  show(request: NotifyRequest): Promise<NotifyOutcome>;
  /** macOS: builds or installs the notifier now, so the first notification is not lost. */
  prepare?(): Promise<void>;
  /** macOS: opens System Settings at Notifications. */
  openSettings?(): Promise<boolean>;
}

export interface EditorPlatform {
  /**
   * Where `app`'s command may be when it is not on PATH. macOS: inside the app in /Applications or
   * ~/Applications. WSL2: the Windows install's `bin` folder, under the Windows user's folder in
   * /mnt/c/Users. Linux: none.
   */
  cliCandidates(app: EditorApp): Promise<string[]>;
  /** macOS only: opens `path` with the app itself (`open -a`). False when the app is not there. */
  openApp?(app: EditorApp, path: string): Promise<boolean>;
}

/** Why Docker is still down: nothing could be started, or it did not come up in 2 minutes. */
export type DockerHelpReason = "not-started" | "slow";

export interface DockerPlatform {
  /**
   * Starts Docker when it is down. True when it started something to wait for: OrbStack or Docker
   * Desktop on macOS, Docker Desktop for Windows from WSL2. False when there is nothing to start, as
   * on Linux, where Docker Engine is a system service that needs root.
   */
  start(): Promise<boolean>;
  /** The one step the owner must take when Docker stays down, for the notification. */
  help(reason: DockerHelpReason): string;
}

export interface FolderRules {
  /** First-level folders of home that never hold projects: apps, media, system data, VMs. */
  skippedAtHome: ReadonlySet<string>;
}
