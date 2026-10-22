import { programReads } from "./read-only.ts";
import { parseLine, ShellParseError, type SimpleCommand } from "./shell.ts";

/**
 * What a command line run on a connected host does, read from its parsed words and never from its text
 * (docs/briefs/case-flow.md). Three answers:
 *   - `read`: it only looks (logs, `docker ps`, `docker inspect`, files, a SELECT, a status endpoint);
 *   - `recovery`: it restarts or recreates one service or container on the same image and config, which
 *     undoes itself by running again;
 *   - `write`: anything else, and everything that cannot be read as one of the two.
 * Each program has its own table of read verbs. A program, verb or flag that is in no table is a write, so a
 * new tool never passes by accident. A line is a read only if every command of it is one; it is a recovery
 * when exactly one command is and the others read.
 */

export type RemoteVerdict =
  | { kind: "read" }
  | {
      kind: "recovery";
      /** The thing restarted: a container, a compose service, a unit, a deployment. */
      target: string;
      /** The action as the case keeps it, `docker restart acme-worker`: the same action is done once per case. */
      action: string;
    }
  | { kind: "write"; why: string };

const READ: RemoteVerdict = { kind: "read" };
const write = (why: string): RemoteVerdict => ({ kind: "write", why });

const set = (...words: string[]): ReadonlySet<string> => new Set(words);
const MAX_DEPTH = 3;

/** Programs that only read the files and text they are given. Their words are files or patterns, never commands. */
const FILTERS = set(
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "column",
  "nl",
  "rev",
  "tac",
  "cat",
  "zcat",
  "ls",
  "stat",
  "file",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "md5sum",
  "sha256sum",
  "du",
);

/** Programs that report on the machine and take no action. */
const REPORTERS = set(
  "df",
  "free",
  "uptime",
  "uname",
  "hostname",
  "whoami",
  "id",
  "date",
  "pwd",
  "which",
  "whereis",
  "lsblk",
  "lscpu",
  "nproc",
  "vmstat",
  "iostat",
  "mpstat",
  "ps",
  "ss",
  "netstat",
  "lsof",
  "w",
  "who",
  "last",
  "getent",
  "ifconfig",
  "dig",
  "nslookup",
  "host",
  "echo",
  "printf",
  "true",
  "false",
  "sleep",
  "cd",
  "test",
  "[",
);

/** Wrappers that only run what follows them. `sudo` is the host's own rule, majhi's key is the user's. */
const WRAPPERS = set("sudo", "timeout", "nice", "time", "ionice", "stdbuf");
const SHELLS = set("sh", "bash", "zsh", "dash");

/** Folders and files that hold keys and logins, whatever the host. A read of one is not a plain read. */
const CREDENTIAL_SEGMENTS = set(
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  ".git-credentials",
  ".docker",
  ".majhi",
);
const KEY_FILE_PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const SECRET_PATHS = set("/etc/shadow", "/etc/gshadow", "/etc/sudoers");

/** Variables that change how the next program starts: setting one in front of a command is not a read. */
function dangerousVariable(name: string): boolean {
  return (
    name.startsWith("LD_") ||
    name.startsWith("BASH_") ||
    name.startsWith("PYTHON") ||
    name.startsWith("NODE_") ||
    name === "PATH" ||
    name === "IFS" ||
    name === "ENV" ||
    name === "SHELL"
  );
}

