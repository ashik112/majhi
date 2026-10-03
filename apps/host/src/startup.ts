import type { Logger } from "./log.ts";
import type { DockerPlatform } from "./platform/types.ts";

/** How long the helper waits for Docker to come up after starting it. */
export const DOCKER_WAIT_MS = 120_000;
export const DOCKER_POLL_MS = 5_000;
/** A failed start is tried again this much later, never sooner. */
export const RETRY_DELAY_MS = 60_000;
export const MAX_ATTEMPTS = 3;

export type StartupOutcome = { ok: true; steps: string[] } | { ok: false; step: string; message: string };

/** Everything the start-at-login flow touches, so tests run it with fakes and never touch Docker. */
export interface StartupDeps {
  log: Logger;
  /** True when `docker info` succeeds. */
  dockerUp(): Promise<boolean>;
  /** Starts Docker where the helper can, and names the step the owner must take where it cannot. */
  docker: Pick<DockerPlatform, "start" | "help">;
  /** True when majhi's server container is running. */
  majhiRunning(): Promise<boolean>;
  /** `docker compose up -d --wait` in the checkout. Throws with the reason on failure. */
  startMajhi(): Promise<void>;
  /** A desktop notification with the one step the owner must take. */
  notify(message: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * One pass: make sure Docker is up, then that majhi is running. Logs each step and returns what
 * happened. It waits for Docker with a poll every few seconds, never in a tight loop.
 */
export async function ensureMajhiRunning(deps: StartupDeps): Promise<StartupOutcome> {
  const steps: string[] = [];
  const say = (text: string): void => {
    steps.push(text);
    deps.log(`startup: ${text}`);
  };

  if (!(await deps.dockerUp())) {
    say("Docker is not running");
    if (!(await deps.docker.start())) {
      return { ok: false, step: "open Docker", message: deps.docker.help("not-started") };
    }
    say("opened Docker, waiting for it");
    const deadline = deps.now() + DOCKER_WAIT_MS;
    let up = false;
    while (deps.now() < deadline) {
      await deps.sleep(DOCKER_POLL_MS);
      if (await deps.dockerUp()) {
        up = true;
        break;
      }
    }
    if (!up) return { ok: false, step: "wait for Docker", message: deps.docker.help("slow") };
    say("Docker is up");
  } else {
    say("Docker is up");
  }

  if (await deps.majhiRunning()) {
    say("majhi is already running");
    return { ok: true, steps };
  }
  say("majhi is not running, starting it");
  try {
    await deps.startMajhi();
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n", 1)[0] : "unknown error";
    deps.log(`startup: could not start majhi: ${reason}`);
    return {
      ok: false,
      step: "start majhi",
      message: "majhi could not start. Open a terminal in the majhi folder and run make up.",
    };
  }
  say("majhi is running");
  return { ok: true, steps };
}

/**
 * Runs `ensureMajhiRunning` up to three times, a minute apart, and posts a notification only when
 * the last attempt still fails, so the owner hears about it once.
 */
export async function startAtLogin(deps: StartupDeps): Promise<StartupOutcome> {
  let outcome = await ensureMajhiRunning(deps);
  for (let attempt = 1; !outcome.ok && attempt < MAX_ATTEMPTS; attempt += 1) {
    deps.log(`startup: ${outcome.step} failed, trying again in ${RETRY_DELAY_MS / 1000}s`);
    await deps.sleep(RETRY_DELAY_MS);
    outcome = await ensureMajhiRunning(deps);
  }
  if (!outcome.ok) {
    deps.log(`startup: giving up at "${outcome.step}"`);
    await deps.notify(outcome.message).catch(() => undefined);
  }
  return outcome;
}
