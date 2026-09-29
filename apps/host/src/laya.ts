import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type LayaDecideResult,
  LayaDecideResultSchema,
  type LayaQuestion,
  type LayaStatus,
} from "@majhi/shared";
import { z } from "zod";
import { errorMessage } from "./errors.ts";
import { LAYAD_SOURCE } from "./layadSource.ts";
import type { Logger } from "./log.ts";
import type { RunFn } from "./ssh.ts";

/** The laya-mlx release majhi installs, and the checkpoint it loads. */
export const LAYA_VERSION = "0.2.0";
export const LAYA_MODEL = "aac6fef/laya-mlx";
const MIN_PYTHON: [number, number] = [3, 11];
/** macOS 14 is Darwin 23. */
const MIN_DARWIN = 23;
/** The model unloads itself after this long without a question. */
export const LAYA_IDLE_SECONDS = 600;
const SERVICE_START_MS = 20_000;
/** The first question loads the model, which takes a few seconds. */
const PREDICT_MS = 25_000;
const VENV_MS = 120_000;
const PIP_MS = 900_000;
const PROBE_MS = 10_000;

/** A child process whose output is read line by line. */
export interface Proc {
  onLine(listener: (stream: "out" | "err", line: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}
export type SpawnProc = (file: string, args: readonly string[], env: Record<string, string>) => Proc;

/** Starts a real child in its own process group, so killing it takes its children too. */
export const spawnProc: SpawnProc = (file, args, env) => {
  const child = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const lineListeners: Array<(stream: "out" | "err", line: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  for (const [stream, name] of [
    [child.stdout, "out"],
    [child.stderr, "err"],
  ] as const) {
    let rest = "";
    stream.on("data", (chunk: Buffer) => {
      const parts = (rest + chunk.toString("utf8")).split(/\r|\n/);
      rest = parts.pop() ?? "";
      for (const line of parts) if (line !== "") for (const l of lineListeners) l(name, line);
    });
  }
  let exited = false;
  const done = (code: number | null): void => {
    if (exited) return;
    exited = true;
    for (const l of exitListeners) l(code);
  };
  child.on("error", () => done(null));
  child.on("close", (code) => done(code));
  return {
    onLine: (l) => void lineListeners.push(l),
    onExit: (l) => void exitListeners.push(l),
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    },
  };
};

const InstalledSchema = z.object({ version: z.string(), model: z.string(), installedAt: z.string() });

export interface LayaOptions {
  /** `~/.majhi`. Everything of Laya lives in `<majhiHome>/laya`. */
  majhiHome: string;
  /** The owner's home, for finding Python. */
  home: string;
  /** The helper's PATH, already extended with the usual tool folders. */
  path: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** `os.release()`. */
  osRelease?: string;
  run: RunFn;
  spawnProc?: SpawnProc;
  fetch?: typeof fetch;
  log: Logger;
  now?: () => number;
}

export interface Laya {
  status(): LayaStatus;
  /** Starts the install if there is none running, and returns the state at once. */
  install(): LayaStatus;
  decide(params: { state: string; questions: Record<string, LayaQuestion> }): Promise<LayaDecideResult>;
  /** Waits for a running install, for tests. */
  settled(): Promise<void>;
  stop(): void;
}

interface Service {
  proc: Proc;
  port: number;
  token: string;
}

/**
 * Laya on this Mac: a private venv with `laya-mlx`, its model, and a small Python service the
 * helper starts on the first question. The server never talks to it; it sends `decide` jobs.
 */
export function createLaya(options: LayaOptions): Laya {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const darwin = Number.parseInt((options.osRelease ?? "0").split(".")[0] ?? "0", 10);
  const spawnFn = options.spawnProc ?? spawnProc;
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const dir = join(options.majhiHome, "laya");
  const venvPython = join(dir, "venv", "bin", "python");
  const script = join(dir, "layad.py");
  const installedFile = join(dir, "installed.json");

  const unsupported = ((): string | undefined => {
    if (platform !== "darwin" || arch !== "arm64") return "Laya needs a Mac with Apple silicon.";
    if (darwin < MIN_DARWIN) return "Laya needs macOS 14 or newer.";
    return undefined;
  })();

  let status: LayaStatus = unsupported
    ? { state: "unsupported", detail: unsupported }
    : { state: "not-installed" };
  let installing: Promise<void> | undefined;
  let service: Service | undefined;
  let starting: Promise<Service> | undefined;
  let lastUsed = 0;
  /** True after an install found no Python: the owner may install one and try again. */
  let noPython = false;

  const set = (next: LayaStatus): void => {
    status = next;
  };
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    // Only what Python needs. Nothing from majhi's own environment.
    PATH: options.path,
    HOME: options.home,
    LANG: "en_US.UTF-8",
    HF_HOME: join(dir, "hf"),
    HF_HUB_DISABLE_TELEMETRY: "1",
    ...extra,
  });

