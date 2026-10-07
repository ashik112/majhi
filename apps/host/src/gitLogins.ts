/**
 * Finds out which accounts this computer is logged in as on git hosts: `gh` and `glab` logins, and the
 * SSH keys each host or `~/.ssh/config` alias accepts. Every probe is short and fails alone.
 * `detectGitLogins` never reads a token. `readGitToken` is the only code that does.
 */
import type { GitAcceptedKey, GitHostLogins, GitLogin } from "@majhi/shared";
import type { RunFn } from "./ssh.ts";

const KNOWN_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];
const CLI_TIMEOUT_MS = 8_000;
const SSH_TIMEOUT_MS = 9_000;

/** The account named by a git host's `ssh -T` greeting, or undefined when the key was not accepted. */
export function parseGreeting(output: string): string | undefined {
  if (/permission denied|could not resolve|connection (refused|timed out|closed)/i.test(output)) {
    return undefined;
  }
  const github = /\bHi ([A-Za-z0-9][A-Za-z0-9-]*)! You've successfully authenticated/.exec(output);
  if (github?.[1]) return github[1];
  const gitlab = /Welcome to GitLab, @([^\s!]+)!/.exec(output);
  if (gitlab?.[1]) return gitlab[1];
  const bitbucket = /logged in as ([^\s.]+(?:\.[^\s.]+)*?)\.?(?:\s|$)/i.exec(output);
  if (bitbucket?.[1]) return bitbucket[1];
  return undefined;
}

/**
 * True when the host took the key but its greeting names no account: Bitbucket answers
 * "authenticated via ssh key." and nothing else.
 */
export function acceptedWithoutAccount(output: string): boolean {
  if (/permission denied|could not resolve|connection (refused|timed out)/i.test(output)) return false;
  return /authenticated via ssh key/i.test(output) && parseGreeting(output) === undefined;
}

/**
 * The SHA256 fingerprint of the key the server accepted, from `ssh -v` output. ssh prints the
 * public key's fingerprint itself ("Server accepts key: <path> ED25519 SHA256:..."), so no key file is read.
 */
export function acceptedFingerprint(verbose: string): string | undefined {
  let found: string | undefined;
  for (const line of verbose.split(/\r?\n/)) {
    if (!line.includes("Server accepts key:")) continue;
    const word = line.split(/\s+/).find((w) => w.startsWith("SHA256:"));
    if (word !== undefined && word.length > "SHA256:".length) found = word;
  }
  return found;
}

/** Accounts per host from `gh auth status` or `glab auth status` output (stdout and stderr together). */
export function parseAuthStatus(output: string): Array<{ host: string; account: string }> {
  const out: Array<{ host: string; account: string }> = [];
  for (const m of output.matchAll(/Logged in to (\S+) (?:account|as) ([^\s(]+)/g)) {
    const host = m[1]?.toLowerCase();
    const account = m[2];
    if (host && account) out.push({ host, account });
  }
  return out;
}

/** `Host` aliases (no wildcards) with their `HostName`, lowercase. */
export function parseSshAliases(text: string): Array<{ alias: string; hostName: string }> {
  const out: Array<{ alias: string; hostName: string }> = [];
  let aliases: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(host|hostname|match)(?:\s*=\s*|\s+)(.*?)\s*$/i.exec(raw);
    if (!m) continue;
    const keyword = (m[1] ?? "").toLowerCase();
    const arg = m[2] ?? "";
    if (keyword === "host") aliases = arg.split(/\s+/).filter((a) => a !== "" && !/[*?!]/.test(a));
    else if (keyword === "match") aliases = [];
    else {
      const hostName = arg.split(/\s+/)[0]?.toLowerCase();
      if (hostName) for (const alias of aliases) out.push({ alias, hostName });
      aliases = [];
    }
  }
  return out;
}

export interface GitLoginsDeps {
  run: RunFn;
  readText: (path: string) => Promise<string | undefined>;
  home: string;
  path: string;
  /** The SSH agent's socket, as `platform.sshAgent.socket()` finds it. */
  socket: () => Promise<string | undefined>;
  /** Absolute path of `gh` or `glab`, or undefined when not installed. */
  find: (name: "gh" | "glab") => Promise<string | undefined>;
  /** The ssh that greets the git hosts. A test helper points it at one that never leaves the machine. */
  ssh: string;
}

