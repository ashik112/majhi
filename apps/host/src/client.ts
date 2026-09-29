import {
  HOST_INFO_HEADER,
  HOST_POLL_TIMEOUT_MS,
  HOST_TOKEN_FILE,
  type HostInfo,
  type HostJob,
  HostJobSchema,
  type HostReply,
} from "@majhi/shared";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";

export const BACKOFF_START_MS = 250;
export const BACKOFF_MAX_MS = 5_000;
/** A poll the server never answers is dropped after this, then retried. */
const POLL_REQUEST_TIMEOUT_MS = HOST_POLL_TIMEOUT_MS + 10_000;
const REPLY_TIMEOUT_MS = 10_000;

/** Waits 250 ms after the first failure, doubling up to 5 s. `reset` after a success. */
export class Backoff {
  private delay = BACKOFF_START_MS;

  next(): number {
    const current = this.delay;
    this.delay = Math.min(this.delay * 2, BACKOFF_MAX_MS);
    return current;
  }

  reset(): void {
    this.delay = BACKOFF_START_MS;
  }
}

export interface LinkOptions {
  /** majhi's server, like `http://127.0.0.1:7070`. */
  url: string;
  /** Read before each request, so a replaced token file is picked up. */
  token: () => Promise<string>;
  info: HostInfo;
  log: Logger;
  fetch?: typeof fetch;
}

export interface PollLoopOptions extends LinkOptions {
  /** Called for every job without waiting, so a slow job never holds up the next poll. */
  onJob: (job: HostJob) => void;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Polls the server for jobs until `signal` aborts. Backs off while the server
 * is down or refuses the token, and logs only when the state changes, so a
 * stopped majhi does not fill the log.
 */
export async function pollLoop(options: PollLoopOptions): Promise<void> {
  const { url, info, log, signal, onJob } = options;
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const backoff = new Backoff();
  let state = "";
  const report = (next: string): void => {
    if (next !== state) log(next);
    state = next;
  };

  while (!signal.aborted) {
    let res: Response;
    try {
      res = await fetchFn(`${url}/api/host/poll`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await options.token()}`,
          [HOST_INFO_HEADER]: JSON.stringify(info),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (signal.aborted) return;
      report(`cannot reach majhi at ${url} (${describeFetchError(err)}), retrying`);
      await sleep(backoff.next(), signal);
      continue;
    }

    if (res.status === 204 || res.status === 200) {
      report(`connected to majhi at ${url}`);
      backoff.reset();
      if (res.status === 200) handleJobBody(await res.json().catch(() => undefined), options, onJob);
      continue;
    }

    await res.body?.cancel();
    report(
      res.status === 401
        ? `majhi at ${url} refused the token in ${HOST_TOKEN_FILE}; check that MAJHI_HOME matches the server's`
        : `majhi at ${url} answered ${res.status}, retrying`,
    );
    await sleep(backoff.next(), signal);
  }
}

/** Posts the reply to a job. Throws when the server did not take it. */
export async function sendReply(options: LinkOptions, reply: HostReply): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  try {
    const res = await fetchFn(`${options.url}/api/host/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${await options.token()}`, "content-type": "application/json" },
      body: JSON.stringify(reply),
      signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (res.status !== 204) throw new Error(`majhi answered ${res.status}`);
  } catch (err) {
    options.log(`reply to job ${reply.id} failed: ${describeFetchError(err)}`);
    throw err;
  }
}

/** A job that does not parse is answered with the reason, when it has an id to answer to. */
function handleJobBody(body: unknown, options: LinkOptions, onJob: (job: HostJob) => void): void {
  const job = HostJobSchema.safeParse(body);
  if (job.success) {
    onJob(job.data);
    return;
  }
  const id =
    typeof body === "object" && body !== null && "id" in body && typeof body.id === "string"
      ? body.id
      : undefined;
  const method =
    typeof body === "object" && body !== null && "method" in body ? String(body.method) : "unknown";
  options.log(`ignored a job this helper does not understand (method ${method})`);
  if (id === undefined) return;
  const error = `This host helper cannot run "${method}". Run \`make up\` to update it.`;
  sendReply(options, { id, ok: false, error }).catch(() => undefined);
}

function describeFetchError(err: unknown): string {
  // Node's fetch hides the reason, like ECONNREFUSED, in `cause`.
  if (err instanceof Error && err.cause instanceof Error) return err.cause.message;
  return errorMessage(err);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
