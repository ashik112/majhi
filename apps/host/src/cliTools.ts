/**
 * Signs a workspace in to a command-line tool (vercel, stripe, aws, gcloud, az) with
 * the tool's own login (SPEC 5.14, "Command-line tools").
 *
 * Isolation, so the owner's own login and another workspace's are never read or changed:
 * - The sign-in lives in `<MAJHI_HOME>/connections/<connection>/profile` (mode 700). One folder per
 *   connection, so two workspaces can be signed in to different accounts.
 * - The tool runs with an environment built here: PATH, the profile's HOME and XDG folders, the
 *   tool's own variables, and a BROWSER that only prints the page. Nothing of the helper's
 *   `AWS_*`, `GOOGLE_*`, `CLOUDFLARE_*`, `STRIPE_*` or `GH_TOKEN`.
 * - The login runs in the profile after the old one was moved aside. It is kept only when the
 *   tool's own check command works (and names the expected account on a reconnect). Failure, cancel
 *   and timeout remove the new folder and put the old one back.
 *
 * The tool's output is only searched for the page, the code and who is signed in. It is never
 * logged, put in an error or sent anywhere.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_PROFILE_DIR,
  CLI_TOOLS,
  type CliCheckResult,
  type CliLoginResult,
  type CliToolDef,
  type CliToolId,
  cliLoginEnv,
  cliProfileFolders,
  type HostLoginProgress,
  IdSchema,
} from "@majhi/shared";

/** A sign-in never runs longer than this. */
export const CLI_TOOL_TIMEOUT_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;
const URL_MARKER = "MAJHI_LOGIN_URL";

export interface CliToolsDeps {
  majhiHome: string;
  /** The PATH the tool is found on and runs with. */
  path: string;
  find: (binary: string) => Promise<string | undefined>;
  /** Only TMPDIR, LANG and LC_ALL are passed on from here. */
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  checkTimeoutMs?: number;
  /** Tests give their own tools. */
  tools?: Readonly<Record<string, CliToolDef>>;
}

/** The connection's folder, and its profile inside it. `connection` is an id, so it never leaves the folder. */
export function connectionFolder(majhiHome: string, connection: string): string {
  return join(majhiHome, "connections", IdSchema.parse(connection));
}
export const profileFolder = (majhiHome: string, connection: string): string =>
  join(connectionFolder(majhiHome, connection), CLI_PROFILE_DIR);

/** The page and code a tool printed. Either may be missing until it prints it. */
export function parseToolOutput(text: string): { url?: string; code?: string } {
  const out: { url?: string; code?: string } = {};
  const code =
    /(?:code|pairing)[^A-Z0-9\n]{0,40}\(?\b([A-Z0-9]{4}-[A-Z0-9]{4})\b\)?/i.exec(text) ??
    /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text);
  if (code?.[1] !== undefined) out.code = code[1].toUpperCase();
  const marked = new RegExp(`${URL_MARKER} (https?://\\S+)`).exec(text);
  const shown = /(https?:\/\/[^\s"'<>]+)/.exec(text);
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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Who a check command says is signed in: an email, else a short plain first line. Never a long token-like string. */
export function parseIdentity(text: string): string | undefined {
  const email = EMAIL.exec(text)?.[0];
  if (email !== undefined) return email;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.length > 80) continue;
    if (/[A-Za-z0-9_\-/+=]{24,}/.test(line)) continue;
    if (/(token|secret|password|key)\s*[:=]/i.test(line)) continue;
    return line;
  }
  return undefined;
}

interface Captured {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

interface Running {
  child: ChildProcess;
  cancelled: boolean;
  key: string;
}

export class CliToolLogins {
  private readonly running = new Map<string, Running>();

  constructor(private readonly deps: CliToolsDeps) {}

  private tool(id: CliToolId): CliToolDef {
    const def = this.deps.tools?.[id] ?? CLI_TOOLS[id];
    return def;
  }

