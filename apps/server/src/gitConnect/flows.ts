import { randomBytes } from "node:crypto";
import type { CommandMeta, GitCli, MrHost, OAuthGrant, SignInStatus } from "@majhi/shared";

/** A sign-in never waits longer than this, whatever the host says. */
export const MAX_FLOW_MS = 15 * 60_000;
/** Ended flows stay readable this long, so the UI can show the outcome. */
export const KEEP_ENDED_MS = 10 * 60_000;

/** The token a flow got, held in memory only while the owner confirms a reused account. */
export interface HeldToken {
  token: string;
  grant?: OAuthGrant | undefined;
}

/**
 * How a flow signs in, with its secret parts. Never returned, logged or put in an event.
 * - `device`: majhi's own device flow with a client ID.
 * - `cli`: the host's CLI on the owner's computer (`gh`, `glab`), run by the host helper.
 * - `paste`: a token the owner pasted, checked with the host before it is saved.
 */
export type FlowSecret =
  | { kind: "device"; clientId: string; deviceCode: string; intervalMs: number }
  | { kind: "cli"; cli: GitCli }
  | { kind: "paste" };

export interface Flow {
  id: string;
  org: string;
  kind: MrHost;
  host: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The start call's actor and reason, for the config commit that saves the token. */
  meta: CommandMeta;
  secret: FlowSecret;
  status: SignInStatus;
  endedAt?: number;
  held?: HeldToken;
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function newSignInId(): string {
  const bytes = randomBytes(20);
  let id = "si_";
  for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Sign-in flows in memory, with their state machine. `pending` (and `confirm`) move to exactly one
 * end state and never back. Reading a flow past its deadline ends it as `expired`. Ended flows are
 * dropped 10 minutes after they end. A pure module: time comes from `now`, nothing does I/O.
 */
export class SignInFlows {
  private readonly flows = new Map<string, Flow>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onChange: (flow: Flow) => void = () => undefined,
  ) {}

  /**
   * A new pending flow. A pending or confirming flow for the same org and host is cancelled first,
   * so only one runs at a time.
   */
  start(input: {
    org: string;
    kind: MrHost;
    host: string;
    expiresInMs: number;
    meta: CommandMeta;
    secret: FlowSecret;
    shown: { userCode?: string; verificationUri?: string; authorizeUrl?: string };
  }): Flow {
    for (const flow of this.flows.values()) {
      if (flow.org === input.org && flow.host === input.host && this.isOpen(flow)) this.cancel(flow.id);
    }
    const id = newSignInId();
    const expiresAt = this.now() + Math.min(Math.max(input.expiresInMs, 1000), MAX_FLOW_MS);
    const flow: Flow = {
      id,
      org: input.org,
      kind: input.kind,
      host: input.host,
      expiresAt,
      meta: input.meta,
      secret: input.secret,
      status: {
        state: "pending",
        signIn: id,
        org: input.org,
        kind: input.kind,
        host: input.host,
        expiresAt: iso(expiresAt),
        ...(input.shown.userCode === undefined ? {} : { userCode: input.shown.userCode }),
        ...(input.shown.verificationUri === undefined
          ? {}
          : { verificationUri: input.shown.verificationUri }),
        ...(input.shown.authorizeUrl === undefined ? {} : { authorizeUrl: input.shown.authorizeUrl }),
      },
    };
    this.flows.set(id, flow);
    this.onChange(flow);
    return flow;
  }

  /** The flow, after ending it as `expired` when its time ran out. Undefined when unknown or dropped. */
  get(id: string): Flow | undefined {
    this.sweep();
    return this.flows.get(id);
  }

  /** Fills in the page and code of a pending flow once they are known (a CLI prints them a moment after it starts). */
  show(id: string, shown: { userCode?: string; verificationUri?: string; authorizeUrl?: string }): boolean {
    const flow = this.get(id);
    if (flow === undefined || flow.status.state !== "pending") return false;
    flow.status = {
      ...flow.status,
      ...(shown.userCode === undefined ? {} : { userCode: shown.userCode }),
      ...(shown.verificationUri === undefined ? {} : { verificationUri: shown.verificationUri }),
      ...(shown.authorizeUrl === undefined ? {} : { authorizeUrl: shown.authorizeUrl }),
    };
    this.onChange(flow);
    return true;
  }

  /** Every flow still pending or confirming. */
  open(): Flow[] {
    this.sweep();
    return [...this.flows.values()].filter((f) => this.isOpen(f));
  }

  /** Waits for the owner: holds the token in memory until `confirm`, `cancel` or the deadline. */
  toConfirm(
    id: string,
    details: { account: string; alsoUsedBy: string[]; replaced?: string | undefined },
    held: HeldToken,
  ): boolean {
    const flow = this.get(id);
    if (flow === undefined || flow.status.state !== "pending") return false;
    const [first, ...rest] = details.alsoUsedBy;
    if (first === undefined) return false;
    flow.held = held;
    flow.status = {
      state: "confirm",
      signIn: flow.id,
      org: flow.org,
      kind: flow.kind,
      host: flow.host,
      account: details.account,
      alsoUsedBy: [first, ...rest],
      ...(details.replaced === undefined ? {} : { replaced: details.replaced }),
      expiresAt: iso(flow.expiresAt),
    };
    this.onChange(flow);
    return true;
  }

  done(
    id: string,
    details: { account: string; alsoUsedBy: string[]; replaced?: string | undefined },
  ): boolean {
    return this.end(id, {
      state: "done",
      account: details.account,
      alsoUsedBy: details.alsoUsedBy,
      ...(details.replaced === undefined ? {} : { replaced: details.replaced }),
    });
  }

  denied(id: string): boolean {
    return this.end(id, { state: "denied" });
  }

  expired(id: string): boolean {
    return this.end(id, { state: "expired" });
  }

  cancel(id: string): boolean {
    return this.end(id, { state: "cancelled" });
  }

  /** `reason` is a plain sentence that never holds a token or a code. */
  failed(id: string, reason: string): boolean {
    return this.end(id, { state: "failed", reason });
  }

  private isOpen(flow: Flow): boolean {
    return flow.status.state === "pending" || flow.status.state === "confirm";
  }

  private end(
    id: string,
    outcome:
      | { state: "done"; account: string; alsoUsedBy: string[]; replaced?: string }
      | { state: "denied" | "expired" | "cancelled" }
      | { state: "failed"; reason: string },
  ): boolean {
    const flow = this.flows.get(id);
    if (flow === undefined || !this.isOpen(flow)) return false;
    // `done` comes from pending or confirm; the other ends too. Nothing leaves an end state.
    const base = { signIn: flow.id, org: flow.org, kind: flow.kind, host: flow.host };
    flow.status = { ...base, ...outcome } as SignInStatus;
    flow.endedAt = this.now();
    delete flow.held;
    this.onChange(flow);
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const flow of [...this.flows.values()]) {
      if (this.isOpen(flow) && now >= flow.expiresAt) this.end(flow.id, { state: "expired" });
      if (flow.endedAt !== undefined && now - flow.endedAt >= KEEP_ENDED_MS) this.flows.delete(flow.id);
    }
  }
}