function startsWithDigit(word: string | undefined): boolean {
  const ch = word?.[0];
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function hasVariable(word: string): boolean {
  return word.includes("$") || word.includes("`");
}

function isAssignment(word: string): boolean {
  const eq = word.indexOf("=");
  if (eq <= 0) return false;
  for (const ch of word.slice(0, eq)) {
    const lower = ch.toLowerCase();
    if (!(ch === "_" || (ch >= "0" && ch <= "9") || (lower >= "a" && lower <= "z"))) return false;
  }
  return true;
}

/** Whether a path word names a place that holds a login, a key or a secret file. */
function secretPath(word: string): boolean {
  const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  if (SECRET_PATHS.has(value)) return true;
  const parts = value.split("/");
  const last = parts.at(-1) ?? "";
  if (last === ".env" || last.startsWith(".env.") || last.endsWith(".env")) return true;
  if (parts.length >= 3 && parts[1] === "proc" && last === "environ") return true;
  return parts.some((p) => CREDENTIAL_SEGMENTS.has(p) || KEY_FILE_PREFIXES.some((k) => p.startsWith(k)));
}

/** The words of a command that are not flags, for the verb and its target. */
function plain(words: readonly string[]): string[] {
  return words.filter((w) => !w.startsWith("-"));
}

/** A name that can be a container, service or unit: letters, digits and `-_.@:`. Anything else is not a target. */
function targetName(word: string | undefined): word is string {
  if (word === undefined || word === "" || word.startsWith("-")) return false;
  for (const ch of word) {
    const lower = ch.toLowerCase();
    const ok =
      (lower >= "a" && lower <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "@" ||
      ch === ":";
    if (!ok) return false;
  }
  return true;
}

/** Splits flags that take a value from the rest: returns the words left, or undefined on a flag outside `known`. */
function strip(
  args: readonly string[],
  flags: { valued: ReadonlySet<string>; plain: ReadonlySet<string> },
): string[] | undefined {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-") || arg === "-") {
      rest.push(arg);
      continue;
    }
    const name = arg.includes("=") && arg.startsWith("--") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flags.plain.has(name)) continue;
    if (flags.valued.has(name)) {
      if (!arg.includes("=") && args[i + 1] === undefined) return undefined;
      if (!arg.includes("=")) i++;
      continue;
    }
    return undefined;
  }
  return rest;
}

// -----------------------------------------------------------------------------
// docker

const DOCKER_GLOBAL = {
  valued: set("-H", "--host", "--context", "-c", "-l", "--log-level", "--config"),
  plain: set("-D", "--debug", "--tls", "--tlsverify"),
};
const DOCKER_READS = set(
  "ps",
  "logs",
  "stats",
  "top",
  "images",
  "version",
  "info",
  "events",
  "history",
  "port",
  "diff",
);
const DOCKER_READ_GROUPS: Readonly<Record<string, ReadonlySet<string>>> = {
  container: set("ls", "ps", "logs", "top", "stats", "port", "diff"),
  image: set("ls", "history"),
  volume: set("ls", "inspect"),
  network: set("ls", "inspect"),
  system: set("df", "info", "events"),
  node: set("ls", "ps"),
  service: set("ls", "ps", "logs"),
  stack: set("ls", "ps", "services"),
  context: set("ls", "show"),
};
/**
 * `docker inspect` prints a container's env, which holds the client's secrets. It is a read only with a
 * `--format` that names fields from this list and nothing else (`$` is refused before this is asked).
 */
const INSPECT_FIELDS = [
  ".State",
  ".Name",
  ".Id",
  ".Image",
  ".RestartCount",
  ".Created",
  ".Config.Image",
  ".HostConfig.RestartPolicy",
];
const INSPECT_WORDS = set("json", "-");
/** `docker restart` and `docker start`: they keep the container's image and config. */
const DOCKER_RECOVERY = set("restart", "start");
const COMPOSE_GLOBAL = {
  valued: set(
    "-f",
    "--file",
    "-p",
    "--project-name",
    "--project-directory",
    "--env-file",
    "--profile",
    "--ansi",
    "--parallel",
    "-H",
    "--context",
  ),
  plain: set("--compatibility", "--verbose", "--dry-run", "--all-resources"),
};
/** Not `config`: it prints the resolved env, secrets included. */
const COMPOSE_READS = set("ps", "logs", "ls", "images", "top", "version", "events", "port");
/**
 * Global flags a compose recovery may carry. Never `-H` or `--context` (another engine). `up` recreates from
 * the file, so it also never takes `-f`, `--env-file` or `--project-directory`: only the project's own config.
 */
const COMPOSE_RESTART_GLOBALS = set(
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--env-file",
  "--ansi",
);
const COMPOSE_UP_GLOBALS = set("-p", "--project-name", "--ansi");
const COMPOSE_RECOVERY = set("restart", "start", "unpause");
/** What `compose up` may carry and still keep the image and config: it never builds, pulls or removes. */
const COMPOSE_UP_FLAGS = {
  valued: set("-t", "--timeout", "--wait-timeout"),
  plain: set("-d", "--detach", "--no-deps", "--force-recreate", "--no-build", "--wait", "--no-color"),
};
const EXEC_FLAGS = {
  valued: set("-u", "--user", "-w", "--workdir"),
  plain: set("-i", "-t", "-it", "-ti", "--interactive", "--tty"),
};

