/**
 * Signs a workspace in to a git host with the host's own CLI in the browser: `gh auth login --web`
 * or `glab auth login --web`. Their OAuth apps are already registered, so majhi needs none.
 *
 * Isolation, so the owner's own CLI login is never read or changed:
 * - The CLI runs with a config folder of the workspace's own, `<MAJHI_HOME>/git/<org>/<cli>`
 *   (mode 700), and `HOME` and the XDG folders pointed inside it.
 * - `--insecure-storage` keeps the token in that folder's file, never a system keyring.
 * - The environment is built here: no `GH_TOKEN`, `GITLAB_TOKEN` or anything else of the helper's.
 * - The token is read from that folder's file only (never `gh auth token`, which falls back to the
 *   keyring), and the folder is removed when the job ends, whatever happened.
 *
 * The CLI's output is only searched for the page and the one-time code. It is never logged, put in
 * an error or sent anywhere, so a token in it cannot leak.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GITHUB_TOKEN_SCOPES,
  type GitCli,
  type GitCliLoginResult,
  type HostLoginProgress,
  IdSchema,
} from "@majhi/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** A sign-in never runs longer than this: GitHub's device codes last 15 minutes. */
export const CLI_LOGIN_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 64 * 1024;

/** The marker the browser script prints, so the page is found whatever the CLI itself says. */
const URL_MARKER = "MAJHI_LOGIN_URL";

const LABEL: Record<GitCli, string> = { gh: "GitHub", glab: "GitLab" };

export interface CliLoginDeps {
  majhiHome: string;
  /** The PATH the CLI is found on and runs with. */
  path: string;
  /** Absolute path of `gh` or `glab`, or undefined when not installed. */
  find: (cli: GitCli) => Promise<string | undefined>;
  /** Passed on when set, so the CLI has a temp folder and a locale. Nothing else of the helper's. */
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

export interface CliLoginParams {
  signIn: string;
  cli: GitCli;
  org: string;
  host: string;
}

/** The page and code a CLI printed. Either may be missing until the CLI prints it. */
export function parseLoginOutput(text: string): { url?: string; code?: string } {
  const out: { url?: string; code?: string } = {};
  const code = /one-time code[^A-Z0-9]*\(?([A-Z0-9]{4}-[A-Z0-9]{4})\)?/i.exec(text);
  if (code?.[1] !== undefined) out.code = code[1].toUpperCase();
  const marked = new RegExp(`${URL_MARKER} (https?://\\S+)`).exec(text);
  const shown = /Open this URL to continue in your web browser: (https?:\/\/\S+)/.exec(text);
  const url = marked?.[1] ?? shown?.[1];
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") out.url = parsed.toString();
    } catch {
      // Not a URL after all.
    }
  }
  return out;
}

/** The folder a workspace's CLI sign-in runs in. `org` is a workspace id, so it never leaves the folder. */
export function loginDir(majhiHome: string, org: string, cli: GitCli): string {
  return join(majhiHome, "git", IdSchema.parse(org), cli);
}

/** The CLI's arguments. No token, ever: the CLI makes it and keeps it in its own file. */
export function loginArgs(cli: GitCli, host: string): string[] {
  const common = ["auth", "login", "--hostname", host, "--web", "--git-protocol", "https"];
  return cli === "gh"
    ? [...common, "--skip-ssh-key", "--insecure-storage", "--scopes", GITHUB_TOKEN_SCOPES.join(",")]
    : [...common, "--insecure-storage"];
}

const GhHostsSchema = z.record(
  z.string(),
  z
    .object({
      oauth_token: z.string().min(1).optional(),
      user: z.string().optional(),
      users: z
        .record(z.string(), z.object({ oauth_token: z.string().min(1).optional() }).nullable())
        .optional(),
    })
    .nullable(),
);

const GlabConfigSchema = z.object({
  hosts: z.record(
    z.string(),
    z
      .object({
        token: z.string().min(1).optional(),
        oauth2_refresh_token: z.string().min(1).optional(),
        oauth2_expiry_date: z.string().optional(),
      })
      .nullable(),
  ),
});

/** The token a finished login left in its config folder. Throws a safe sentence when there is none. */
export async function readLoginToken(
  cli: GitCli,
  configDir: string,
  host: string,
): Promise<Extract<GitCliLoginResult, { state: "done" }>> {
  const missing = new Error(`${cli} finished, but left no token for ${host}. Start the sign-in again.`);
  let text: string;
  try {
    text = await readFile(join(configDir, cli === "gh" ? "hosts.yml" : "config.yml"), "utf8");
  } catch {
    throw missing;
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw missing;
  }
  if (cli === "gh") {
    const hosts = GhHostsSchema.safeParse(raw);
    const entry = hosts.success ? hosts.data[host] : undefined;
    const token =
      entry?.oauth_token ??
      (entry?.user === undefined ? undefined : (entry.users?.[entry.user]?.oauth_token ?? undefined));
    if (token === undefined) throw missing;
    return { state: "done", token };
  }
  const config = GlabConfigSchema.safeParse(raw);
  const entry = config.success ? config.data.hosts[host] : undefined;
  if (entry === null || entry === undefined || entry.token === undefined) throw missing;
  const expiry = entry.oauth2_expiry_date === undefined ? Number.NaN : Date.parse(entry.oauth2_expiry_date);
  return {
    state: "done",
    token: entry.token,
    ...(entry.oauth2_refresh_token === undefined ? {} : { refreshToken: entry.oauth2_refresh_token }),
    ...(Number.isNaN(expiry) ? {} : { expiresAt: new Date(expiry).toISOString() }),
  };
}

