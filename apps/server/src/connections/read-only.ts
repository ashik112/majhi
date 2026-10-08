import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseLine, ShellParseError, type SimpleCommand } from "./shell.ts";

/**
 * Which command lines only read (rule set 2026-10-08, "read-only commands never ask"). One typed table of
 * programs and their read subcommands, and one answer for the connection gate (what a CLI's arguments
 * do) and for the permission flow (a plain shell line). The line is read by the gate's scanner and each
 * command by its argv, never by a pattern over the whole line.
 *
 * Read-only is not the same as safe: a GET can carry data out. So the network programs reach only hosts
 * the workspace already knows, and the file readers only paths inside the task's folders. A line that
 * is not certainly a read is not one, and the usual rules ask.
 */

/** A program's read subcommands: `flat` as the first word, `groups` as the first word and a second one. */
interface ReadTable {
  flat?: ReadonlySet<string>;
  groups?: Readonly<Record<string, readonly string[]>>;
  /** The program reads by the first verb of its words, like `doctl compute droplet list`. */
  byVerb?: true;
}

export const KUBECTL_READS = new Set([
  "get",
  "describe",
  "logs",
  "top",
  "explain",
  "events",
  "version",
  "cluster-info",
  "api-resources",
  "api-versions",
  "diff",
]);
export const KUBECTL_READ_PAIRS: Record<string, readonly string[]> = {
  auth: ["can-i", "whoami"],
  config: ["view", "get-contexts", "current-context"],
  rollout: ["status", "history"],
};
/**
 * Verbs of env CLIs and remote commands that only read: SPEC 5.14's list, plus the listing verbs of
 * container CLIs (`docker ps`, `docker inspect`).
 */
export const CLI_READ_VERBS = new Set([
  "get",
  "list",
  "describe",
  "show",
  "ls",
  "logs",
  "status",
  "view",
  "whoami",
  "ps",
  "inspect",
  "version",
  "info",
  "top",
  "history",
]);
/** Verbs that change something. A command whose first verb is one of these is a write. */
export const CLI_WRITE_VERBS = new Set([
  "create",
  "delete",
  "rm",
  "remove",
  "put",
  "update",
  "set",
  "apply",
  "patch",
  "edit",
  "replace",
  "scale",
  "restart",
  "run",
  "exec",
  "start",
  "stop",
  "kill",
  "terminate",
  "deploy",
  "destroy",
  "drop",
  "insert",
  "cp",
  "mv",
  "sync",
  "write",
  "send",
  "post",
  "add",
  "modify",
  "reboot",
  "purge",
  "invoke",
  "publish",
  "upload",
  "import",
  "restore",
  "revoke",
  "grant",
  "tag",
  "untag",
  "push",
  "cancel",
  "enable",
  "disable",
  "attach",
  "detach",
  "install",
  "uninstall",
  "upgrade",
  "reset",
  "rotate",
  "copy",
  "move",
  "rename",
  "truncate",
]);
/** The first word of the arguments that is a known verb, or a word starting with one (`describe-instances`). */
export function firstVerb(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const head = arg.toLowerCase().split(/[-_]/, 1)[0] ?? "";
    if (CLI_READ_VERBS.has(head) || CLI_WRITE_VERBS.has(head)) return head;
  }
  return undefined;
}

/**
 * Whether a CLI's arguments read: by their first verb. Only flags (`--version`, `--help`) read; words
 * with no verb among them count as unknown.
 */
export function cliVerb(args: readonly string[]): "read" | "write" | "unknown" {
  if (args.every((a) => a.startsWith("-"))) return "read";
  const verb = firstVerb(args);
  if (verb === undefined) return "unknown";
  return CLI_READ_VERBS.has(verb) ? "read" : "write";
}

const set = (...words: string[]) => new Set(words);

/** Programs with a subcommand table. A word in no list is not a read. */
const READ_TABLE: Readonly<Record<string, ReadTable>> = {
  gh: {
    flat: set("status", "version"),
    groups: {
      pr: ["diff", "view", "list", "status", "checks"],
      run: ["view", "list", "watch"],
      issue: ["view", "list", "status"],
      repo: ["view", "list"],
      release: ["view", "list"],
      workflow: ["view", "list"],
      label: ["list"],
      search: ["prs", "issues", "repos", "code", "commits"],
      api: [],
    },
  },
  glab: {
    flat: set("version"),
    groups: {
      mr: ["view", "list", "diff"],
      issue: ["view", "list"],
      ci: ["view", "list", "status", "trace"],
      pipeline: ["list", "view", "status"],
      repo: ["view", "list"],
      release: ["view", "list"],
      api: [],
    },
  },
  git: {
    flat: set(
      "log",
      "diff",
      "show",
      "status",
      "ls-remote",
      "ls-files",
      "blame",
      "rev-parse",
      "describe",
      "shortlog",
    ),
  },
  docker: {
    flat: set("ps", "inspect", "logs", "images", "version", "info", "top", "history"),
    groups: {
      container: ["ls", "ps", "inspect", "logs", "top"],
      image: ["ls", "inspect", "history"],
      compose: ["ps", "logs", "ls", "config"],
      volume: ["ls", "inspect"],
      network: ["ls", "inspect"],
    },
  },
  kubectl: { flat: KUBECTL_READS, groups: KUBECTL_READ_PAIRS },
  doctl: { byVerb: true },
  hcloud: { byVerb: true },
};