/** `docker exec <container> <command>` and the same under compose: a read only when the command inside is one. */
function execRead(args: readonly string[], depth: number, target: "container" | "service"): RemoteVerdict {
  const at = firstPlain(args, EXEC_FLAGS);
  if (at >= args.length) return write(`docker exec has an option majhi does not read`);
  const named = args[at];
  if (!targetName(named)) return write(`docker exec needs a plain ${target} name`);
  const inside = args.slice(at + 1);
  if (inside.length === 0) return write("docker exec with no command opens a shell");
  const inner = classifyOne({ words: inside, redirects: [] }, depth + 1);
  return inner.kind === "read" ? READ : write("the command inside docker exec is not a read");
}

function dockerCommand(
  args: readonly string[],
  depth: number,
  binary: "docker" | "docker-compose",
): RemoteVerdict {
  if (binary === "docker-compose") return composeCommand(args, depth);
  const at = firstPlain(args, DOCKER_GLOBAL);
  const sub = args[at];
  const after = args.slice(at + 1);
  if (sub === undefined) return write("docker with no command");
  if (sub === "compose") return composeCommand(after, depth);
  if (sub === "exec") return execRead(after, depth, "container");
  if (sub === "inspect" || (sub === "container" && plain(after)[0] === "inspect"))
    return hasVariableIn(after) ? write("it uses a variable") : inspectRead(after);
  if (DOCKER_READS.has(sub)) return hasVariableIn(after) ? write("it uses a variable") : READ;
  const group = DOCKER_READ_GROUPS[sub];
  if (group !== undefined) {
    const verb = plain(after)[0];
    if (verb !== undefined && group.has(verb))
      return hasVariableIn(after) ? write("it uses a variable") : READ;
    return write(`docker ${sub} ${verb ?? ""} may change something`.trim());
  }
  if (DOCKER_RECOVERY.has(sub)) {
    if (at !== 0) return write(`docker ${sub} with a global option may reach another engine`);
    const flags = strip(after, { valued: set("-t", "--time"), plain: new Set() });
    const names = flags?.filter((w) => !w.startsWith("-"));
    const name = names?.[0];
    if (names?.length !== 1 || !targetName(name))
      return write(`docker ${sub} needs one plain container name`);
    return { kind: "recovery", target: name, action: `docker ${sub} ${name}` };
  }
  return write(`docker ${sub} may change something`);
}

/** `docker inspect` with a `--format` that names only status fields. Anything else may print the env. */
function inspectRead(args: readonly string[]): RemoteVerdict {
  const templates: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "-f" || arg === "--format") templates.push(args[++i] ?? "");
    else if (arg.startsWith("--format=")) templates.push(arg.slice("--format=".length));
  }
  if (templates.length === 0) return write("docker inspect without --format prints the env");
  return templates.every(safeTemplate)
    ? READ
    : write("docker inspect --format names a field that may hold a secret");
}

/** Whether every action of a Go template names only a status field or `json`. */
function safeTemplate(template: string): boolean {
  let rest = template;
  let actions = 0;
  for (;;) {
    const open = rest.indexOf("{{");
    if (open < 0) return actions > 0 && !rest.includes("}}");
    const close = rest.indexOf("}}", open);
    if (close < 0) return false;
    const words = rest
      .slice(open + 2, close)
      .split(" ")
      .filter((w) => w !== "");
    const fine = words.every(
      (w) => INSPECT_WORDS.has(w) || INSPECT_FIELDS.some((f) => w === f || w.startsWith(`${f}.`)),
    );
    if (!fine || words.length === 0) return false;
    actions++;
    rest = rest.slice(close + 2);
  }
}