  /** The environment of every command here: nothing of the helper's, only what the profile needs. */
  private env(def: CliToolDef, profile: string, extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {
      PATH: this.deps.path,
      NO_COLOR: "1",
      CI: "",
      ...cliLoginEnv(def, profile),
      ...extra,
    };
    for (const name of ["TMPDIR", "LANG", "LC_ALL"]) {
      const value = this.deps.env?.[name];
      if (value !== undefined && value !== "") env[name] = value;
    }
    return env;
  }

  /** Stops the sign-in's tool. False when none runs. */
  cancel(signIn: string): boolean {
    const run = this.running.get(signIn);
    if (run === undefined) return false;
    run.cancelled = true;
    kill(run.child);
    return true;
  }

  async login(
    params: { signIn: string; tool: CliToolId; connection: string; expected?: string | undefined },
    progress: (progress: Omit<HostLoginProgress, "id">) => void,
  ): Promise<CliLoginResult> {
    const def = this.tool(params.tool);
    const file = await this.deps.find(def.binary);
    if (file === undefined) return { state: "missing" };
    const key = params.connection;
    for (const [id, run] of this.running) if (run.key === key) this.cancel(id);

    const folder = connectionFolder(this.deps.majhiHome, params.connection);
    const profile = profileFolder(this.deps.majhiHome, params.connection);
    for (const dir of [join(this.deps.majhiHome, "connections"), folder]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }
    // The old sign-in waits aside until the new one is proven.
    const aside = `${profile}-old-${process.pid}-${Date.now()}`;
    let hadOld = true;
    await rename(profile, aside).catch(() => {
      hadOld = false;
    });
    let keep = false;
    try {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await chmod(profile, 0o700);
      for (const dir of cliProfileFolders(profile)) await mkdir(dir, { recursive: true, mode: 0o700 });
      const browser = join(profile, "open-url");
      await writeFile(browser, `#!/bin/sh\nprintf '${URL_MARKER} %s\\n' "$1" >&2\n`, { mode: 0o700 });
      const ended = await this.runLogin(file, def, params, profile, browser, progress);
      if (ended === "cancelled") return { state: "cancelled" };
      await rm(browser, { force: true });
      const checked = await this.runCheck(file, def, profile);
      if (!checked.ok)
        throw new Error(`${def.name} finished, but it does not show a sign-in. Nothing was saved.`);
      if (
        params.expected !== undefined &&
        checked.identity !== undefined &&
        checked.identity.toLowerCase() !== params.expected.toLowerCase()
      ) {
        return { state: "other-account", identity: checked.identity };
      }
      keep = true;
      return { state: "done", ...(checked.identity === undefined ? {} : { identity: checked.identity }) };
    } finally {
      if (keep) {
        await rm(aside, { recursive: true, force: true }).catch(() => undefined);
      } else {
        await rm(profile, { recursive: true, force: true }).catch(() => undefined);
        if (hadOld) await rename(aside, profile).catch(() => undefined);
      }
    }
  }

