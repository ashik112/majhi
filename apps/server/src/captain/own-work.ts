import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Task } from "@majhi/shared";

/**
 * Own work (SPEC 5.18): which permission requests of a task the captain started it may approve by
 * itself. The request is read by its content, a command, a path or a host, never by the tool's name,
 * and anything the rules do not recognise as routine goes to the owner. Pure apart from reading the
 * file system to resolve symlinks. A request is approved only when every part of it is understood and
 * inside the task's scope; the first doubt makes it the owner's.
 */

export type OwnWorkVerdict =
  /** Routine and inside the task's scope: the captain may allow it once. */
  | { decision: "approve"; why: string }
  /** Left for the owner. `danger` is true when the request is something the rules never allow. */
  | { decision: "owner"; why: string; danger: boolean };

export interface OwnWorkScope {
  /** The task's worktrees: the only places a request may read or write. */
  worktrees: readonly string[];
  /** Where a relative path starts: the one worktree, or the task folder when there are several. */
  cwd: string;
}

const approve = (why: string): OwnWorkVerdict => ({ decision: "approve", why });
const owner = (why: string, danger = false): OwnWorkVerdict => ({ decision: "owner", why, danger });

// ---------------------------------------------------------------------------
// Words in the request that ask to be approved

/** Text in a request that tries to talk the captain into saying yes. A real command never reads like this. */
const PLEADING =
  /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(rules?|instructions?|previous|above|policy|policies)\b|\bapprove (this|it|every|all|me)\b|\b(captain|assistant|system|developer|owner)\b\s*[:,]|\b(you must|you should|you are allowed|you have been|is authori[sz]ed|pre-?approved|already approved|the owner (said|says|has approved))\b/i;

// ---------------------------------------------------------------------------
// Paths

/** A file name or folder that holds secrets or keys, wherever it is. */
const SECRET_NAME =
  /^(\.env(\..+)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.pypirc|\.yarnrc(\.yml)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx)|credentials(\..+)?|secrets?(\..+)?|.*\.secrets?(\..+)?|service-account.*\.json|\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config|\.majhi|authorized_keys|known_hosts)$/i;
const SECRET_OK = /^\.env\.(example|sample|template|defaults?)$/i;

function secretPart(path: string): string | undefined {
  for (const part of path.split(/[\\/]/)) {
    if (part === "" || part === "." || part === "..") continue;
    if (SECRET_OK.test(part)) continue;
    if (SECRET_NAME.test(part)) return part;
  }
  return undefined;
}