/** The index of the first word that is not a global flag or a flag's value. */
function firstPlain(
  args: readonly string[],
  flags: { valued: ReadonlySet<string>; plain: ReadonlySet<string> },
): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) return i;
    const name = arg.includes("=") && arg.startsWith("--") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flags.valued.has(name) && !arg.includes("=")) i++;
    else if (!flags.valued.has(name) && !flags.plain.has(name)) return args.length;
  }
  return args.length;
}

function hasVariableIn(words: readonly string[]): boolean {
  return words.some(hasVariable);
}

function composeCommand(args: readonly string[], depth: number): RemoteVerdict {
  const at = firstPlain(args, COMPOSE_GLOBAL);
  const sub = args[at];
  if (sub === undefined) return write("docker compose with an option or command majhi does not read");
  if (strip(args.slice(0, at), COMPOSE_GLOBAL) === undefined)
    return write("docker compose has an option majhi does not read");
  const after = args.slice(at + 1);
  if (hasVariableIn(args)) return write("it uses a variable");
  if (sub === "exec") return execRead(after, depth, "service");
  if (COMPOSE_READS.has(sub)) return READ;
  // The global flags before the command (their values are the words without a dash).
  const globalNames = args
    .slice(0, at)
    .filter((w) => w.startsWith("-"))
    .map((w) => (w.includes("=") ? w.slice(0, w.indexOf("=")) : w));
  if (COMPOSE_RECOVERY.has(sub)) {
    if (!globalNames.every((g) => COMPOSE_RESTART_GLOBALS.has(g)))
      return write(`docker compose ${sub} with that option may reach another engine`);
    const names = plain(after);
    const flags = after.filter((w) => w.startsWith("-"));
    const name = names[0];
    if (names.length !== 1 || !targetName(name) || flags.some((f) => f !== "-t" && f !== "--timeout"))
      return write(`docker compose ${sub} needs one plain service name`);
    return { kind: "recovery", target: name, action: `docker compose ${sub} ${name}` };
  }
  if (sub === "up") {
    if (!globalNames.every((g) => COMPOSE_UP_GLOBALS.has(g)))
      return write("docker compose up recreates only from the project's own file and env");
    const names = strip(after, COMPOSE_UP_FLAGS);
    const services = names?.filter((w) => !w.startsWith("-"));
    // Only a named service and only `-d`: `up` with no service applies every change in the file.
    const detached = after.includes("-d") || after.includes("--detach");
    const name = services?.[0];
    if (names === undefined || services?.length !== 1 || !targetName(name) || !detached)
      return write("docker compose up must name one service, run detached and not build or pull");
    return { kind: "recovery", target: name, action: `docker compose up ${name}` };
  }
  return write(`docker compose ${sub} may change something`);
}

// -----------------------------------------------------------------------------
// systemd and friends

const SYSTEMCTL_FLAGS = {
  valued: set("-n", "--lines", "-t", "--type", "--state", "-o", "--output", "-p", "--property"),
  plain: set(
    "--no-pager",
    "-l",
    "--full",
    "--user",
    "--system",
    "-q",
    "--quiet",
    "--no-legend",
    "-a",
    "--all",
    "--failed",
  ),
};
const SYSTEMCTL_READS = set(
  "status",
  "is-active",
  "is-enabled",
  "is-failed",
  "show",
  "list-units",
  "list-unit-files",
  "list-timers",
  "list-sockets",
  "list-dependencies",
  "cat",
);
const SYSTEMCTL_RECOVERY = set("restart", "try-restart", "reload", "reload-or-restart", "start");

function systemctlCommand(args: readonly string[]): RemoteVerdict {
  const rest = strip(args, SYSTEMCTL_FLAGS);
  if (rest === undefined) return write("systemctl has an option majhi does not read");
  const [verb, ...names] = rest;
  if (verb === undefined) return write("systemctl with no command");
  if (hasVariableIn(rest)) return write("it uses a variable");
  if (SYSTEMCTL_READS.has(verb)) return READ;
  if (SYSTEMCTL_RECOVERY.has(verb)) {
    const [name] = names;
    if (names.length !== 1 || !targetName(name)) return write(`systemctl ${verb} needs one plain unit name`);
    return { kind: "recovery", target: name, action: `systemctl ${verb} ${name}` };
  }
  return write(`systemctl ${verb} may change something`);
}

