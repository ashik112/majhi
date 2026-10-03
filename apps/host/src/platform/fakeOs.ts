/**
 * A fake OS for tests: programs answer from a table, paths exist from a set, and every run is
 * recorded. Nothing real runs. Only tests import this, so the helper's bundle never holds it.
 */
import { join } from "node:path";
import type { RunOptions, RunResult } from "../ssh.ts";
import type { PlatformDeps } from "./types.ts";

export type FakeProgram = (args: readonly string[], options: RunOptions) => RunResult | Promise<RunResult>;

export interface FakeOsOptions {
  /** Programs by absolute path. A program not here cannot start (`code: null`). */
  programs?: Record<string, FakeProgram>;
  /** Paths that exist, besides the programs. */
  files?: Iterable<string>;
  env?: Record<string, string | undefined>;
  home?: string;
  majhiHome?: string;
  path?: string;
}

export interface FakeRun {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

export const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
export const failed = (code = 1, stderr = ""): RunResult => ({ code, stdout: "", stderr });

/** Items a fake keyring holds, by `service|account`. */
export type FakeItems = Map<string, string>;

/**
 * macOS's `security`, holding `items` like the login Keychain. `security -i` reads one
 * `add-generic-password` command line from stdin. With `refuse`, it exits 0 and keeps nothing, as
 * `security -i` does after a failed command.
 */
export function fakeSecurity(items: FakeItems, options: { refuse?: boolean } = {}): FakeProgram {
  const value = (words: readonly string[], flag: string): string => words[words.indexOf(flag) + 1] ?? "";
  return (args, runOptions) => {
    const key = `${value(args, "-s")}|${value(args, "-a")}`;
    if (args[0] === "find-generic-password") {
      const secret = items.get(key);
      return secret === undefined
        ? failed(44, "The specified item could not be found in the keychain.")
        : ok(`${secret}\n`);
    }
    if (args[0] === "delete-generic-password") return items.delete(key) ? ok() : failed(44);
    if (args[0] === "-i") {
      const line = (runOptions.input ?? "").split("\n")[0] ?? "";
      const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
      if (words[0] === "add-generic-password" && !options.refuse) {
        items.set(`${value(words, "-s")}|${value(words, "-a")}`, value(words, "-w"));
      }
      return ok();
    }
    return failed(2);
  };
}

export type FakeKeyringState = "unlocked" | "locked" | "absent";

/**
 * `secret-tool` and `busctl` in /usr/bin for a Secret Service keyring holding `items`. `state` is
 * what the D-Bus probe finds, read at each call: an unlocked default collection, a locked one, or no
 * keyring service at all.
 */
export function fakeSecretService(
  items: FakeItems,
  state: FakeKeyringState | (() => FakeKeyringState) = "unlocked",
): Record<string, FakeProgram> {
  const now = (): FakeKeyringState => (typeof state === "function" ? state() : state);
  return {
    "/usr/bin/busctl": () => {
      if (now() === "absent") return failed(1, "Failed to get property Locked: The name is not activatable");
      return ok(now() === "locked" ? "b true\n" : "b false\n");
    },
    "/usr/bin/secret-tool": (args, runOptions) => {
      const at = (name: string): string => args[args.indexOf(name) + 1] ?? "";
      const key = `${at("service")}|${at("account")}`;
      if (now() !== "unlocked") return failed(1, "Cannot create an item in a locked collection");
      if (args[0] === "lookup") {
        const secret = items.get(key);
        return secret === undefined ? failed(1) : ok(secret);
      }
      if (args[0] === "store") {
        items.set(key, runOptions.input ?? "");
        return ok();
      }
      if (args[0] === "clear") {
        items.delete(key);
        return ok();
      }
      return failed(2, "usage");
    },
  };
}

export function fakeOs(options: FakeOsOptions = {}) {
  const home = options.home ?? "/home/owner";
  const path = options.path ?? "/usr/local/bin:/usr/bin:/bin";
  const programs = new Map(Object.entries(options.programs ?? {}));
  const files = new Set(options.files);
  const runs: FakeRun[] = [];
  const logs: string[] = [];
  const deps: PlatformDeps = {
    run: async (file, args, runOptions) => {
      runs.push({ file, args, options: runOptions });
      const program = programs.get(file);
      return program === undefined ? { code: null, stdout: "", stderr: "" } : program(args, runOptions);
    },
    env: options.env ?? {},
    home,
    majhiHome: options.majhiHome ?? join(home, ".majhi"),
    path,
    find: async (name) =>
      path
        .split(":")
        .filter((dir) => dir !== "")
        .map((dir) => join(dir, name))
        .find((candidate) => programs.has(candidate)),
    exists: async (file) => files.has(file) || programs.has(file),
    log: (message) => {
      logs.push(message);
    },
  };
  return { deps, runs, logs, programs, files };
}