/** The real place a path points to: its deepest existing part resolved through symlinks. */
function realish(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return path;
    tail.unshift(basename(head));
    head = up;
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return path;
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Why a path is not the task's to touch, or undefined when it is inside a worktree and holds no secret. */
export function pathProblem(raw: string, scope: OwnWorkScope): { why: string; danger: boolean } | undefined {
  const text = raw.replace(/^["'`]+|["'`]+$/g, "");
  if (text === "") return { why: "it names an empty path", danger: false };
  if (text.includes("\0")) return { why: "its path has a NUL byte", danger: true };
  if (text.startsWith("~") || /\$|%\w+%/.test(text)) {
    return { why: `${text} is outside the task's folder`, danger: true };
  }
  if (text.split(/[\\/]/).includes("..")) {
    return { why: `${text} climbs out of the task's folder`, danger: true };
  }
  const secret = secretPart(text);
  if (secret !== undefined) return { why: `${secret} holds keys or secrets`, danger: true };
  const full = resolve(scope.cwd, text);
  const real = realish(full);
  const roots = scope.worktrees.map((w) => realish(resolve(w)));
  if (!roots.some((root) => within(root, real))) {
    return { why: `${text} is outside the task's worktree`, danger: true };
  }
  const afterRoot = roots.map((root) => relative(root, real)).find((rel) => !rel.startsWith(".."));
  if (afterRoot !== undefined) {
    const secretReal = secretPart(afterRoot);
    if (secretReal !== undefined) return { why: `${secretReal} holds keys or secrets`, danger: true };
    if (afterRoot.split(sep).includes(".git")) {
      return { why: "it reaches into .git, which holds hooks and credentials", danger: true };
    }
  }
  return undefined;
}

/** Whether an argument is meant as a path (so it is checked as one). */
function pathLike(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith(".") ||
    token.startsWith("~") ||
    token.includes("/") ||
    token.includes("\\")
  );
}

// ---------------------------------------------------------------------------
// Commands

/** Patterns that are never routine, with the reason said to the owner. */
const DANGER: readonly { re: RegExp; why: string }[] = [
  { re: /(^|[\s;&|])(rm|rmdir|unlink|shred|trash)\b/i, why: "it deletes files" },
  { re: /\bgit\s+(\S+\s+)*push\b/i, why: "it pushes" },
  {
    re: /\bgit\s+(\S+\s+)*(merge|rebase|reset|clean|checkout|switch|restore|pull|fetch|clone|remote|tag|cherry-pick|revert|stash\s+(drop|clear))\b/i,
    why: "it changes history or reaches a remote",
  },
  { re: /\b(curl|wget|nc|ncat|telnet|ftp|sftp|scp|ssh|rsync|httpie)\b/i, why: "it reaches the network" },
  { re: /\b[a-z][a-z0-9+.-]*:\/\//i, why: "it names a network address" },
  { re: /(^|[\s"'=@])[\w.-]+@[\w.-]+:[\w./-]*/, why: "it names a remote host" },
  { re: /\bsudo\b|\bdoas\b|\bsu\s/i, why: "it runs as root" },
  { re: /\bchmod\b|\bchown\b|\bchgrp\b/i, why: "it changes permissions" },
  { re: /\b(drop|truncate)\s+(table|database)\b/i, why: "it drops data" },
  { re: /\bmkfs\b|\bdd\s+if=|\bformat\b\s+[a-z]:/i, why: "it writes to a disk" },
  { re: /\b(env|printenv|export|set)\b\s*$|\bprintenv\b/i, why: "it prints the environment" },
  {
    re: /\b(security|keychain|gpg|pass|op)\s+(find|get|read|show|export|item)\b/i,
    why: "it reads a secret store",
  },
  {
    re: /\bdocker\b|\bkubectl\b|\bterraform\b|\bhelm\b|\baws\b|\bgcloud\b|\baz\b\s/i,
    why: "it reaches infrastructure",
  },
];

/** Characters that chain, redirect or substitute: the command is more than it looks. */
const SHELL_META = /[;|`<>\n\r]|\$\(|\$\{|&(?!&)|\|\||\\$/;

const SAFE_ENV = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG|LC_ALL)=[\w.:-]*$/;

/** Flags no routine command needs: they point a tool at another config, registry or global place. */
const BAD_FLAG =
  /^(--registry|--userconfig|--globalconfig|--global|-g|--prefix|--eval|-e|--require|--import|--loader|--exec|-exec|-delete|-ok|--script-shell|--shell|--allow-run-script|-c|--config-file)(=|$)/;

function tokenize(segment: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let any = false;
  for (const ch of segment) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== "" || any) out.push(cur);
      cur = "";
      any = false;
      continue;
    }
    cur += ch;
  }
  if (quote !== undefined) return undefined;
  if (cur !== "" || any) out.push(cur);
  return out;
}

const SCRIPT_NAME =
  /^(test|tests|t|build|lint|typecheck|type-check|check|format|fmt|tsc|e2e|ci|verify|compile|dev:build|test:[\w:.-]+|build:[\w:.-]+|lint:[\w:.-]+|check:[\w:.-]+|typecheck:[\w:.-]+|format:check|e2e:[\w:.-]+)$/;
const PKG_FLAG =
  /^(-r|--recursive|--silent|-s|--quiet|--frozen-lockfile|--offline|--prefer-offline|--no-color|--if-present|--workspaces|-ws|--ignore-scripts|--workspace-root|-w|--no-audit|--no-fund|--ci)$/;
const PKG_FILTER = /^(--filter|-F|--workspace|-w)$/;

/** Reasons a flag is not routine, else undefined. Values of known option flags are skipped by the caller. */
function flagProblem(token: string): string | undefined {
  if (BAD_FLAG.test(token)) return `${token} points the tool somewhere else`;
  return undefined;
}

type Check = { ok: true; what: string } | { ok: false; why: string; danger: boolean };
const ok = (what: string): Check => ({ ok: true, what });
const no = (why: string, danger = false): Check => ({ ok: false, why, danger });

/** Every path-like argument must be inside the worktree. */
function checkArgs(args: readonly string[], scope: OwnWorkScope): Check | undefined {
  for (const arg of args) {
    const bad = flagProblem(arg);
    if (bad !== undefined) return no(bad, true);
    const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (arg.startsWith("-") && !arg.includes("=")) continue;
    if (value.startsWith("@") && !value.includes("/")) continue;
    if (pathLike(value)) {
      const problem = pathProblem(value, scope);
      if (problem !== undefined) return no(problem.why, problem.danger);
    }
  }
  return undefined;
}

function packageManager(exe: string, args: readonly string[], scope: OwnWorkScope): Check {
  // Skip options (and the value of --filter) before the verb.
  const rest = [...args];
  const flags: string[] = [];
  while (rest[0]?.startsWith("-") === true) {
    const flag = rest.shift() as string;
    if (PKG_FILTER.test(flag)) {
      const value = rest.shift();
      if (value === undefined || !/^[\w@][\w@./*:-]*$/.test(value)) return no(`${flag} needs a package name`);
      continue;
    }
    if (!PKG_FLAG.test(flag)) return no(`${flag} is not a routine option`, BAD_FLAG.test(flag));
    flags.push(flag);
  }
  const verb = rest.shift();
  if (verb === undefined) return no(`${exe} with no command is not routine`);
  const run = verb === "run" || verb === "run-script" ? verb : undefined;
  if (verb === "exec" || verb === "dlx" || verb === "x")
    return no(`${exe} ${verb} runs a program it may download`);
  if (["install", "i", "ci"].includes(verb)) {
    const extra = rest.filter((a) => !a.startsWith("-"));
    if (extra.length > 0) return no(`${exe} ${verb} ${extra[0]} adds a package the project does not declare`);
    for (const f of rest) {
      if (!PKG_FLAG.test(f)) return no(`${f} is not a routine option`, BAD_FLAG.test(f));
    }
    return ok("installs the packages the project declares");
  }
  let script = verb;
  if (run !== undefined) {
    const named = rest.shift();
    if (named === undefined) return no(`${exe} ${verb} needs a script name`);
    script = named;
  }
  if (!SCRIPT_NAME.test(script)) return no(`${script} is not a test, build or lint script`);
  const tail = rest[0] === "--" ? rest.slice(1) : rest;
  const bad = checkArgs(tail, scope);
  if (bad !== undefined) return bad;
  return ok(`runs the project's ${script} script`);
}

/** Tools that run the project's own tests, build or lint, with path arguments checked. */
const PROJECT_TOOLS: Readonly<Record<string, RegExp | true>> = {
  vitest: true,
  jest: true,
  tsc: true,
  biome: /^(check|lint|format|ci)$/,
  eslint: true,
  prettier: true,
  pytest: true,
  ruff: /^(check|format)$/,
  mypy: true,
  cargo: /^(test|build|check|clippy|fmt|bench|doc)$/,
  go: /^(test|build|vet|fmt|list|mod)$/,
  make: /^(test|tests|build|lint|check|typecheck|ci|all|fmt|format)$/,
  gradle: /^(test|build|check|lint)$/,
  mvn: /^(test|verify|compile|package)$/,
  dotnet: /^(test|build)$/,
  swift: /^(test|build)$/,
};

/** Programs that only read what they are given. */
const READERS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "pwd",
  "stat",
  "file",
  "tree",
  "diff",
  "sort",
  "uniq",
  "basename",
  "dirname",
  "echo",
  "true",
  "which",
  "realpath",
]);
/** Programs that change files in the worktree, with no delete. */
const WRITERS = new Set(["mkdir", "touch", "cp", "mv"]);

const GIT_READ = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
]);
const GIT_WRITE = new Set(["add", "commit"]);

function git(args: readonly string[], scope: OwnWorkScope): Check {
  const rest = [...args];
  // `git -C <dir>` names a folder: it must be inside too.
  if (rest[0] === "-C") {
    rest.shift();
    const dir = rest.shift();
    if (dir === undefined) return no("git -C needs a folder");
    const problem = pathProblem(dir, scope);
    if (problem !== undefined) return no(problem.why, problem.danger);
  }
  const verb = rest.shift();
  if (verb === undefined) return no("git with no command is not routine");
  if (verb === "branch") {
    return rest.length === 0 ||
      (rest.length === 1 && ["--show-current", "--list", "-a", "-v"].includes(rest[0] ?? ""))
      ? ok("lists branches")
      : no("it creates or deletes a branch");
  }
  if (verb === "stash")
    return rest[0] === "list" ? ok("lists stashes") : no("git stash changes the worktree");
  if (!GIT_READ.has(verb) && !GIT_WRITE.has(verb)) return no(`git ${verb} is not routine`, true);
  if (verb === "commit") {
    for (const a of rest) {
      if (a.startsWith("-") && !/^(-m|-a|-am|-q|--quiet|--no-verify|--message=.*|--signoff|-s)$/.test(a)) {
        return no(`git commit ${a} is not routine`);
      }
    }
    if (rest.some((a) => a === "--no-verify")) return no("git commit --no-verify skips the project's checks");
    return ok("commits in the task's worktree");
  }
  const bad = checkArgs(
    rest.filter((a) => !a.startsWith("-") || a.includes("=")),
    scope,
  );
  if (bad !== undefined) return bad;
  return ok(GIT_WRITE.has(verb) ? "stages files in the task's worktree" : "reads the repository");
}

/** A bare file name is a path too: `ls escape` follows a link out of the worktree. */
function everyName(tokens: readonly string[], scope: OwnWorkScope): Check | undefined {
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    const problem = pathProblem(token, scope);
    if (problem !== undefined) return no(problem.why, problem.danger);
  }
  return undefined;
}

function segmentCheck(segment: string, scope: OwnWorkScope): Check {
  const tokens = tokenize(segment.trim());
  if (tokens === undefined) return no("a quote is not closed");
  while (tokens[0] !== undefined && SAFE_ENV.test(tokens[0])) tokens.shift();
  const exe = tokens.shift();
  if (exe === undefined) return no("it is empty");
  if (/=/.test(exe)) return no("it sets an environment variable the rules do not know");
  if (exe === "cd") {
    const dir = tokens[0];
    if (dir === undefined || tokens.length !== 1) return no("cd needs one folder");
    const problem = pathProblem(dir, scope);
    return problem === undefined ? ok("moves inside the task's worktree") : no(problem.why, problem.danger);
  }
  if (["pnpm", "npm", "yarn", "bun"].includes(exe)) return packageManager(exe, tokens, scope);
  if (exe === "git") return git(tokens, scope);
  if (READERS.has(exe)) {
    const bad = checkArgs(tokens, scope) ?? everyName(tokens, scope);
    return bad ?? ok(`${exe} reads inside the task's worktree`);
  }
  if (WRITERS.has(exe)) {
    const bad = checkArgs(tokens, scope);
    if (bad !== undefined) return bad;
    const paths = tokens.filter((t) => !t.startsWith("-"));
    if (paths.length === 0) return no(`${exe} names nothing`);
    for (const p of paths) {
      const problem = pathProblem(p, scope);
      if (problem !== undefined) return no(problem.why, problem.danger);
    }
    return ok(`${exe} changes files inside the task's worktree`);
  }
  if (exe === "python" || exe === "python3") {
    if (tokens[0] === "-m" && tokens[1] === "pytest") {
      return checkArgs(tokens.slice(2), scope) ?? ok("runs the project's tests");
    }
    return no("running a script is not a routine request");
  }
  const tool = PROJECT_TOOLS[exe];
  if (tool !== undefined) {
    const first = tokens.find((t) => !t.startsWith("-"));
    if (tool !== true && (first === undefined || !tool.test(first))) {
      return no(`${exe} ${first ?? ""}`.trim() + " is not a test, build or lint command");
    }
    if (
      exe === "go" &&
      first === "mod" &&
      tokens[1] !== "tidy" &&
      tokens[1] !== "download" &&
      tokens[1] !== "verify"
    ) {
      return no("go mod changes dependencies");
    }
    const bad = checkArgs(tokens, scope);
    return bad ?? ok(`runs the project's ${exe}`);
  }
  return no(`${exe} is not a command the rules know as routine`);
}

/** The reason and verdict for a shell command line. */
export function commandVerdict(command: string, scope: OwnWorkScope): OwnWorkVerdict {
  const text = command.trim();
  if (text === "") return owner("the request names no command");
  for (const rule of DANGER) {
    if (rule.re.test(text)) return owner(`${rule.why}, so only you decide it`, true);
  }
  if (SHELL_META.test(text.replaceAll("&&", "  ")) || /(^|\s)#/.test(text)) {
    return owner("it chains, redirects or substitutes commands, so only you read it", false);
  }
  const parts = text.split("&&");
  const whats: string[] = [];
  for (const part of parts) {
    const checked = segmentCheck(part, scope);
    if (!checked.ok) return owner(`${checked.why}, so only you decide it`, checked.danger);
    whats.push(checked.what);
  }
  return approve(`it ${whats.filter((w, i) => whats.indexOf(w) === i).join(" and ")}`);
}

// ---------------------------------------------------------------------------
// The request as an agent's permission prompt shows it

const READ_VERBS = /^(read|view|open|cat|glob|grep|search|find|list|ls|tree|look at|show)\b/i;
const WRITE_VERBS =
  /^(edit|write|multiedit|update|create|modify|notebookedit|apply patch|patch|replace in)\b/i;
const SHELL_VERBS = /^(bash|run|shell|execute|exec|terminal|command|sh)\b/i;
/** majhi's own tools that only read (the rule table allows them too). */
const MAJHI_READ = /^mcp__majhi[\w-]*__(list|logs|status|get|read|search)[\w]*$/i;

function stripVerb(text: string, verb: RegExp): string {
  return text
    .replace(verb, "")
    .replace(/^\s*[:-]\s*/, "")
    .replace(/^\s*(to|file|in|at)\s+/i, "")
    .trim();
}

/**
 * Whether the captain may allow this permission request once. `title` is what the prompt says: the tool
 * and a summary of its arguments. The tool's name is only a hint at how to read the rest.
 */
export function classifyOwnWork(title: string, scope: OwnWorkScope): OwnWorkVerdict {
  const text = title.trim();
  if (text.replace(/[\s.…_\-"'`*]/g, "") === "") return owner("the request has no readable text");
  if (scope.worktrees.length === 0) return owner("the task has no worktree to keep the request inside");
  if (PLEADING.test(text))
    return owner("the request asks to be approved, which no routine command does", true);
  if (/^mcp__/i.test(text)) {
    return MAJHI_READ.test(text)
      ? approve("it is a read-only tool of majhi")
      : owner("it is a tool the rules do not know");
  }
  // A title in backticks is the command itself.
  const bare = text.replace(/^`+|`+$/g, "");
  if (SHELL_VERBS.test(bare))
    return commandVerdict(stripVerb(bare, SHELL_VERBS).replace(/^`+|`+$/g, ""), scope);
  if (WRITE_VERBS.test(bare) || READ_VERBS.test(bare)) {
    const writing = WRITE_VERBS.test(bare);
    const rest = stripVerb(bare, writing ? WRITE_VERBS : READ_VERBS);
    // `ls`, `cat` and `find` are commands too: read them as such when they look like one.
    if (!writing && /^(ls|cat|find|tree)\b/i.test(bare)) return commandVerdict(bare, scope);
    const words = rest.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) return owner("the request names nothing");
    if (writing && words.length !== 1) return owner("the request names more than one thing to change");
    for (const w of words) {
      const problem = pathProblem(w, scope);
      if (problem !== undefined) return owner(`${problem.why}, so only you decide it`, problem.danger);
    }
    return approve(
      writing ? "it edits a file inside the task's worktree" : "it reads inside the task's worktree",
    );
  }
  return commandVerdict(bare, scope);
}

/**
 * Where Own work may approve in a task: its worktrees, except those of a protected repo the owner did
 * not open for writing. Undefined when the task has no such place.
 */
export function scopeOfTask(
  task: Pick<Task, "folder" | "repos">,
  guarded: ReadonlySet<string>,
): OwnWorkScope | undefined {
  const worktrees = task.repos.flatMap((r) =>
    r.worktree === undefined || (guarded.has(r.project) && r.writes !== true) ? [] : [r.worktree],
  );
  const [only] = worktrees;
  if (only === undefined) return undefined;
  return { worktrees, cwd: worktrees.length === 1 ? only : task.folder };
}