function serviceCommand(args: readonly string[]): RemoteVerdict {
  const [name, verb, ...extra] = args;
  if (!targetName(name) || verb === undefined || extra.length > 0)
    return write("service needs a name and a verb");
  if (verb === "status") return READ;
  if (verb === "restart" || verb === "reload" || verb === "start")
    return { kind: "recovery", target: name, action: `service ${name} ${verb}` };
  return write(`service ${verb} may change something`);
}

function supervisorctlCommand(args: readonly string[]): RemoteVerdict {
  const rest = strip(args, { valued: set("-c", "-s", "-u", "-p"), plain: new Set() });
  const [verb, ...names] = rest ?? [];
  if (rest === undefined || verb === undefined) return write("supervisorctl with no command");
  if (hasVariableIn(rest)) return write("it uses a variable");
  if (verb === "status" || verb === "avail" || verb === "tail" || verb === "pid") return READ;
  if (verb === "restart" || verb === "start") {
    const [name] = names;
    if (names.length !== 1 || !targetName(name) || name === "all")
      return write(`supervisorctl ${verb} needs one plain program name`);
    return { kind: "recovery", target: name, action: `supervisorctl ${verb} ${name}` };
  }
  return write(`supervisorctl ${verb} may change something`);
}

/** journalctl reads; these flags delete, rotate or write the journal. */
const JOURNAL_WRITES = [
  "--vacuum",
  "--rotate",
  "--flush",
  "--relinquish",
  "--sync",
  "--setup-keys",
  "--update-catalog",
  "--smart-relinquish",
];

function journalctlCommand(args: readonly string[]): RemoteVerdict {
  if (args.some((a) => JOURNAL_WRITES.some((w) => a.startsWith(w))))
    return write("it deletes or rotates the journal");
  return READ;
}

// -----------------------------------------------------------------------------
// data stores and queues

/** Words of a statement, as identifiers: letters, digits and `_`. Quoted text is read as words too, which only errs toward a write. */
function sqlWords(sql: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const ch of sql) {
    const lower = ch.toLowerCase();
    if ((lower >= "a" && lower <= "z") || (ch >= "0" && ch <= "9") || ch === "_") word += lower;
    else if (word !== "") {
      words.push(word);
      word = "";
    }
  }
  if (word !== "") words.push(word);
  return words;
}

/** The statements of an SQL text, split at `;` outside quotes. */
function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of sql) {
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
    } else if (ch === ";") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

const SQL_FIRST_READS = set("select", "show", "explain", "describe", "desc", "table", "values");
/** Words that change data, the schema or the server, wherever they stand in a statement. */
const SQL_CHANGERS = set(
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "truncate",
  "create",
  "grant",
  "revoke",
  "into",
  "call",
  "execute",
  "exec",
  "lock",
  "copy",
  "vacuum",
  "reindex",
  "cluster",
  "merge",
  "replace",
  "rename",
  "comment",
  "analyze",
  "analyse",
  "set",
  "reset",
  "nextval",
  "setval",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "set_config",
  "lo_import",
  "lo_export",
  "dblink",
);

/** Whether an SQL text only reads. A statement is a read by its first word and by the words it never holds. */
export function sqlReads(sql: string): boolean {
  const statements = sqlStatements(sql);
  if (statements.length === 0) return false;
  return statements.every((statement) => {
    if (statement.startsWith("\\")) {
      // psql's own commands: the describe and list family reads; \! \copy \i \o run or write.
      const name = statement.slice(1).split(" ")[0] ?? "";
      return (
        name === "conninfo" || name === "x" || name === "l" || name.startsWith("d") || name.startsWith("l+")
      );
    }
    const words = sqlWords(statement);
    const first = words[0];
    if (first === undefined || !SQL_FIRST_READS.has(first)) return false;
    return !words.some((w) => SQL_CHANGERS.has(w));
  });
}

