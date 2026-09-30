import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type DecideRequest, LayaAnswerSchema, type LayaStatus } from "@majhi/shared";
import { z } from "zod";
import { errorMessage } from "../errors.ts";
import { fromLayaCall, toLayaCall } from "./layaMap.ts";
import type { ProviderOutcome } from "./providers.ts";

const run = promisify(execFile);

/** Runs the docker CLI with these arguments and resolves with its stdout. */
export type DockerCli = (args: readonly string[]) => Promise<string>;

export function dockerCli(env: NodeJS.ProcessEnv): DockerCli {
  return async (args) => (await run("docker", [...args], { env, timeout: 30_000 })).stdout;
}

/** The first question after a start downloads the English checkpoint (about 850 MB) and loads it. */
const DECIDE_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 3_000;
/** How long a started container gets to answer /health. */
const START_WAIT_MS = 60_000;
const POLL_MS = 1_000;
/** Stop the container after this long without a question (SPEC 5.17). */
export const LAYA_IDLE_MS = 10 * 60_000;

const HealthSchema = z.looseObject({ status: z.string(), loaded: z.array(z.string()).nullish() });
const ResultSchema = z.looseObject({ answers: z.record(z.string(), LayaAnswerSchema) });

export interface LayaDockerOptions {
  /** laya-serve's base URL on the compose network. */
  url: string;
  /** The container majhi starts and stops. Without it majhi only calls the URL. */
  container?: string | undefined;
  docker: DockerCli;
  fetch?: typeof fetch;
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Laya on PyTorch CPU in the `laya` compose service (SPEC 5.12), through laya-serve's
 * Jev-compatible `POST /v1/systemone`. The container is started on the first question and
 * stopped after 10 idle minutes; the model inside loads on first use too.
 */
export class LayaDocker {
  private readonly fetch: typeof fetch;
  private idleTimer: NodeJS.Timeout | undefined;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: LayaDockerOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async status(): Promise<LayaStatus> {
    const health = await this.health();
    if (health !== undefined) {
      return {
        state: (health.loaded ?? []).length > 0 ? "loaded" : "ready",
        detail: "Laya runs in Docker (PyTorch on CPU).",
      };
    }
    const container = await this.containerState();
    if (container === "missing") {
      return {
        state: "not-installed",
        detail: "Laya's Docker image is not built. Run make up, which builds it on this machine.",
      };
    }
    if (container === "unknown")
      return { state: "error", detail: "majhi cannot reach Docker to start Laya." };
    return {
      state: "ready",
      detail: "Laya runs in Docker (PyTorch on CPU). It starts on the first question.",
    };
  }

  /** A reason Laya in Docker cannot answer now, or undefined. */
  async unavailable(): Promise<string | undefined> {
    if ((await this.health()) !== undefined) return undefined;
    const container = await this.containerState();
    if (container === "missing") return "Laya's Docker image is not built";
    if (container === "unknown") return "majhi cannot reach Laya in Docker";
    return undefined;
  }

  async decide(request: DecideRequest): Promise<ProviderOutcome> {
    await this.ensureRunning();
    this.touch();
    const call = toLayaCall(request);
    const res = await this.fetch(`${this.options.url}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: call.text, questions: call.questions, model: "english" }),
      signal: AbortSignal.timeout(DECIDE_TIMEOUT_MS),
    });
    this.touch();
    if (!res.ok)
      throw new Error(`Laya in Docker answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const parsed = ResultSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("Laya in Docker gave an answer majhi cannot read.");
    return { answers: fromLayaCall(request, parsed.data.answers), estimated: false, trimmed: call.trimmed };
  }

  /** Stops the idle timer. The container is left as it is. */
  close(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async health(): Promise<z.infer<typeof HealthSchema> | undefined> {
    try {
      const res = await this.fetch(`${this.options.url}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      const parsed = HealthSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async containerState(): Promise<"running" | "stopped" | "missing" | "unknown"> {
    const name = this.options.container;
    if (name === undefined) return "unknown";
    try {
      const out = (await this.options.docker(["inspect", "--format", "{{.State.Running}}", name])).trim();
      return out === "true" ? "running" : "stopped";
    } catch (err) {
      return /no such (object|container)/i.test(errorMessage(err)) ? "missing" : "unknown";
    }
  }

  /** Starts the container when /health does not answer, and waits for it. One start at a time. */
  private async ensureRunning(): Promise<void> {
    if ((await this.health()) !== undefined) return;
    const name = this.options.container;
    if (name === undefined) throw new Error("Laya in Docker does not answer.");
    this.starting ??= (async () => {
      try {
        await this.options.docker(["start", name]);
        const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
          if ((await this.health()) !== undefined) return;
          await sleep(POLL_MS);
        }
        throw new Error("Laya in Docker did not start within a minute.");
      } finally {
        this.starting = undefined;
      }
    })();
    await this.starting;
  }

  /** Every question pushes the idle stop back. */
  private touch(): void {
    const name = this.options.container;
    if (name === undefined) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.options.docker(["stop", name]).catch(() => undefined);
    }, this.options.idleMs ?? LAYA_IDLE_MS);
    this.idleTimer.unref();
  }
}