function cliEnv(deps: GitLoginsDeps): Record<string, string> {
  return { PATH: deps.path, HOME: deps.home, NO_COLOR: "1", GH_PROMPT_DISABLED: "1" };
}

export async function detectGitLogins(
  deps: GitLoginsDeps,
  extraHosts: readonly string[],
): Promise<GitHostLogins[]> {
  const byHost = new Map<string, GitLogin[]>();
  const keysByHost = new Map<string, GitAcceptedKey[]>();
  const add = (host: string, login: GitLogin): void => {
    const list = byHost.get(host) ?? [];
    if (!list.some((l) => l.via === login.via && l.alias === login.alias && l.account === login.account)) {
      list.push(login);
    }
    byHost.set(host, list);
  };

  for (const via of ["gh", "glab"] as const) {
    try {
      const file = await deps.find(via);
      if (file === undefined) continue;
      const run = await deps.run(file, ["auth", "status"], { env: cliEnv(deps), timeoutMs: CLI_TIMEOUT_MS });
      for (const { host, account } of parseAuthStatus(`${run.stdout}\n${run.stderr}`)) {
        add(host, { via, account });
      }
    } catch {
      // This probe failed. The others still answer.
    }
  }

  const hosts = new Set([...KNOWN_HOSTS, ...extraHosts.map((h) => h.toLowerCase())]);
  const targets: Array<{ host: string; alias?: string; target: string }> = [...hosts].map((host) => ({
    host,
    target: host,
  }));
  const config = await deps.readText(`${deps.home}/.ssh/config`).catch(() => undefined);
  for (const { alias, hostName } of parseSshAliases(config ?? "")) {
    if (hosts.has(hostName)) targets.push({ host: hostName, alias, target: alias });
  }
  const socket = await deps.socket().catch(() => undefined);
  const env: Record<string, string> = {
    PATH: deps.path,
    HOME: deps.home,
    SSH_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS_REQUIRE: "never",
    ...(socket === undefined ? {} : { SSH_AUTH_SOCK: socket }),
  };
  await Promise.all(
    targets.map(async ({ host, alias, target }) => {
      try {
        const run = await deps.run(
          deps.ssh,
          ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", `git@${target}`],
          { env, timeoutMs: SSH_TIMEOUT_MS },
        );
        const account = parseGreeting(`${run.stdout}\n${run.stderr}`);
        const output = `${run.stdout}\n${run.stderr}`;
        if (account !== undefined) {
          add(host, { via: "ssh", ...(alias === undefined ? {} : { alias }), account });
        } else if (acceptedWithoutAccount(output)) {
          const verbose = await deps.run(
            deps.ssh,
            ["-T", "-v", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", `git@${target}`],
            { env, timeoutMs: SSH_TIMEOUT_MS },
          );
          const fingerprint = acceptedFingerprint(`${verbose.stdout}\n${verbose.stderr}`);
          const keys = keysByHost.get(host) ?? [];
          keys.push({
            ...(alias === undefined ? {} : { alias }),
            ...(fingerprint === undefined ? {} : { fingerprint }),
          });
          keysByHost.set(host, keys);
        }
      } catch {
        // Unreachable host: no login to report.
      }
    }),
  );
  const names = new Set([...byHost.keys(), ...keysByHost.keys()]);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((host) => {
      const keys = keysByHost.get(host);
      return { host, logins: byHost.get(host) ?? [], ...(keys === undefined ? {} : { keys }) };
    });
}

/** Reads one CLI login's token. The caller hands it to the org's secrets and keeps no copy. */
export async function readGitToken(
  deps: Pick<GitLoginsDeps, "run" | "home" | "path" | "find">,
  via: "gh" | "glab",
  host: string,
): Promise<string> {
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("That is not a git host name.");
  const file = await deps.find(via);
  if (file === undefined) throw new Error(`${via} is not installed on this computer.`);
  const args =
    via === "gh" ? ["auth", "token", "--hostname", host] : ["config", "get", "token", "--host", host];
  try {
    const run = await deps.run(file, args, {
      env: { PATH: deps.path, HOME: deps.home, NO_COLOR: "1" },
      timeoutMs: CLI_TIMEOUT_MS,
    });
    const token = run.stdout.trim();
    if (run.code !== 0 || token === "") throw new Error("no token");
    return token;
  } catch {
    // The message never carries the command output.
    throw new Error(`${via} has no login for ${host} on this computer.`);
  }
}