const PSQL_FLAGS = {
  valued: set("-h", "-p", "-U", "-d", "-F", "-R", "-P", "-v", "--host", "--port", "--username", "--dbname"),
  plain: set("-t", "-A", "-X", "-q", "-x", "-1", "-w", "--no-password", "--csv", "-H", "-z", "-0", "-S"),
};
const MYSQL_FLAGS = {
  valued: set("-h", "-P", "-u", "-D", "--host", "--port", "--user", "--database"),
  plain: set(
    "-N",
    "-s",
    "-B",
    "-E",
    "-t",
    "--batch",
    "--skip-column-names",
    "--vertical",
    "--table",
    "--no-auto-rehash",
    "-q",
  ),
};

/** `psql` and `mysql`: the SQL comes with `-c` (psql) or `-e` (mysql) and is read as above. Files and other sources are writes. */
function sqlClient(program: "psql" | "mysql", args: readonly string[]): RemoteVerdict {
  const flags = program === "psql" ? PSQL_FLAGS : MYSQL_FLAGS;
  const carrier = program === "psql" ? ["-c", "--command"] : ["-e", "--execute"];
  const sqls: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const name = arg.includes("=") && arg.startsWith("--") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (carrier.includes(name)) {
      const value = arg.includes("=") && arg.startsWith("--") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (value === undefined) return write(`${program} has an option with no value`);
      sqls.push(value);
      continue;
    }
    const stripped = strip(
      [arg, ...(flags.valued.has(name) && !arg.includes("=") ? [args[i + 1] ?? ""] : [])],
      flags,
    );
    if (stripped === undefined) return write(`${program} ${arg} may change something`);
    if (flags.valued.has(name) && !arg.includes("=")) i++;
    rest.push(...stripped);
  }
  if (sqls.length === 0)
    return write(`${program} without a statement reads its input from somewhere majhi cannot see`);
  return sqls.every(sqlReads) ? READ : write("the statement is not a plain read");
}

const REDIS_READS = set(
  "get",
  "mget",
  "strlen",
  "exists",
  "type",
  "ttl",
  "pttl",
  "llen",
  "lrange",
  "lindex",
  "scard",
  "smembers",
  "sismember",
  "hget",
  "hgetall",
  "hlen",
  "hkeys",
  "hmget",
  "zcard",
  "zrange",
  "zscore",
  "zcount",
  "xlen",
  "xrange",
  "xinfo",
  "keys",
  "scan",
  "dbsize",
  "info",
  "ping",
  "time",
);
const REDIS_PAIRS: Readonly<Record<string, ReadonlySet<string>>> = {
  memory: set("usage", "stats"),
  client: set("list", "info"),
  config: set("get"),
  slowlog: set("get", "len"),
  pubsub: set("channels", "numsub"),
  object: set("encoding", "idletime", "freq"),
};

function redisCommand(args: readonly string[]): RemoteVerdict {
  const rest = strip(args, {
    valued: set("-h", "-p", "-a", "-n", "-u", "--user", "--pass"),
    plain: set("--no-auth-warning", "--raw", "--no-raw", "-3"),
  });
  const [verb, second] = (rest ?? []).map((w) => w.toLowerCase());
  if (rest === undefined || verb === undefined) return write("redis-cli with no command it can read");
  if (REDIS_READS.has(verb)) return READ;
  const pair = REDIS_PAIRS[verb];
  if (pair !== undefined && second !== undefined && pair.has(second)) return READ;
  return write(`redis-cli ${verb} may change something`);
}

const CELERY_GLOBAL = {
  valued: set("-A", "--app", "-b", "--broker", "--result-backend", "--workdir", "--config"),
  plain: new Set<string>(),
};
const CELERY_INSPECT_READS = set(
  "active",
  "reserved",
  "scheduled",
  "stats",
  "registered",
  "ping",
  "active_queues",
  "revoked",
  "report",
  "conf",
  "query_task",
);

function celeryCommand(args: readonly string[]): RemoteVerdict {
  const at = firstPlain(args, CELERY_GLOBAL);
  const verb = args[at];
  const after = args.slice(at + 1);
  if (verb === "status" || verb === "report") return READ;
  if (verb === "inspect") {
    const sub = plain(
      strip(after, { valued: set("-t", "--timeout", "-d", "--destination"), plain: set("--json") }) ?? [],
    )[0];
    return sub !== undefined && CELERY_INSPECT_READS.has(sub)
      ? READ
      : write("celery inspect with a command majhi does not read");
  }
  return write(`celery ${verb ?? ""} may change something`.trim());
}

