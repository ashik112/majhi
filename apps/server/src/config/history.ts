import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Actor } from "@majhi/shared";
import { errorCode, exitCode } from "../errors.ts";

const run = promisify(execFile);

/**
 * Credentials, databases, caches and the host helper's token, bundle, logs
 * and runtime files never enter the config history (SPEC 5.16).
 */
export const GITIGNORE = [
  "accounts/",
  "agent-homes/",
  "connections/",
  "memory/",
  "*.db",
  "*.db-*",
  "cache/",
  "backups/",
  "backup-settings.json",
  "backup-state.json",
  "restore-staging/",
  "restore-journal.json",
  "rollback/",
  "secrets.age",
  "host.token",
  "bin/",
  "logs/",
  "run/",
];

export const COMMITTER = { name: "majhi", email: "majhi@majhi.local" };

export interface CommitRequest {
  /** Paths relative to the config folder. Missing files are skipped. */
  files: readonly string[];
  message: string;
  actor: Actor;
  /** Extra `Key: value` lines after the message, read back by `entries`. */
  trailers?: Record<string, string>;
}

/** One commit of the config history, read back for `history.list`. */
export interface HistoryEntry {
  commit: string;
  at: string;
  /** `owner`, `manual` (hand edit) or an agent id. */
  actor: string;
  command: string | undefined;
  summary: string;
  reason: string | undefined;
  undone: boolean;
}

const TRAILER_PREFIX = "Majhi-";
const REVERTS = /^This reverts commit ([0-9a-f]{40})\./m;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** `message`, a blank line and one `Majhi-Key: value` line per trailer. */
export function withTrailers(message: string, trailers: Record<string, string> | undefined): string {
  const lines = Object.entries(trailers ?? {})
    .filter(([, value]) => oneLine(value) !== "")
    .map(([key, value]) => `${TRAILER_PREFIX}${key}: ${oneLine(value)}`);
  return lines.length === 0 ? message : `${message}\n\n${lines.join("\n")}`;
}

function trailersOf(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    if (!line.startsWith(TRAILER_PREFIX)) continue;
    const at = line.indexOf(": ");
    if (at > 0) out[line.slice(TRAILER_PREFIX.length, at)] = line.slice(at + 2).trim();
  }
  return out;
}

/**
 * The config folder as a git repository: one commit per change, so every
 * change can be seen and undone. Git runs with its identity and safety
 * settings on the command line, so the host's git config is never needed.
 */
export class ConfigHistory {
  constructor(readonly dir: string) {}

  /**
   * Runs `git init` when needed, and writes `.gitignore`, or appends the lines
   * it is missing. Reports what it did.
   */
  async ensureRepo(): Promise<{ initialized: boolean; changed: string[] }> {
    await mkdir(this.dir, { recursive: true });
    const initialized = !existsSync(join(this.dir, ".git"));
    if (initialized) await this.git(["init", "--quiet", "--initial-branch=main"]);
    const changed = (await this.ensureGitignore()) ? [".gitignore"] : [];
    return { initialized, changed };
  }

  /** Keeps the owner's own lines and adds the ones majhi needs. True when the file changed. */
  private async ensureGitignore(): Promise<boolean> {
    const file = join(this.dir, ".gitignore");
    const current = await readFile(file, "utf8").catch((err: unknown) => {
      if (errorCode(err) === "ENOENT") return "";
      throw err;
    });
    const present = new Set(current.split("\n").map((line) => line.trim()));
    const missing = GITIGNORE.filter((line) => !present.has(line));
    if (missing.length === 0) return false;
    const base = current === "" || current.endsWith("\n") ? current : `${current}\n`;
    await writeFile(file, `${base}${missing.join("\n")}\n`);
    return true;
  }

