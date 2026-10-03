import { randomUUID } from "node:crypto";
import {
  HOST_POLL_TIMEOUT_MS,
  type HostInfo,
  type HostJob,
  HostJobSchema,
  type HostMethod,
  type HostProgress,
  type HostReply,
  HostResultSchemas,
  type HostStatus,
  type SecretsKeyBackup,
  type SshStatus,
} from "@majhi/shared";
import type { z } from "zod";

/** A helper that polled this recently still counts as connected between two polls. */
export const CONNECTED_WINDOW_MS = 35_000;
/** How long a command waits for the helper to answer a job. */
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

export type HostParams<M extends HostMethod> = Extract<HostJob, { method: M }>["params"];
export type HostResult<M extends HostMethod> = z.infer<(typeof HostResultSchemas)[M]>;

/**
 * One parser per method. Indexing this mapped type with a generic method keeps
 * the link between the method and its result type, which indexing
 * `HostResultSchemas` directly loses.
 */
const parseResult: { [M in HostMethod]: (value: unknown) => z.ZodSafeParseResult<HostResult<M>> } = {
  listDirs: (value) => HostResultSchemas.listDirs.safeParse(value),
  suggestRoots: (value) => HostResultSchemas.suggestRoots.safeParse(value),
  remount: (value) => HostResultSchemas.remount.safeParse(value),
  "ssh.reload": (value) => HostResultSchemas["ssh.reload"].safeParse(value),
  "ssh.unlock": (value) => HostResultSchemas["ssh.unlock"].safeParse(value),
  "secretsKey.save": (value) => HostResultSchemas["secretsKey.save"].safeParse(value),
  "secretsKey.restore": (value) => HostResultSchemas["secretsKey.restore"].safeParse(value),
  "editor.open": (value) => HostResultSchemas["editor.open"].safeParse(value),
  "e2e.run": (value) => HostResultSchemas["e2e.run"].safeParse(value),
  notify: (value) => HostResultSchemas.notify.safeParse(value),
  "git.logins": (value) => HostResultSchemas["git.logins"].safeParse(value),
  "git.token": (value) => HostResultSchemas["git.token"].safeParse(value),
  "git.push": (value) => HostResultSchemas["git.push"].safeParse(value),
  "git.credential": (value) => HostResultSchemas["git.credential"].safeParse(value),
  openUrl: (value) => HostResultSchemas.openUrl.safeParse(value),
  "git.clone": (value) => HostResultSchemas["git.clone"].safeParse(value),
  "git.lsRemote": (value) => HostResultSchemas["git.lsRemote"].safeParse(value),
  "git.cliLogin": (value) => HostResultSchemas["git.cliLogin"].safeParse(value),
  "git.cliLoginCancel": (value) => HostResultSchemas["git.cliLoginCancel"].safeParse(value),
  "version.changes": (value) => HostResultSchemas["version.changes"].safeParse(value),
  update: (value) => HostResultSchemas.update.safeParse(value),
  restart: (value) => HostResultSchemas.restart.safeParse(value),
  "decisions.status": (value) => HostResultSchemas["decisions.status"].safeParse(value),
  "decisions.install": (value) => HostResultSchemas["decisions.install"].safeParse(value),
  decide: (value) => HostResultSchemas.decide.safeParse(value),
};

/** The helper is not connected, or did not answer in time. */
export class HostOfflineError extends Error {
  constructor(message = "The host helper is not connected. Run `make up` in the majhi folder to start it.") {
    super(message);
    this.name = "HostOfflineError";
  }
}

/** The helper ran the job and reported a failure, like a folder that does not exist. */
export class HostJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostJobError";
  }
}

export interface HostLinkOptions {
  /** How long a poll waits for a job before it ends empty. */
  pollTimeoutMs?: number;
  connectedWindowMs?: number;
  now?: () => number;
}

interface Waiter {
  deliver(job: HostJob | undefined): void;
}

/**
 * The server's end of the host helper link. The helper cannot be called: it
 * polls for jobs and posts replies. `call` queues a job and waits for its
 * reply; `poll` hands the next job to the helper, waiting for one if needed.
 */
export class HostLink {
  private readonly queue: HostJob[] = [];
  private readonly pending = new Map<string, (reply: HostReply) => void>();
  /** Progress listeners of running calls that asked for it, by job id. */
  private readonly progressListeners = new Map<string, (progress: HostProgress) => void>();
  private waiter: Waiter | undefined;
  private lastPollEnd: number | undefined;
  private lastSeen: number | undefined;
  private info: HostInfo | undefined;
  private readonly wakeListeners = new Set<(at: string) => void>();
  private closed = false;
  private readonly pollTimeoutMs: number;
  private readonly connectedWindowMs: number;
  private readonly now: () => number;