// -----------------------------------------------------------------------------
// http on the host itself

const LOOPBACK_HOSTS = set("localhost", "127.0.0.1", "[::1]", "::1");
const CURL_PLAIN = set(
  "-s",
  "-S",
  "-L",
  "-I",
  "-i",
  "-f",
  "-k",
  "-v",
  "--silent",
  "--show-error",
  "--location",
  "--head",
  "--include",
  "--fail",
  "--insecure",
  "--compressed",
  "--verbose",
  "-sS",
  "-sf",
  "-sL",
  "-sI",
  "-fsS",
  "-sSf",
  "-sSL",
);
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

/** The host of an address with or without a scheme: `localhost:8000/health`, `http://127.0.0.1/x`. */
function hostOfAddress(word: string): string | undefined {
  let rest = word;
  const scheme = rest.indexOf("://");
  if (scheme >= 0) {
    if (rest.slice(0, scheme) !== "http" && rest.slice(0, scheme) !== "https") return undefined;
    rest = rest.slice(scheme + 3);
  }
  const ends = ["/", "?", "#"].map((c) => rest.indexOf(c)).filter((i) => i >= 0);
  const authority = ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
  if (authority.includes("@")) return undefined;
  if (authority.startsWith("[")) return authority.slice(0, authority.indexOf("]") + 1);
  return authority.split(":")[0];
}

/** `curl` and `wget` to the host's own address, GET or HEAD, nothing sent and nothing saved. */
function httpCommand(program: "curl" | "wget", args: readonly string[]): RemoteVerdict {
  let addresses = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "-o" || arg === "--output" || arg === "-O" || arg === "--output-document") {
      const target = args[++i];
      if (target !== "/dev/null" && !(program === "wget" && target === "-"))
        return write(`${program} saves a file`);
    } else if (arg === "-X" || arg === "--request") {
      const verb = args[++i];
      if (verb !== "GET" && verb !== "HEAD") return write(`${program} sends something`);
    } else if (program === "curl" && CURL_VALUED.has(arg)) {
      if (args[++i] === undefined) return write("curl has an option with no value");
    } else if (program === "curl" && CURL_PLAIN.has(arg)) {
      // A plain flag.
    } else if (
      program === "wget" &&
      (arg === "-q" ||
        arg === "--spider" ||
        arg === "-S" ||
        arg.startsWith("--timeout=") ||
        arg.startsWith("--tries="))
    ) {
      // A plain flag.
    } else if (arg.startsWith("-")) {
      return write(`${program} ${arg} may send or save something`);
    } else {
      addresses++;
      const host = hostOfAddress(arg);
      if (host === undefined || !LOOPBACK_HOSTS.has(host))
        return write(`${program} reaches an address that is not the host itself`);
    }
  }
  return addresses > 0 ? READ : write(`${program} with no address`);
}

// -----------------------------------------------------------------------------
// the rest

function findReads(args: readonly string[]): boolean {
  const changers = set(
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprintf",
    "-fls",
    "-fprint0",
  );
  return !args.some((a) => changers.has(a));
}

/** Files and patterns given to a filter or reader: a word that names a login or key file is not a plain read. */
function filtersRead(args: readonly string[]): boolean {
  return !args.some(secretPath);
}