  /** Stages `files` and commits them. Returns the new commit, or undefined when nothing changed. */
  async commit(request: CommitRequest): Promise<string | undefined> {
    const files = request.files.filter((f) => existsSync(join(this.dir, f)));
    if (files.length === 0) return undefined;
    await this.git(["add", "--", ...files]);
    if (!(await this.hasStagedChanges())) return undefined;
    await this.git([
      "commit",
      "--quiet",
      "--no-verify",
      `--author=${authorOf(request.actor)}`,
      "-m",
      withTrailers(request.message, request.trailers),
    ]);
    const { stdout } = await this.git(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  /**
   * Writes the whole history (every branch) to a git bundle. False when there is no commit yet,
   * because git refuses an empty bundle.
   */
  async bundleTo(file: string): Promise<boolean> {
    if ((await this.head()) === undefined) return false;
    await this.git(["bundle", "create", "--quiet", file, "--all"]);
    return true;
  }

  /** Every file in the folder that git does not ignore, tracked or not, relative to it. */
  async visibleFiles(): Promise<string[]> {
    // A backup before the first start of the config service still has to know what is ignored.
    if (!existsSync(join(this.dir, ".git"))) await this.ensureRepo();
    const { stdout } = await this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    return stdout.split("\0").filter((f) => f !== "");
  }

  /** The commit at HEAD, or undefined before the first commit. */
  async head(): Promise<string | undefined> {
    try {
      return (await this.git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    } catch {
      return undefined;
    }
  }

  /** Commits after `from` up to HEAD, oldest first, as `{commit, subject, author}`. */
  async since(from: string | undefined): Promise<{ commit: string; subject: string; author: string }[]> {
    if ((await this.head()) === undefined) return [];
    const range = from === undefined ? ["HEAD"] : [`${from}..HEAD`];
    const { stdout } = await this.git(["log", "--reverse", "--format=%H%x1f%s%x1f%an", ...range]);
    return stdout
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [commit = "", subject = "", author = ""] = l.split("\u001f");
        return { commit, subject, author };
      });
  }

  /** The newest `limit` commits, newest first, with actor, command, reason and whether an undo names them. */
  async entries(limit: number): Promise<HistoryEntry[]> {
    if ((await this.head()) === undefined) return [];
    const { stdout } = await this.git(["log", `-n${limit}`, "--format=%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e"]);
    const rows = stdout
      .split("\u001e")
      .map((r) => r.replace(/^\n/, ""))
      .filter((r) => r.trim() !== "")
      .map((row) => {
        const [commit = "", at = "", author = "", subject = "", body = ""] = row.split("\u001f");
        return { commit, at, author, subject, body };
      });
    // Newest first: an undo is always newer than the change it names, so it is seen first.
    const undone = new Set<string>();
    const entries: HistoryEntry[] = [];
    for (const row of rows) {
      const trailers = trailersOf(row.body);
      const reverts = REVERTS.exec(row.body)?.[1];
      const isUndone = undone.has(row.commit);
      if (reverts !== undefined && !isUndone) undone.add(reverts);
      if (/^(init|gitignore):/.test(row.subject)) continue;
      const command = trailers.Command ?? /^([a-z]+\.[a-zA-Z.]+):/.exec(row.subject)?.[1];
      const manual = row.subject.startsWith("manual:");
      const authorId = row.author.toLowerCase();
      entries.push({
        commit: row.commit,
        at: row.at,
        actor: manual ? "manual" : (trailers.Actor ?? authorId),
        command,
        summary: trailers.Summary ?? row.subject,
        reason: trailers.Reason,
        undone: isUndone,
      });
    }
    return entries;
  }

  /** The full hash for a commit name, or undefined when it is not in this history. */
  async resolve(commit: string): Promise<string | undefined> {
    try {
      return (await this.git(["rev-parse", "--verify", `${commit}^{commit}`])).stdout.trim();
    } catch {
      return undefined;
    }
  }

  /** How many parents a commit has. The first commit has none and cannot be undone. */
  async parents(commit: string): Promise<number> {
    const { stdout } = await this.git(["rev-list", "--parents", "-n1", commit]);
    return stdout.trim().split(" ").length - 1;
  }

  /**
   * Reverts one commit into a new commit. Returns undefined, with the files as they were, when a
   * later change touched the same lines, or when the revert would change nothing.
   */
  async revert(
    commit: string,
    request: { message: string; actor: Actor; trailers: Record<string, string> },
  ): Promise<{ commit: string } | { failed: "conflict" | "empty" }> {
    try {
      await this.git(["revert", "--no-commit", commit]);
    } catch {
      await this.git(["reset", "--hard", "HEAD"]).catch(() => undefined);
      return { failed: "conflict" };
    }
    if (!(await this.hasStagedChanges())) {
      await this.git(["reset", "--hard", "HEAD"]).catch(() => undefined);
      return { failed: "empty" };
    }
    await this.git([
      "commit",
      "--quiet",
      "--no-verify",
      `--author=${authorOf(request.actor)}`,
      "-m",
      withTrailers(`${request.message}\n\nThis reverts commit ${commit}.`, request.trailers),
    ]);
    return { commit: (await this.git(["rev-parse", "HEAD"])).stdout.trim() };
  }

  private async hasStagedChanges(): Promise<boolean> {
    try {
      await this.git(["diff", "--cached", "--quiet"]);
      return false;
    } catch (err) {
      if (exitCode(err) === 1) return true;
      throw err;
    }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const settings = [
      `safe.directory=${this.dir}`,
      `user.name=${COMMITTER.name}`,
      `user.email=${COMMITTER.email}`,
      "commit.gpgsign=false",
      "core.hooksPath=/dev/null",
    ];
    return run("git", [...settings.flatMap((s) => ["-c", s]), ...args], {
      cwd: this.dir,
      env: gitEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
  }
}

/** `Owner <owner@majhi.local>`, or `<id> <id@majhi.local>` for an agent. */
export function authorOf(actor: Actor): string {
  if (actor.kind === "owner") return "Owner <owner@majhi.local>";
  const id = actor.id.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${id} <${id}@majhi.local>`;
}

/** The caller's environment without GIT_* variables, which would override the settings above. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}
