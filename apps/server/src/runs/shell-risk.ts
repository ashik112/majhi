import { heaviest, type RiskKind } from "@majhi/shared";
import { insideRoots, programReads, type ReadScope } from "../connections/read-only.ts";
import { parseLine, ShellParseError, type SimpleCommand } from "../connections/shell.ts";

/**
 * What a shell command line does, as a risk kind (docs/briefs/workflow-reset.md, step 1b). The line is read
 * by the shell parser into commands and words, and each command by its program and arguments: never by a
 * pattern over the whole line. A command that stays in the task (its tests, builds, installs, git on its
 * own branch, its containers) is `sandbox`; what leaves it is named below. A line the parser cannot read is
 * `other`, which asks.
 */

export interface RiskScope extends Pick<ReadScope, "roots" | "cwd"> {
  /** The task's own branches, one per repo it writes. Pushing one of these is `push-branch`. */
  branches: readonly string[];
}

/** Programs that run the command they are given: the inner command decides. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "time",
  "nohup",
  "exec",
  "command",
  "nice",
  "timeout",
  "xargs",
  "setsid",
  "stdbuf",
  "npx",
  "bunx",
]);
/** How many words into a wrapper's arguments its command can start (options and their values come first). */
const MAX_WRAPPED_START = 6;
/** Programs that run a script text after `-c`. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ash"]);
/** Package runners: `pnpm exec <program>`, `pnpm dlx <program>`. */
const RUNNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  pnpm: new Set(["exec", "dlx"]),
  npm: new Set(["exec"]),
  yarn: new Set(["exec", "dlx"]),
};
/** Programs whose listed verbs publish to a registry or a host outside the task. */
const PUBLISHES: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["publish"]),
  pnpm: new Set(["publish"]),
  yarn: new Set(["publish", "npm"]),
  cargo: new Set(["publish"]),
  twine: new Set(["upload"]),
  gem: new Set(["push"]),
  docker: new Set(["push"]),
};
/** Hosting CLIs whose `deploy` puts the work live. Named by program: the environment is not in the words. */
const DEPLOYS: Readonly<Record<string, ReadonlySet<string>>> = {
  wrangler: new Set(["deploy", "publish"]),
  vercel: new Set(["deploy"]),
  netlify: new Set(["deploy"]),
  fly: new Set(["deploy"]),
  flyctl: new Set(["deploy"]),
  firebase: new Set(["deploy"]),
};
/** Programs that delete or move away what they are given: a target outside the task is `delete-outside`. */
const DELETERS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred", "mv"]);
/** Folders and files that hold keys and logins. Outside the task, a command that names one touches a secret. */
const CREDENTIAL_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  ".git-credentials",
  ".majhi",
  ".docker",
]);
const KEY_FILES: readonly string[] = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

const MAX_DEPTH = 4;

/** Where a command is read from: the task's folders, and the branches that are its own. */
export function riskScopeOfTask(
  task:
    | {
        folder: string;
        repos: readonly {
          worktree?: string | undefined;
          branch: string;
          base: string;
          writes?: boolean | undefined;
        }[];
      }
    | undefined,
): RiskScope {
  if (task === undefined) return { roots: [], cwd: "/", branches: [] };
  return {
    roots: [task.folder, ...task.repos.flatMap((r) => (r.worktree === undefined ? [] : [r.worktree]))],
    cwd: task.folder,
    branches: task.repos.filter((r) => r.writes !== false && r.branch !== r.base).map((r) => r.branch),
  };
}

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** `NAME=value` before the program, as the shell reads it: a name of letters, digits and `_`, then `=`. */
function isAssignment(word: string): boolean {
  const eq = word.indexOf("=");
  if (eq <= 0) return false;
  for (const ch of word.slice(0, eq)) {
    const ok = ch === "_" || (ch >= "0" && ch <= "9") || (ch.toLowerCase() >= "a" && ch.toLowerCase() <= "z");
    if (!ok) return false;
  }
  return true;
}

function secretWord(word: string, scope: RiskScope): boolean {
  const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  const parts = value.split("/");
  const names = parts.some((p) => CREDENTIAL_SEGMENTS.has(p) || KEY_FILES.some((k) => p.startsWith(k)));
  return names && !insideRoots(value, scope);
}

/** The first word that is not an option, skipping the options that take a value as their next word. */
function firstWord(args: readonly string[], valued: ReadonlySet<string> = new Set()): number {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    if (valued.has(word)) i++;
    else if (!word.startsWith("-")) return i;
  }
  return -1;
}

const GIT_VALUED: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GH_VALUED: ReadonlySet<string> = new Set(["-R", "--repo", "--hostname"]);

function gitPush(args: readonly string[], scope: RiskScope): RiskKind {
  const refspecs: string[] = [];
  let remoteSeen = false;
  let removes = false;
  let wide = false;
  for (const word of args) {
    if (word.startsWith("-")) {
      if (word === "-d" || word === "--delete") removes = true;
      if (word === "--mirror" || word === "--all" || word === "--tags" || word === "--prune") wide = true;
      continue;
    }
    if (!remoteSeen) remoteSeen = true;
    else refspecs.push(word);
  }
  if (removes) return "delete-outside";
  if (wide) return "merge-main";
  const own = new Set(scope.branches);
  for (const spec of refspecs) {
    const bare = spec.startsWith("+") ? spec.slice(1) : spec;
    const colon = bare.indexOf(":");
    if (colon === 0) return "delete-outside";
    const dst = colon === -1 ? bare : bare.slice(colon + 1);
    if (dst.startsWith("refs/tags/")) return "merge-main";
    const branch = dst.startsWith("refs/heads/") ? dst.slice("refs/heads/".length) : dst;
    if (branch !== "HEAD" && !own.has(branch)) return "merge-main";
  }
  return "push-branch";
}