  constructor(options: HostLinkOptions = {}) {
    this.pollTimeoutMs = options.pollTimeoutMs ?? HOST_POLL_TIMEOUT_MS;
    this.connectedWindowMs = options.connectedWindowMs ?? CONNECTED_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Connected while a poll waits, and for a short window after the last one ended. */
  isConnected(): boolean {
    if (this.waiter !== undefined) return true;
    return this.lastPollEnd !== undefined && this.now() - this.lastPollEnd < this.connectedWindowMs;
  }

  status(): HostStatus {
    const status: HostStatus = { connected: this.isConnected() };
    if (this.info !== undefined) status.info = this.info;
    if (this.lastSeen !== undefined) status.lastSeen = new Date(this.lastSeen).toISOString();
    return status;
  }

  /**
   * Takes the SSH status a job just returned, so `status()` is current before
   * the helper's next poll brings it too.
   */
  noteSsh(ssh: SshStatus): void {
    if (this.info !== undefined) this.info = { ...this.info, ssh };
  }

  /** Keeps a fresh Keychain or keyring status until the next poll brings the same. */
  noteSecretsKey(secretsKey: SecretsKeyBackup): void {
    if (this.info !== undefined) this.info = { ...this.info, secretsKey };
  }

  /** Called with the wake time each time the helper reports a new wake from sleep. Returns an unsubscribe. */
  onWake(listener: (at: string) => void): () => void {
    this.wakeListeners.add(listener);
    return () => this.wakeListeners.delete(listener);
  }

  /**
   * Sends a job to the helper and resolves with its checked result. `onProgress` gets the
   * `HostProgress` the helper posts for this job while it runs (`git.clone`, `git.cliLogin`).
   */
  call<M extends HostMethod>(
    method: M,
    params: HostParams<M>,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    onProgress?: (progress: HostProgress) => void,
  ): Promise<HostResult<M>> {
    if (!this.isConnected()) return Promise.reject(new HostOfflineError());
    const job = HostJobSchema.parse({ id: randomUUID(), method, params });
    const parse = parseResult[method];
    if (onProgress !== undefined) this.progressListeners.set(job.id, onProgress);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        this.progressListeners.delete(job.id);
        const queued = this.queue.findIndex((j) => j.id === job.id);
        if (queued !== -1) this.queue.splice(queued, 1);
        const seconds = Math.round(timeoutMs / 1000);
        reject(new HostOfflineError(`The host helper did not answer within ${seconds} seconds.`));
      }, timeoutMs);
      this.pending.set(job.id, (reply) => {
        clearTimeout(timer);
        this.pending.delete(job.id);
        this.progressListeners.delete(job.id);
        if (!reply.ok) {
          reject(new HostJobError(reply.error));
          return;
        }
        const parsed = parse(reply.result);
        if (parsed.success) resolve(parsed.data);
        else reject(new HostJobError(`The host helper sent an invalid ${method} result.`));
      });
      if (this.waiter !== undefined) this.waiter.deliver(job);
      else this.queue.push(job);
    });
  }

  /**
   * Called for each poll from the helper. Resolves with the next job, or with
   * undefined when none arrived in time, when a newer poll took over, when the
   * request went away, or when the link is closing.
   */
  poll(info: HostInfo, signal?: AbortSignal): Promise<HostJob | undefined> {
    const woke = info.wokeAt !== undefined && info.wokeAt !== this.info?.wokeAt;
    // The first poll of a helper that started before this server tells of an old wake, not a new one.
    const known = this.info !== undefined;
    this.info = info;
    if (woke && known && info.wokeAt !== undefined) {
      for (const listener of [...this.wakeListeners]) listener(info.wokeAt);
    }
    this.lastSeen = this.now();
    const next = this.queue.shift();
    if (next !== undefined || this.closed || signal?.aborted === true) {
      this.lastPollEnd = this.now();
      return Promise.resolve(next);
    }
    this.waiter?.deliver(undefined);

    return new Promise((resolve) => {
      let done = false;
      const finish = (job: HostJob | undefined): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter === waiter) this.waiter = undefined;
        this.lastPollEnd = this.now();
        this.lastSeen = this.lastPollEnd;
        resolve(job);
      };
      const onAbort = (): void => finish(undefined);
      const waiter: Waiter = { deliver: finish };
      const timer = setTimeout(() => finish(undefined), this.pollTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = waiter;
    });
  }

  /** Settles the call waiting for this reply. False when nothing waits for it, like after a timeout. */
  reply(reply: HostReply): boolean {
    const settle = this.pending.get(reply.id);
    if (settle === undefined) return false;
    settle(reply);
    return true;
  }

  /** Hands progress to the call waiting on that job. False when nothing listens, like after a timeout. */
  progress(progress: HostProgress): boolean {
    const listener = this.progressListeners.get(progress.id);
    if (listener === undefined) return false;
    listener(progress);
    return true;
  }

  /** Ends the waiting poll so the server can stop at once. Later polls end straight away. */
  close(): void {
    this.closed = true;
    this.waiter?.deliver(undefined);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
