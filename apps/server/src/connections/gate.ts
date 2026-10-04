import type { ConnectionType } from "@majhi/shared";
import { parseLine, ShellParseError, type SimpleCommand } from "./shell.ts";

/**
 * The connection gate (SPEC 5.14). Pure: it classifies a shell command line or an MCP tool call
 * against the connections a run holds. A line made only of connection reads runs without asking; a
 * connection write always asks the owner, unless the connection's `allow` holds that exact action.
 * What the gate cannot read counts as a write. The real guard stays the credential: a script that
 * calls kubectl inside it is not seen here.
 */

/** What the gate knows of one connection a run holds. */
export interface GateConnection {
  id: string;
  type: ConnectionType;
  /** kubectl: the context name in the run's kubeconfig. */
  context?: string | undefined;
  /** env: the CLIs it is for. */
  clis?: readonly string[] | undefined;
  /** mcp, browser, a mail MCP server: the name of its MCP server on the session. */
  server?: string | undefined;
  /** Tool names that read, whatever their names say. */
  readTools?: readonly string[] | undefined;
  /** Tool names that write, whatever their names say. */
  writeTools?: readonly string[] | undefined;
  /** The exact actions the org allows without asking. */
  allow: readonly string[];
}

export interface GateWrite {
  /** The connection written to. Undefined when the gate could not tell which. */
  connection: string | undefined;
  /** The action as the owner allows it: a command (`kubectl rollout restart deployment/api`) or a tool name. */
  action: string;
  /** Why it counts as a write, in a few words. */
  why: string;
  /** The connection's `allow` holds this exact action. */
  allowed: boolean;
}

export type GateVerdict =
  /** Not about a connection: the usual permission rules decide. */
  | { kind: "other" }
  /** Only reads of connections: runs without asking. */
  | { kind: "read"; connections: string[] }
  /** Changes a connection: asks the owner unless every write is allowed. */
  | { kind: "write"; writes: GateWrite[] };

/** A pipe into these keeps a line of reads a read. */
const FILTERS = new Set(["grep", "egrep", "fgrep", "head", "tail", "wc", "sort", "uniq", "jq", "cut"]);