/** Flags of `gh api` and `glab api` that make the request a write or send a body. */
const API_WRITE_FLAGS = set(
  "-X",
  "--method",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
  "-d",
  "--data",
);
/** Words of a kubectl command that name what must not be read without asking. */
const KUBECTL_SECRETS = set("secret", "secrets");
/** Flags that make a git read write a file or run a program. */
const GIT_UNSAFE = ["--output", "--ext-diff", "--textconv", "-c", "-C", "--exec"];

/**
 * What a CLI's arguments do, by its table: `read`, `write`, or undefined when the program has no table
 * (the caller then has its own rule). Global flags before the subcommand are not read: an unknown shape asks.
 */
export function programReads(
  program: string,
  args: readonly string[],
): "read" | "write" | "unknown" | undefined {
  const table = READ_TABLE[program];
  if (table === undefined) return undefined;
  if (table.byVerb === true) return cliVerb(args);
  if (args.length > 0 && args.every((a) => a.startsWith("-")))
    return args.every((a) => a === "--version" || a === "--help" || a === "-h") ? "read" : "write";
  const [first, second] = args;
  if (first === undefined || first.startsWith("-")) return "write";
  if (program === "git" && args.some((a) => GIT_UNSAFE.some((u) => a === u || a.startsWith(`${u}=`))))
    return "write";
  if (
    program === "kubectl" &&
    args.some((a) =>
      a
        .split("/")
        .flatMap((x) => x.split(","))
        .some((part) => KUBECTL_SECRETS.has(part)),
    )
  )
    return "write";
  const group = table.groups?.[first];
  if (group !== undefined) {
    if (first === "api")
      return args.some((a) => API_WRITE_FLAGS.has(a.split("=")[0] ?? "")) ? "write" : "read";
    return second !== undefined && group.includes(second) ? "read" : "write";
  }
  return table.flat?.has(first) === true ? "read" : "write";
}

/** Programs that only read the files they are given. Every word that is not a flag must be a path inside the task. */
const FILE_READERS = set(
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "jq",
  "ls",
  "wc",
  "cut",
  "stat",
  "file",
  "du",
);

/** curl flags that take no value and only change how the answer is shown. */
const CURL_PLAIN = new Set("sSLIifkv");
const CURL_PLAIN_LONG = set(
  "--silent",
  "--show-error",
  "--location",
  "--head",
  "--include",
  "--fail",
  "--insecure",
  "--compressed",
  "--verbose",
);
/** curl flags that take one value and send nothing out but a header or a limit. */
const CURL_VALUED = set(
  "-m",
  "--max-time",
  "--connect-timeout",
  "--retry",
  "-w",
  "--write-out",
  "-H",
  "--header",
  "-A",
  "--user-agent",
);
const WGET_PLAIN = set("-q", "--quiet", "-S", "--server-response", "--spider", "--no-check-certificate");

/** Hosts a run may always reach: its own machine. */
const LOOPBACK = set("localhost", "127.0.0.1", "[::1]", "::1");

/** What a line is read against. */
export interface ReadScope {
  /** The task's folders: its worktrees, its folder and its read mounts. Relative paths start at `cwd`. */
  roots: readonly string[];
  cwd: string;
  /** Hosts of the workspace: its environments' check addresses, its git hosts and its connections. Lower case. */
  hosts: ReadonlySet<string>;
}

