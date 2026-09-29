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
      request.message,
    ]);
    const { stdout } = await this.git(["rev-parse", "HEAD"]);
    return stdout.trim();
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