function classifyOne(cmd: SimpleCommand, depth: number): RemoteVerdict {
  if (
    cmd.redirects.some(
      (r) => (r.op.includes(">") || r.op === "<>") && r.target !== "/dev/null" && !r.target.startsWith("&"),
    )
  )
    return write("it writes to a file");
  if (cmd.redirects.some((r) => r.op.startsWith("<") && r.target !== "" && secretPath(r.target)))
    return write("it reads a login or key file");
  let words = [...cmd.words];
  while (words[0] !== undefined && isAssignment(words[0])) {
    const name = (words[0] ?? "").slice(0, (words[0] ?? "").indexOf("="));
    if (dangerousVariable(name)) return write(`it sets ${name}`);
    words = words.slice(1);
  }
  for (let guard = 0; guard < 4; guard++) {
    const head = basename(words[0] ?? "");
    if (!WRAPPERS.has(head)) break;
    words = words.slice(1);
    // The wrapper's own options, then timeout's and nice's number.
    while (words[0]?.startsWith("-") === true) {
      const option = words[0];
      words = words.slice(1);
      if (
        option === "-u" ||
        option === "-n" ||
        option === "-p" ||
        option === "-g" ||
        option === "-s" ||
        option === "-k"
      )
        words = words.slice(1);
    }
    if ((head === "timeout" || head === "nice") && startsWithDigit(words[0])) words = words.slice(1);
  }
  const [first, ...args] = words;
  if (first === undefined) return READ;
  if (hasVariable(first)) return write("majhi cannot tell which program it runs");
  const program = basename(first);
  if (first.includes("/") && !first.startsWith("/")) return write("it runs a program by a relative path");

  if (SHELLS.has(program)) {
    const c = args.indexOf("-c") >= 0 ? args.indexOf("-c") : args.indexOf("-lc");
    const script = c >= 0 ? args[c + 1] : undefined;
    if (script === undefined || depth >= MAX_DEPTH || args.slice(0, c).some((a) => !a.startsWith("-")))
      return write("it runs a shell script majhi cannot read");
    return classifyLine(script, depth + 1);
  }
  if (program === "docker" || program === "docker-compose") return dockerCommand(args, depth, program);
  if (program === "systemctl") return systemctlCommand(args);
  if (program === "service") return serviceCommand(args);
  if (program === "supervisorctl") return supervisorctlCommand(args);
  if (program === "journalctl") return journalctlCommand(args);
  if (program === "psql" || program === "mysql" || program === "mariadb")
    return sqlClient(program === "psql" ? "psql" : "mysql", args);
  if (program === "redis-cli") return redisCommand(args);
  if (program === "celery") return celeryCommand(args);
  if (program === "curl" || program === "wget") return httpCommand(program, args);
  if (program === "kubectl") {
    if (args[0] === "rollout" && args[1] === "restart") {
      const target = args[2];
      if (args.length === 3 && target !== undefined && !hasVariable(target) && !target.startsWith("-"))
        return { kind: "recovery", target, action: `kubectl rollout restart ${target}` };
      return write("kubectl rollout restart needs one resource");
    }
    return programReads("kubectl", args) === "read" ? READ : write("kubectl may change the cluster");
  }
  if (program === "git")
    return programReads("git", args) === "read" ? READ : write("git may change something");
  if (program === "find")
    return findReads(args) && filtersRead(args) ? READ : write("find runs or deletes something");
  if (program === "dmesg")
    return args.some((a) => a === "-c" || a === "-C" || a === "--clear")
      ? write("dmesg clears the log")
      : READ;
  if (program === "top")
    return args.includes("-b") || args.includes("-bn1") ? READ : write("top without -b waits for a keyboard");
  if (program === "crontab")
    return args.length === 1 && args[0] === "-l" ? READ : write("crontab may change the schedule");
  if (program === "ping") return args.includes("-c") ? READ : write("ping without a count never ends");
  if (FILTERS.has(program))
    return filtersRead(args) ? READ : write(`${program} reads a login, key or secret file`);
  if (REPORTERS.has(program)) return READ;
  return write(`${program} may change something`);
}

function classifyLine(line: string, depth: number): RemoteVerdict {
  let parsed: ReturnType<typeof parseLine>;
  try {
    parsed = parseLine(line);
  } catch (err) {
    if (err instanceof ShellParseError) return write("majhi cannot read the command line");
    throw err;
  }
  if (parsed.substitutions.length > 0) return write("it runs a command inside the command");
  if (parsed.commands.length === 0) return write("it is empty");
  let recovery: RemoteVerdict | undefined;
  for (const cmd of parsed.commands) {
    const verdict = classifyOne(cmd, depth);
    if (verdict.kind === "write") return verdict;
    if (verdict.kind === "recovery") {
      if (recovery !== undefined) return write("it restarts more than one thing");
      recovery = verdict;
    }
  }
  return recovery ?? READ;
}

/** What a command line run on a connected host does. */
export function classifyRemoteCommand(line: string): RemoteVerdict {
  return classifyLine(line, 0);
}