  // Look for an earlier install once, without waiting.
  const checked = unsupported
    ? Promise.resolve()
    : readFile(installedFile, "utf8").then(
        (text) => {
          const parsed = InstalledSchema.safeParse(safeJson(text));
          if (parsed.success && status.state === "not-installed") {
            set({ state: "ready", version: parsed.data.version });
          }
        },
        () => undefined,
      );

  async function findPython(): Promise<string | undefined> {
    const names = ["python3.14", "python3.13", "python3.12", "python3.11", "python3"];
    const dirs = [
      ...options.path.split(":"),
      join(options.home, ".pyenv", "shims"),
      join(options.home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
    ].filter((d) => d !== "");
    const seen = new Set<string>();
    for (const name of names) {
      for (const d of dirs) {
        const file = join(d, name);
        if (seen.has(file)) continue;
        seen.add(file);
        const result = await options.run(file, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
          env: env(),
          timeoutMs: PROBE_MS,
        });
        const match = /^(\d+)\.(\d+)/.exec(result.stdout.trim());
        if (result.code !== 0 || match === null) continue;
        const version: [number, number] = [Number(match[1]), Number(match[2])];
        if (version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1])) {
          return file;
        }
      }
    }
    return undefined;
  }

  async function writeScript(): Promise<void> {
    const current = await readFile(script, "utf8").catch(() => undefined);
    if (current === LAYAD_SOURCE) return;
    await mkdir(dir, { recursive: true });
    await writeFile(script, LAYAD_SOURCE, { mode: 0o600 });
  }

  async function runInstall(): Promise<void> {
    try {
      set({ state: "installing", detail: "Looking for Python" });
      const python = await findPython();
      if (python === undefined) {
        noPython = true;
        set({
          state: "unsupported",
          detail: "Laya needs Python 3.11 or newer, and none was found on this Mac.",
        });
        return;
      }
      await mkdir(dir, { recursive: true });
      set({ state: "installing", detail: "Creating a private Python environment" });
      const venv = await options.run(python, ["-m", "venv", join(dir, "venv")], {
        env: env(),
        timeoutMs: VENV_MS,
      });
      if (venv.code !== 0) throw new Error("Could not create the Python environment.");
      set({ state: "installing", detail: `Installing laya-mlx ${LAYA_VERSION}` });
      const pip = await options.run(
        venvPython,
        ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", `laya-mlx==${LAYA_VERSION}`],
        { env: env(), timeoutMs: PIP_MS },
      );
      if (pip.code !== 0) throw new Error(`pip could not install laya-mlx: ${lastLine(pip.stderr)}`);
      await writeScript();
      await download();
      await writeFile(
        installedFile,
        JSON.stringify({ version: LAYA_VERSION, model: LAYA_MODEL, installedAt: new Date().toISOString() }),
      );
      set({ state: "ready", version: LAYA_VERSION });
      options.log(`laya: installed ${LAYA_VERSION}`);
    } catch (err) {
      options.log(`laya: install failed: ${errorMessage(err)}`);
      set({ state: "error", detail: errorMessage(err) });
    }
  }

  function download(): Promise<void> {
    set({ state: "downloading", detail: "Downloading the model, about 850 MB", progress: 0 });
    return new Promise((resolve, reject) => {
      const proc = spawnFn(venvPython, [script, "download"], env({ MAJHI_LAYA_MODEL: LAYA_MODEL }));
      let finished = false;
      let tail = "";
      proc.onLine((stream, line) => {
        if (stream === "err") {
          tail = line.slice(-200);
          return;
        }
        const parsed = ProgressLine.safeParse(safeJson(line));
        if (!parsed.success) return;
        if (parsed.data.done === true) finished = true;
        else if (parsed.data.progress !== undefined) {
          set({
            state: "downloading",
            detail: "Downloading the model, about 850 MB",
            progress: Math.min(1, parsed.data.progress),
          });
        }
      });
      proc.onExit((code) => {
        if (code === 0 && finished) resolve();
        else reject(new Error(`The model download failed${tail === "" ? "." : `: ${tail}`}`));
      });
    });
  }

  function startService(): Promise<Service> {
    if (service !== undefined) return Promise.resolve(service);
    if (starting !== undefined) return starting;
    starting = new Promise<Service>((resolve, reject) => {
      const token = randomBytes(24).toString("hex");
      const proc = spawnFn(
        venvPython,
        [script, "serve"],
        env({
          MAJHI_LAYA_TOKEN: token,
          MAJHI_LAYA_MODEL: LAYA_MODEL,
          MAJHI_LAYA_IDLE_SECONDS: String(LAYA_IDLE_SECONDS),
        }),
      );
      let ready = false;
      let tail = "";
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("The Laya service did not start in time."));
      }, SERVICE_START_MS);
      proc.onLine((stream, line) => {
        if (stream === "err") {
          tail = line.slice(-200);
          return;
        }
        const parsed = ReadyLine.safeParse(safeJson(line));
        if (!parsed.success || ready) return;
        ready = true;
        clearTimeout(timer);
        service = { proc, port: parsed.data.port, token };
        resolve(service);
      });
      proc.onExit((code) => {
        clearTimeout(timer);
        if (service?.proc === proc) service = undefined;
        if (!ready)
          reject(new Error(`The Laya service stopped (${code ?? "no code"})${tail ? `: ${tail}` : ""}`));
        else if (status.state === "loaded") set({ state: "ready", version: status.version ?? LAYA_VERSION });
      });
    }).finally(() => {
      starting = undefined;
    });
    return starting;
  }

  return {
    status() {
      // The service unloads the model on its own after the idle time.
      if (status.state === "loaded" && now() - lastUsed > LAYA_IDLE_SECONDS * 1000 + 10_000) {
        set({ state: "ready", version: status.version ?? LAYA_VERSION });
      }
      return status;
    },
    install() {
      if (installing === undefined && (["not-installed", "error"].includes(status.state) || noPython)) {
        noPython = false;
        installing = runInstall().finally(() => {
          installing = undefined;
        });
      }
      return status;
    },
    async decide(params) {
      await checked;
      if (status.state !== "ready" && status.state !== "loaded") {
        throw new Error(status.detail ?? "Laya is not installed yet.");
      }
      await writeScript();
      const svc = await startService();
      const response = await fetchFn(`http://127.0.0.1:${svc.port}/predict`, {
        method: "POST",
        headers: { authorization: `Bearer ${svc.token}`, "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(PREDICT_MS),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = z.object({ error: z.string() }).safeParse(body);
        throw new Error(message.success ? message.data.error : `Laya answered ${response.status}.`);
      }
      const parsed = LayaDecideResultSchema.safeParse(body);
      if (!parsed.success) throw new Error("Laya sent an answer majhi could not read.");
      lastUsed = now();
      set({ state: "loaded", version: status.version ?? LAYA_VERSION });
      return parsed.data;
    },
    async settled() {
      await checked;
      await installing;
    },
    stop() {
      service?.proc.kill();
      service = undefined;
    },
  };
}

const ProgressLine = z.object({ progress: z.number().optional(), done: z.boolean().optional() });
const ReadyLine = z.object({ ready: z.literal(true), port: z.number().int().positive() });

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines.at(-1) ?? "").slice(0, 200) || "no details";
}
