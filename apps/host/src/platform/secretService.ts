/**
 * The Secret Service keyring on Linux and WSL2 (GNOME Keyring, KWallet, KeePassXC) through
 * libsecret's `secret-tool`. `secret-tool` on a locked collection pops an unlock dialog, which a
 * login service must never cause, so every use first asks D-Bus whether the default collection is
 * unlocked (decision 4). The secret goes to `secret-tool store` on stdin and comes back on stdout.
 * It is never in an argument, a log line or an error.
 */
import type { KeyringState } from "@majhi/shared";
import type { RunFn } from "../ssh.ts";
import type { Keyring, KeyringItem } from "./types.ts";

const PROBE_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 15_000;

const LOCKED_PROPERTY = [
  "--user",
  "get-property",
  "org.freedesktop.secrets",
  "/org/freedesktop/secrets/aliases/default",
  "org.freedesktop.Secret.Collection",
  "Locked",
];

const NO_SECRET_TOOL =
  "secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch).";
const NO_BUSCTL = "The keyring cannot be checked without busctl (systemd).";
const NO_ANSWER = "The keyring did not answer.";

/** The names a keyring call gets from the desktop session. */
const BUS_VARS = ["PATH", "HOME", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];

export interface SecretServiceDeps {
  run: RunFn;
  find: (name: string) => Promise<string | undefined>;
  /** `desktopEnv()`. Only PATH, HOME and the D-Bus variables are passed on. */
  env: () => Promise<Record<string, string>>;
}

export function createSecretService(deps: SecretServiceDeps): Keyring {
  const busEnv = async (): Promise<Record<string, string>> => {
    const session = await deps.env();
    const env: Record<string, string> = {};
    for (const name of BUS_VARS) {
      const value = session[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  };

  const check = async (): Promise<KeyringState> => {
    if ((await deps.find("secret-tool")) === undefined) return { kind: "none", reason: NO_SECRET_TOOL };
    const busctl = await deps.find("busctl");
    if (busctl === undefined) return { kind: "none", reason: NO_BUSCTL };
    const probe = await deps.run(busctl, LOCKED_PROPERTY, {
      env: await busEnv(),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const answer = probe.code === 0 ? probe.stdout.trim() : "";
    if (answer === "b false") return { kind: "secret-service" };
    if (answer === "b true") return { kind: "none", reason: "The keyring is locked." };
    return { kind: "none", reason: "No keyring is running." };
  };

  /** `secret-tool` once the keyring answered unlocked, else the reason it did not. */
  const ready = async (): Promise<string> => {
    const state = await check();
    if (state.kind === "none") throw new Error(state.reason);
    const tool = await deps.find("secret-tool");
    if (tool === undefined) throw new Error(NO_SECRET_TOOL);
    return tool;
  };

  const attributes = (item: KeyringItem): string[] => ["service", item.service, "account", item.account];

  /** `secret-tool` exits 1 with nothing on stderr when no item matched. */
  const notFound = (result: { code: number | null; stderr: string }): boolean =>
    result.code === 1 && result.stderr.trim() === "";

  const lookup = async (tool: string, item: KeyringItem): Promise<string | undefined> => {
    const result = await deps.run(tool, ["lookup", ...attributes(item)], {
      env: await busEnv(),
      timeoutMs: CALL_TIMEOUT_MS,
    });
    if (result.code === 0) return result.stdout;
    if (notFound(result)) return undefined;
    throw new Error(NO_ANSWER);
  };

  return {
    check,
    async read(item) {
      return lookup(await ready(), item);
    },
    async write(item, secret) {
      const tool = await ready();
      // The whole of stdin is the secret, so it goes without a trailing newline.
      await deps.run(tool, ["store", `--label=${item.label}`, ...attributes(item)], {
        env: await busEnv(),
        timeoutMs: CALL_TIMEOUT_MS,
        input: secret,
      });
      // As on macOS, the copy is read back rather than trusting the exit code.
      const back = await lookup(tool, item).catch(() => undefined);
      if (back !== secret) throw new Error(`The keyring did not take the ${item.label}.`);
    },
    async remove(item) {
      const tool = await ready();
      const result = await deps.run(tool, ["clear", ...attributes(item)], {
        env: await busEnv(),
        timeoutMs: CALL_TIMEOUT_MS,
      });
      if (result.code !== 0 && !notFound(result)) throw new Error(NO_ANSWER);
    },
  };
}