/** Commands that only start another command, and how many of their own words to skip. */
const WRAPPERS = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "nice",
  "time",
  "timeout",
  "stdbuf",
  "ionice",
  "sudo",
  "xargs",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const KUBECTL_READS = new Set([
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
const KUBECTL_READ_PAIRS: Record<string, readonly string[]> = {
  auth: ["can-i", "whoami"],
  config: ["view", "get-contexts", "current-context"],
  rollout: ["status", "history"],
};
/** Global flags that take a value, so the word after them is not the subcommand. */
const KUBECTL_VALUE_FLAGS = new Set([
  "-n",
  "--namespace",
  "--context",
  "--request-timeout",
  "-v",
  "--v",
  "--cache-dir",
  "-o",
  "--output",
]);
/** Flags that would reach the cluster as someone or somewhere else than the connection says. */
const KUBECTL_IDENTITY_FLAGS = new Set([
  "--kubeconfig",
  "--token",
  "--as",
  "--as-group",
  "--as-uid",
  "-s",
  "--server",
  "--cluster",
  "--user",
  "--username",
  "--password",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--insecure-skip-tls-verify",
  "--tls-server-name",
]);

/**
 * Verbs of env CLIs and remote commands that only read: SPEC 5.14's list, plus the listing verbs of
 * container CLIs (`docker ps`, `docker inspect`).
 */
const CLI_READ_VERBS = new Set([
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
const CLI_WRITE_VERBS = new Set([
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
/** Programs of a remote command that only read. */
const REMOTE_READ_PROGRAMS = new Set([
  ...FILTERS,
  "cat",
  "ls",
  "df",
  "du",
  "free",
  "uptime",
  "ps",
  "uname",
  "hostname",
  "whoami",
  "id",
  "date",
  "pwd",
  "stat",
  "which",
]);
/** journalctl reads, except with these, which delete or rotate the journal. */
const JOURNAL_WRITES = /^--(?:vacuum|rotate|flush|relinquish|sync)/;

/**
 * MCP tool names (SPEC 5.14): one with a read verb in it is a read, unless a write verb is in it too.
 * The verb can come after the object (`droplet-list`, `db-cluster-get`), so every word counts.
 */
const TOOL_READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "query",
  "describe",
  "fetch",
  "read",
  "show",
  "find",
  "count",
]);
const TOOL_WRITE_VERBS = new Set([
  "create",
  "update",
  "delete",
  "send",
  "post",
  "restart",
  "run",
  "execute",
  "write",
  "set",
  "mute",
  "ack",
  "close",
  "add",
  "remove",
  "edit",
  "modify",
  "patch",
  "put",
  "apply",
  "replace",
  "rename",
  "move",
  "copy",
  "upload",
  "import",
  "attach",
  "detach",
  "assign",
  "unassign",
  "enable",
  "disable",
  "start",
  "stop",
  "reboot",
  "shutdown",
  "power",
  "resize",
  "scale",
  "rebuild",
  "restore",
  "deploy",
  "rollback",
  "cancel",
  "approve",
  "merge",
  "upgrade",
  "install",
  "uninstall",
  "kill",
  "terminate",
  "destroy",
  "purge",
  "reset",
  "rotate",
  "revoke",
  "grant",
  "tag",
  "untag",
  "promote",
  "migrate",
  "trigger",
  "invoke",
  "snooze",
  "resolve",
  "reply",
  "comment",
  "publish",
  "transfer",
]);

/** Mail senders, for a run that holds a mail connection: sending mail is a write. */
const MAIL_SENDERS = new Set(["sendmail", "mail", "mailx", "msmtp", "swaks", "mutt"]);

/** The words of a tool name: `listAlertPolicies` and `list_alert_policies` both give list, alert, policies. */
export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.\-/:]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w !== "");
}

/** How an MCP tool call of one of the run's connection servers counts. */
export function classifyTool(server: string, tool: string, held: readonly GateConnection[]): GateVerdict {
  const connection = held.find((c) => c.server !== undefined && c.server === server);
  if (connection === undefined) return { kind: "other" };
  const read = connection.writeTools?.includes(tool)
    ? false
    : connection.readTools?.includes(tool)
      ? true
      : (() => {
          const words = toolWords(tool);
          return words.some((w) => TOOL_READ_VERBS.has(w)) && !words.some((w) => TOOL_WRITE_VERBS.has(w));
        })();
  if (read) return { kind: "read", connections: [connection.id] };
  return {
    kind: "write",
    writes: [
      {
        connection: connection.id,
        action: tool,
        why: "its name does not say it only reads",
        allowed: connection.allow.includes(tool),
      },
    ],
  };
}

/** How a command line counts against the run's connections. */
export function classifyCommand(line: string, held: readonly GateConnection[]): GateVerdict {
  if (held.length === 0) return { kind: "other" };
  const result = new LineResult();
  try {
    readLine(line, held, result, 0);
  } catch (err) {
    if (!(err instanceof ShellParseError)) throw err;
    result.write(undefined, oneLine(line), "majhi cannot read the command line", held);
  }
  return result.verdict();
}

/**
 * How a command an agent wants to run over SSH counts: each command of the line is a read when its
 * program only reads (cat, ls, grep, tail) or its first verb is a read verb (`systemctl status`).
 * Anything else, a redirect into a file included, is a write.
 */
export function classifyRemote(command: string, connection: GateConnection): GateVerdict {
  const action = oneLine(command);
  const write = (why: string): GateVerdict => ({
    kind: "write",
    writes: [{ connection: connection.id, action, why, allowed: connection.allow.includes(action) }],
  });
  let parsed: ReturnType<typeof parseLine>;
  try {
    parsed = parseLine(command);
  } catch {
    return write("majhi cannot read the command line");
  }
  if (parsed.substitutions.length > 0) return write("it runs a command inside the command");
  if (parsed.commands.length === 0) return write("it is empty");
  for (const cmd of parsed.commands) {
    if (cmd.redirects.some(isFileWrite)) return write("it writes to a file");
    const [program, ...args] = cmd.words;
    if (program === undefined) continue;
    const name = basename(program);
    if (REMOTE_READ_PROGRAMS.has(name)) continue;
    if (name === "journalctl") {
      if (args.some((a) => JOURNAL_WRITES.test(a))) return write("it deletes or rotates the journal");
      continue;
    }
    if (cliVerb(args) !== "read") return write(`${name} may change something`);
  }
  return { kind: "read", connections: [connection.id] };
}

class LineResult {
  private readonly reads = new Set<string>();
  private readonly writes: GateWrite[] = [];
  /** A command that is neither a connection read nor a filter, or a read into a file. */
  private others = false;

  read(connection: string): void {
    this.reads.add(connection);
  }

  write(connection: string | undefined, action: string, why: string, held: readonly GateConnection[]): void {
    const allow = connection === undefined ? [] : (held.find((c) => c.id === connection)?.allow ?? []);
    this.writes.push({ connection, action, why, allowed: allow.includes(action) });
  }

  other(): void {
    this.others = true;
  }

  verdict(): GateVerdict {
    if (this.writes.length > 0) return { kind: "write", writes: this.writes };
    if (this.reads.size > 0 && !this.others) return { kind: "read", connections: [...this.reads] };
    return { kind: "other" };
  }
}

const MAX_DEPTH = 8;

function readLine(line: string, held: readonly GateConnection[], result: LineResult, depth: number): void {
  if (depth > MAX_DEPTH) throw new ShellParseError("Too many nested commands.");
  const parsed = parseLine(line);
  for (const inner of parsed.substitutions) readLine(inner, held, result, depth + 1);
  for (const cmd of parsed.commands) readCommand(cmd, held, result, depth);
}

function readCommand(
  cmd: SimpleCommand,
  held: readonly GateConnection[],
  result: LineResult,
  depth: number,
): void {
  const { words, assigned } = unwrap(cmd.words);
  const [program, ...args] = words;
  if (program === undefined) return;
  const name = basename(program);
  const intoFile = cmd.redirects.some(isFileWrite);
  const text = oneLine(words.join(" "));

  // A program the gate cannot see, like `$KUBECTL` or `$(which kubectl)`.
  if (/[$`]/.test(program)) {
    result.write(undefined, text, "majhi cannot tell which program it runs", held);
    return;
  }
  if (SHELLS.has(name) || name === "eval") {
    const script = name === "eval" ? args.join(" ") : shellScript(args);
    if (script !== undefined) {
      readLine(script, held, result, depth + 1);
      return;
    }
  }
  if (name === "watch") {
    readLine(watchCommand(args), held, result, depth + 1);
    return;
  }
  if (name === "find") {
    for (const nested of findExecs(args))
      readCommand({ words: nested, redirects: [] }, held, result, depth + 1);
  }

  const kubectl = held.filter((c) => c.type === "kubectl");
  if (name === "kubectl" && kubectl.length > 0) {
    if (assigned.includes("KUBECONFIG")) {
      result.write(kubectl[0]?.id, text, "KUBECONFIG reaches the cluster as someone else", held);
      return;
    }
    readKubectl(args, text, intoFile, kubectl, held, result);
    return;
  }
  const env = held.find(
    (c) => (c.type === "env" || c.type === "cli" || c.type === "git") && c.clis?.includes(name),
  );
  if (env !== undefined) {
    const verb = cliVerb(args);
    if (verb === "read" && !intoFile) result.read(env.id);
    else if (verb === "read") result.other();
    else
      result.write(
        env.id,
        text,
        verb === "write"
          ? `${name} ${firstVerb(args) ?? ""} changes something`.trim()
          : `majhi cannot tell what this ${name} command does`,
        held,
      );
    return;
  }
  const mail = held.find((c) => c.type === "mail");
  if (
    mail !== undefined &&
    (MAIL_SENDERS.has(name) || /MAIL_SMTP|smtps?:\/\/|smtplib|nodemailer/i.test(text))
  ) {
    result.write(mail.id, text, "it sends mail", held);
    return;
  }
  if (FILTERS.has(name) && !intoFile) return;
  result.other();
}

function readKubectl(
  args: readonly string[],
  text: string,
  intoFile: boolean,
  kubectl: readonly GateConnection[],
  held: readonly GateConnection[],
  result: LineResult,
): void {
  // The first kubectl connection is the current context; --context picks another one the run holds.
  let connection = kubectl[0];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [flag, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    if (KUBECTL_IDENTITY_FLAGS.has(flag)) {
      result.write(connection?.id, text, `${flag} reaches the cluster as someone else`, held);
      return;
    }
    if (flag === "--context") {
      const name = inline ?? args[i + 1];
      if (inline === undefined) i++;
      const named = kubectl.find((c) => c.context === name);
      if (named === undefined) {
        result.write(connection?.id, text, `the run holds no context ${name ?? ""}`.trim(), held);
        return;
      }
      connection = named;
      continue;
    }
    if (arg.startsWith("-")) {
      if (inline === undefined && KUBECTL_VALUE_FLAGS.has(flag)) i++;
      continue;
    }
    positional.push(arg);
  }
  const id = connection?.id;
  const [sub, second] = positional;
  const read =
    sub === undefined ||
    KUBECTL_READS.has(sub) ||
    (second !== undefined && (KUBECTL_READ_PAIRS[sub]?.includes(second) ?? false));
  if (!read) {
    result.write(id, text, `kubectl ${[sub, second].filter(Boolean).join(" ")} changes the cluster`, held);
    return;
  }
  if (intoFile || id === undefined) result.other();
  else result.read(id);
}

/** The first word of the arguments that is a known verb, or a word starting with one (`describe-instances`). */
function firstVerb(args: readonly string[]): string | undefined {
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
function cliVerb(args: readonly string[]): "read" | "write" | "unknown" {
  if (args.every((a) => a.startsWith("-"))) return "read";
  const verb = firstVerb(args);
  if (verb === undefined) return "unknown";
  return CLI_READ_VERBS.has(verb) ? "read" : "write";
}

/**
 * Leaves out what only starts another command: variable assignments in front, and wrappers like
 * `timeout 30 kubectl ...` or `env KUBECONFIG=x kubectl ...`. `assigned` names the variables set on the way.
 */
function unwrap(input: readonly string[]): { words: string[]; assigned: string[] } {
  let rest = [...input];
  const assigned: string[] = [];
  const takeAssignments = () => {
    while (rest[0] !== undefined && isAssignment(rest[0])) {
      assigned.push(rest[0].slice(0, rest[0].indexOf("=")));
      rest = rest.slice(1);
    }
  };
  takeAssignments();
  for (let guard = 0; guard < 8; guard++) {
    const name = basename(rest[0] ?? "");
    if (!WRAPPERS.has(name)) break;
    rest = rest.slice(1);
    // Their own options, and for env its assignments. timeout and nice take a number first.
    while (rest[0] !== undefined && (rest[0].startsWith("-") || (name === "env" && isAssignment(rest[0])))) {
      const option = rest[0];
      if (isAssignment(option)) assigned.push(option.slice(0, option.indexOf("=")));
      rest = rest.slice(1);
      if (
        /^-[nuICLsPk]$|^--(?:signal|kill-after|max-args|max-procs|delimiter|arg-file|user|group)$/.test(
          option,
        )
      ) {
        rest = rest.slice(1);
      }
    }
    if ((name === "timeout" || name === "nice") && /^\d/.test(rest[0] ?? "")) rest = rest.slice(1);
    takeAssignments();
  }
  return { words: rest, assigned };
}

/** The script of `sh -c '<script>'`, or undefined when the shell runs a file instead. */
function shellScript(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (/^-[a-z]*c[a-z]*$/.test(arg)) return args[i + 1] ?? "";
    if (!arg.startsWith("-")) return undefined;
  }
  return undefined;
}

/** `watch [options] <command>`: the command, read as a shell line. */
function watchCommand(args: readonly string[]): string {
  const rest = [...args];
  while (rest[0]?.startsWith("-")) {
    const option = rest.shift() ?? "";
    if (/^-[nd]$|^--(?:interval|differences)$/.test(option)) rest.shift();
  }
  return rest.join(" ");
}

/** The commands of `find ... -exec <command> ;`. */
function findExecs(args: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i] ?? "")) continue;
    const nested: string[] = [];
    for (i++; i < args.length && args[i] !== ";" && args[i] !== "+"; i++) nested.push(args[i] ?? "");
    out.push(nested);
  }
  return out;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** A redirect that writes a file. /dev/null and descriptors do not count. */
function isFileWrite(redirect: { op: string; target: string }): boolean {
  if (!/>/.test(redirect.op)) return false;
  return redirect.target !== "/dev/null" && !redirect.target.startsWith("&");
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