/** The host of a URL a command is given, or undefined when it is not a plain http(s) address. */
function hostOfAddress(word: string): string | undefined {
  if (!word.startsWith("http://") && !word.startsWith("https://")) return undefined;
  try {
    const url = new URL(word);
    return url.username === "" && url.password === "" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function knownHost(host: string | undefined, scope: ReadScope): boolean {
  return host !== undefined && (LOOPBACK.has(host) || scope.hosts.has(host));
}

function curlReads(args: readonly string[], scope: ReadScope): boolean {
  let addresses = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "-o" || arg === "--output") {
      if (args[++i] !== "/dev/null") return false;
    } else if (arg === "-X" || arg === "--request") {
      if (args[++i] !== "GET" && args[i] !== "HEAD") return false;
    } else if (CURL_VALUED.has(arg)) {
      if (args[++i] === undefined) return false;
    } else if (CURL_PLAIN_LONG.has(arg)) {
    } else if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
      if (![...arg.slice(1)].every((c) => CURL_PLAIN.has(c))) return false;
    } else if (arg.startsWith("-")) {
      return false;
    } else {
      addresses++;
      if (!knownHost(hostOfAddress(arg), scope)) return false;
    }
  }
  return addresses > 0;
}

function wgetReads(args: readonly string[], scope: ReadScope): boolean {
  let addresses = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "-O" || arg === "--output-document") {
      if (args[++i] !== "-" && args[i] !== "/dev/null") return false;
    } else if (WGET_PLAIN.has(arg) || arg.startsWith("--timeout=") || arg.startsWith("--tries=")) {
    } else if (arg.startsWith("-")) {
      return false;
    } else {
      addresses++;
      if (!knownHost(hostOfAddress(arg), scope)) return false;
    }
  }
  return addresses > 0;
}

/** httpie: an optional GET and an address. Any item (`key=value`, `key:header`) could send data, so none passes. */
function httpieReads(args: readonly string[], scope: ReadScope): boolean {
  const words = args.filter((a) => !a.startsWith("--") || a === "--");
  const rest = words[0] === "GET" ? words.slice(1) : words;
  const [address, ...items] = rest;
  return (
    items.length === 0 &&
    knownHost(hostOfAddress(address ?? ""), scope) &&
    args.every(
      (a) =>
        !a.startsWith("-") ||
        ["--headers", "--body", "--print=hb", "--follow", "--check-status", "--verbose"].includes(a),
    )
  );
}

/** The path with every symlink followed in the part that exists: a file that is not there yet is judged by its folder. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOf(parent), basename(path));
  }
}

function insideRoots(word: string, scope: ReadScope): boolean {
  if (word === "-" || word === "") return true;
  if (word.startsWith("~")) return false;
  const full = realOf(isAbsolute(word) ? resolve(word) : resolve(scope.cwd, word));
  return scope.roots.some((root) => {
    const base = realOf(resolve(root));
    return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

function filesRead(args: readonly string[], scope: ReadScope): boolean {
  return args.every((arg) => {
    if (!arg.startsWith("-")) return insideRoots(arg, scope);
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "";
    return value === "" || !(isAbsolute(value) || value.startsWith("~")) || insideRoots(value, scope);
  });
}

/** Redirects that write nothing to a file: to /dev/null or to another descriptor. */
function quietRedirect(r: SimpleCommand["redirects"][number]): boolean {
  return r.op !== "<<" && r.op !== "<" && (r.target === "/dev/null" || r.target.startsWith("&"));
}

function name(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function commandReads(cmd: SimpleCommand, scope: ReadScope): boolean {
  if (!cmd.redirects.every(quietRedirect)) return false;
  const [first, ...args] = cmd.words;
  if (first === undefined || cmd.words.some((w) => w.includes("$") || w.includes("`"))) return false;
  const program = name(first);
  if (first.includes("/") && !isAbsolute(first)) return false;
  if (program === "curl") return curlReads(args, scope);
  if (program === "wget") return wgetReads(args, scope);
  if (program === "http" || program === "https") return httpieReads(args, scope);
  if (FILE_READERS.has(program)) return filesRead(args, scope);
  return programReads(program, args) === "read";
}

/** The programs of a line that reach a network address, for the caller to fetch the workspace's hosts only then. */
export function reachesNetwork(line: string): boolean {
  try {
    return parseLine(line).commands.some((c) =>
      ["curl", "wget", "http", "https"].includes(name(c.words[0] ?? "")),
    );
  } catch {
    return false;
  }
}

/**
 * Whether every command of the line only reads. A pipeline reads only if every stage does; a redirect into
 * a file, a command inside the command, a variable or an unreadable line is not a read.
 */
export function lineOnlyReads(line: string, scope: ReadScope): boolean {
  let parsed: ReturnType<typeof parseLine>;
  try {
    parsed = parseLine(line);
  } catch (err) {
    if (err instanceof ShellParseError) return false;
    throw err;
  }
  if (parsed.substitutions.length > 0 || parsed.commands.length === 0) return false;
  return parsed.commands.every((c) => commandReads(c, scope));
}