/** `gh` and `glab`: reads stay inside, a draft request is the task's own branch, the rest by what it touches. */
function hostCli(program: "gh" | "glab", args: readonly string[]): RiskKind {
  if (programReads(program, args) === "read") return "sandbox";
  const at = firstWord(args, GH_VALUED);
  const group = at === -1 ? "" : (args[at] ?? "");
  const after = at === -1 ? [] : args.slice(at + 1);
  const verbAt = firstWord(after, GH_VALUED);
  const verb = verbAt === -1 ? "" : (after[verbAt] ?? "");
  const requests = group === "pr" || group === "mr";
  if (verb === "delete") return "delete-outside";
  if (requests && verb === "merge") return "merge-main";
  if (requests && verb === "create") {
    const draft = args.includes("--draft") || (program === "gh" && args.includes("-d"));
    return draft ? "push-branch" : "client-message";
  }
  if (requests || group === "issue") return "client-message";
  if (
    group === "secret" ||
    group === "variable" ||
    group === "ssh-key" ||
    group === "gpg-key" ||
    group === "auth"
  ) {
    return "secret";
  }
  return "client-server-write";
}

function classifyCommand(cmd: SimpleCommand, scope: RiskScope, depth: number): RiskKind {
  const kinds: RiskKind[] = [];
  for (const redirect of cmd.redirects) {
    if (secretWord(redirect.target, scope)) kinds.push("secret");
  }
  let words = cmd.words;
  while (words[0] !== undefined && isAssignment(words[0])) words = words.slice(1);
  if (words.some((w) => secretWord(w, scope))) kinds.push("secret");
  const [first, ...args] = words;
  if (first === undefined) return heaviest(kinds);
  const program = programName(first);

  if (WRAPPERS.has(program)) {
    // The wrapped command starts after the wrapper's own options and their values, which differ by program:
    // read each place it could start and keep the heaviest.
    if (depth < MAX_DEPTH) {
      for (let i = 0; i < Math.min(args.length, MAX_WRAPPED_START); i++) {
        kinds.push(classifyCommand({ words: args.slice(i), redirects: [] }, scope, depth + 1));
      }
    }
  } else if (RUNNERS[program]?.has(args[0] ?? "") === true && args.length > 1 && depth < MAX_DEPTH) {
    kinds.push(classifyCommand({ words: args.slice(1), redirects: [] }, scope, depth + 1));
  } else if (SHELLS.has(program)) {
    const c = args.findIndex((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("c"));
    // Codex hands the command over as an argv joined with spaces, so the script is every word after `-c`.
    const script = c === -1 ? undefined : args.slice(c + 1).join(" ");
    if (script !== undefined && script !== "" && depth < MAX_DEPTH) {
      kinds.push(classifyLine(script, scope, depth + 1));
    }
  } else if (program === "git") {
    const at = firstWord(args, GIT_VALUED);
    if (at !== -1 && args[at] === "push") kinds.push(gitPush(args.slice(at + 1), scope));
  } else if (program === "gh" || program === "glab") {
    kinds.push(hostCli(program, args));
  } else if (DELETERS.has(program)) {
    const targets = args.filter((a) => !a.startsWith("-"));
    // `mv a b` moves a away from where it was: its sources are what leave. `rm` names only sources.
    const sources = program === "mv" ? targets.slice(0, -1) : targets;
    if (sources.some((t) => !insideRoots(t, scope))) kinds.push("delete-outside");
  } else if (program === "find" && args.includes("-delete")) {
    const stop = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
    const places = stop === -1 ? args : args.slice(0, stop);
    if (places.some((t) => !insideRoots(t, scope))) kinds.push("delete-outside");
  } else if (PUBLISHES[program] !== undefined || DEPLOYS[program] !== undefined) {
    const at = firstWord(args);
    const verb = at === -1 ? "" : (args[at] ?? "");
    if (PUBLISHES[program]?.has(verb) === true) kinds.push("client-server-write");
    if (DEPLOYS[program]?.has(verb) === true) kinds.push("deploy-production");
  } else if (program === "docker") {
    const at = firstWord(args);
    if (at !== -1 && args[at] === "login") kinds.push("secret");
  }
  return heaviest(kinds);
}

function classifyLine(line: string, scope: RiskScope, depth: number): RiskKind {
  let parsed: ReturnType<typeof parseLine>;
  try {
    parsed = parseLine(line);
  } catch (err) {
    if (err instanceof ShellParseError) return "other";
    throw err;
  }
  const kinds = parsed.commands.map((c) => classifyCommand(c, scope, depth));
  if (depth < MAX_DEPTH)
    for (const inner of parsed.substitutions) kinds.push(classifyLine(inner, scope, depth + 1));
  return heaviest(kinds);
}

/** The heaviest risk of any command in the line. An empty line is `sandbox`. */
export function shellRisk(line: string, scope: RiskScope): RiskKind {
  return classifyLine(line, scope, 0);
}