/** A safe sentence for a CLI that ended without signing in. Never the CLI's own words. */
function failure(cli: GitCli, output: string): Error {
  const host = LABEL[cli];
  if (/access[_ ]denied|denied|refused/i.test(output)) {
    return new Error(`The sign-in was refused on ${host}. Nothing was saved.`);
  }
  if (/expired|timed? ?out/i.test(output)) {
    return new Error(`The ${host} sign-in ran out of time. Nothing was saved. Start it again.`);
  }
  if (cli === "glab" && /client_id|address already in use|7171/i.test(output)) {
    return new Error(
      "glab could not start its sign-in on this computer. Paste a personal access token instead.",
    );
  }
  return new Error(`${cli} did not finish the sign-in. Nothing was saved. Start it again.`);
}

interface Running {
  child: ChildProcess;
  cancelled: boolean;
  key: string;
}

/**
 * Runs CLI sign-ins, one per workspace and CLI at a time, and stops them on request. A new sign-in
 * for the same workspace and CLI stops the old one first.
 */
export class CliLogins {
  private readonly running = new Map<string, Running>();

  constructor(private readonly deps: CliLoginDeps) {}

  /** Stops the sign-in's CLI. False when none runs. */
  cancel(signIn: string): boolean {
    const run = this.running.get(signIn);
    if (run === undefined) return false;
    run.cancelled = true;
    kill(run.child);
    return true;
  }

  async login(
    params: CliLoginParams,
    progress: (progress: Omit<HostLoginProgress, "id">) => void,
  ): Promise<GitCliLoginResult> {
    const file = await this.deps.find(params.cli);
    if (file === undefined) return { state: "missing" };
    const key = `${params.org}/${params.cli}`;
    for (const [id, run] of this.running) if (run.key === key) this.cancel(id);

    const dir = loginDir(this.deps.majhiHome, params.org, params.cli);
    const configDir = join(dir, "config");
    const home = join(dir, "home");
    await rm(dir, { recursive: true, force: true });
    for (const folder of [join(this.deps.majhiHome, "git"), join(this.deps.majhiHome, "git", params.org)]) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
    }
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const browser = join(dir, "open-url");
    await writeFile(browser, `#!/bin/sh\nprintf '${URL_MARKER} %s\\n' "$1" >&2\n`, { mode: 0o700 });

    try {
      return await this.run(file, params, { dir, configDir, home, browser }, progress);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private run(
    file: string,
    params: CliLoginParams,
    where: { dir: string; configDir: string; home: string; browser: string },
    progress: (progress: Omit<HostLoginProgress, "id">) => void,
  ): Promise<GitCliLoginResult> {
    const env: Record<string, string> = {
      PATH: this.deps.path,
      HOME: where.home,
      XDG_CONFIG_HOME: join(where.home, ".config"),
      XDG_STATE_HOME: join(where.home, ".local", "state"),
      XDG_DATA_HOME: join(where.home, ".local", "share"),
      XDG_CACHE_HOME: join(where.home, ".cache"),
      BROWSER: where.browser,
      GLAB_BROWSER: where.browser,
      NO_COLOR: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GLAB_CHECK_UPDATE: "false",
      ...(params.cli === "gh" ? { GH_CONFIG_DIR: where.configDir } : { GLAB_CONFIG_DIR: where.configDir }),
    };
    for (const name of ["TMPDIR", "LANG", "LC_ALL"]) {
      const value = this.deps.env?.[name];
      if (value !== undefined && value !== "") env[name] = value;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(file, loginArgs(params.cli, params.host), {
        env,
        cwd: where.home,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const run: Running = { child, cancelled: false, key: `${params.org}/${params.cli}` };
      this.running.set(params.signIn, run);
      let output = "";
      let told = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        kill(child);
      }, this.deps.timeoutMs ?? CLI_LOGIN_TIMEOUT_MS);
      const take = (chunk: Buffer): void => {
        if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
        if (told) return;
        const found = parseLoginOutput(output);
        // gh prints its code first; wait for both so the owner sees them together.
        if (found.url !== undefined && (params.cli === "glab" || found.code !== undefined)) {
          told = true;
          progress({ login: { url: found.url, ...(found.code === undefined ? {} : { code: found.code }) } });
        }
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      let ended = false;
      const end = (code: number | null): void => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (this.running.get(params.signIn) === run) this.running.delete(params.signIn);
        if (run.cancelled) {
          resolve({ state: "cancelled" });
          return;
        }
        if (timedOut) {
          reject(new Error(`The ${LABEL[params.cli]} sign-in ran out of time. Nothing was saved.`));
          return;
        }
        if (code !== 0) {
          reject(failure(params.cli, output));
          return;
        }
        readLoginToken(params.cli, where.configDir, params.host).then(resolve, reject);
      };
      child.on("error", () => end(null));
      child.on("close", (code) => end(code));
    });
  }
}

/** Ends the CLI and anything it started (its own process group). */
function kill(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