  private runLogin(
    file: string,
    def: CliToolDef,
    params: { signIn: string; connection: string },
    profile: string,
    browser: string,
    progress: (progress: Omit<HostLoginProgress, "id">) => void,
  ): Promise<"done" | "cancelled"> {
    return new Promise((resolve, reject) => {
      const child = spawn(file, [...def.login], {
        env: this.env(def, profile, { BROWSER: browser }),
        cwd: join(profile, "home"),
        stdio: [def.enter ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true,
      });
      const run: Running = { child, cancelled: false, key: params.connection };
      this.running.set(params.signIn, run);
      let output = "";
      let told: { url?: string | undefined; code?: string | undefined } = {};
      let pressed = false;
      let timedOut = false;
      let ended = false;
      const timer = setTimeout(() => {
        timedOut = true;
        kill(child);
      }, this.deps.timeoutMs ?? CLI_TOOL_TIMEOUT_MS);
      const take = (chunk: Buffer): void => {
        if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
        const found = parseToolOutput(output);
        if (found.url !== undefined && !pressed && def.enter) {
          pressed = true;
          child.stdin?.write("\n");
        }
        if (found.url === undefined || (found.url === told.url && found.code === told.code)) return;
        told = found;
        progress({ login: { url: found.url, ...(found.code === undefined ? {} : { code: found.code }) } });
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      child.stdin?.on("error", () => undefined);
      const end = (code: number | null): void => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (this.running.get(params.signIn) === run) this.running.delete(params.signIn);
        if (run.cancelled) {
          resolve("cancelled");
          return;
        }
        if (timedOut) {
          reject(new Error(`The ${def.name} sign-in ran out of time. Nothing was saved.`));
          return;
        }
        if (code !== 0) {
          reject(failure(def, output));
          return;
        }
        resolve("done");
      };
      child.on("error", () => end(null));
      child.on("close", (code) => end(code));
    });
  }

  private async runCheck(file: string, def: CliToolDef, profile: string): Promise<CliCheckResult> {
    const env = this.env(def, profile);
    const home = join(profile, "home");
    const timeoutMs = this.deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    const out = await capture(file, [...def.check], env, home, timeoutMs);
    // The exit code decides, never the words the tool printed.
    if (out.timedOut) return { ok: false, detail: `${def.name} did not answer in time.`, failure: "timeout" };
    if (out.code === null || out.code === 127) {
      return { ok: false, detail: `${def.binary} did not run.`, failure: "tool-missing" };
    }
    if (out.code !== 0) {
      return { ok: false, detail: `${def.name} is not signed in.`, failure: "not-signed-in" };
    }
    let identity: string | undefined;
    if (def.whoami !== undefined) {
      const who = await capture(file, [...def.whoami], env, home, timeoutMs);
      if (who.code === 0) identity = parseIdentity(who.stdout);
    } else if (def.identityFromCheck === true) {
      identity = parseIdentity(out.stdout);
    }
    return { ok: true, ...(identity === undefined ? {} : { identity }), detail: "Signed in." };
  }

  /** Runs the tool's check in the connection's profile. */
  async check(params: { tool: CliToolId; connection: string }): Promise<CliCheckResult> {
    const def = this.tool(params.tool);
    const file = await this.deps.find(def.binary);
    if (file === undefined) return { ok: false, detail: `${def.binary} is not installed on this computer.` };
    return this.runCheck(file, def, profileFolder(this.deps.majhiHome, params.connection));
  }

  /** Signs out at the service where the tool can, then removes the profile whatever happened. */
  async logout(params: { tool: CliToolId; connection: string }): Promise<{ revoked: boolean }> {
    const def = this.tool(params.tool);
    const profile = profileFolder(this.deps.majhiHome, params.connection);
    let revoked = false;
    const file = await this.deps.find(def.binary);
    if (file !== undefined) {
      const out = await capture(
        file,
        [...def.logout],
        this.env(def, profile),
        join(profile, "home"),
        this.deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
      ).catch(() => undefined);
      revoked = out?.code === 0;
    }
    await rm(profile, { recursive: true, force: true });
    return { revoked };
  }
}

/** A safe sentence for a tool that ended without signing in. Never the tool's own words. */
function failure(def: CliToolDef, output: string): Error {
  if (/access[_ ]denied|denied|refused|rejected/i.test(output)) {
    return new Error(`The sign-in was refused on ${def.name}. Nothing was saved.`);
  }
  if (/expired|timed? ?out/i.test(output)) {
    return new Error(`The ${def.name} sign-in ran out of time. Nothing was saved. Start it again.`);
  }
  return new Error(`${def.name} did not finish the sign-in. Nothing was saved. Start it again.`);
}

function capture(
  file: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, cwd, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += c.toString("utf8");
    });
    let done = false;
    const end = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    };
    child.on("error", () => end(null));
    child.on("close", (code) => end(code));
  });
}

/** Ends the tool and anything it started (its own process group). */
function kill(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
