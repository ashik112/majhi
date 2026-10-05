import { z } from "zod";

/**
 * One state per connection (SPEC 5.14). "Connected" means a real call to the service, made with
 * the stored credential, passed. There is no separate "tested" state, and nothing is shown as
 * connected without a passing check.
 *
 * ```
 *            start                passed
 *  (none) ──────────▶ connecting ─────────▶ connected ◀──┐
 *                          │ failed            │ failed    │ passed
 *                          ▼                   ▼           │
 *                       failed            needs-attention ─┘
 * ```
 *
 * `failed` is for a connection that never passed. `needs-attention` is for one that did, and whose
 * re-check now fails. A check is decided by the call's result: an HTTP status, an MCP error code or
 * a command's exit code. Never by the text of a message.
 */

export const ConnectionStateSchema = z.enum(["connecting", "connected", "failed", "needs-attention"]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

/**
 * Why a check failed, as a type the page and the captain can act on.
 * - `rejected`: the service answered 401, or an MCP server said it needs a sign-in.
 * - `forbidden`: 403, the credential works but may not do this.
 * - `insufficient-scope`: 403 that names a missing scope.
 * - `not-found`: 404, a wrong host or path.
 * - `rate-limited`: 429.
 * - `service-down`: 5xx.
 * - `unreachable`: no answer at all (DNS, refused, reset).
 * - `timeout`: the call or the command did not finish.
 * - `blocked-host`: majhi refuses the address (private or link-local, not entered by the owner).
 * - `no-credential`: majhi holds nothing to check with.
 * - `expired`: the token ended and there is no renewal.
 * - `tool-missing`: the command is not installed (exit 127).
 * - `not-signed-in`: the command ran and says the tool has no working sign-in (exit not 0).
 * - `helper-offline`: the host helper is not connected, so a Mac sign-in cannot be checked.
 * - `setup-needed`: a setting at the service must be turned on (an API, an admin switch).
 * - `app-in-testing`: Google's app is in Testing, so its sign-in ends after 7 days.
 * - `mcp-error`: the MCP server answered with a protocol error.
 * - `unexpected`: the service answered, but not with what the check needs.
 */
export const FailureReasonSchema = z.enum([
  "rejected",
  "forbidden",
  "insufficient-scope",
  "not-found",
  "rate-limited",
  "service-down",
  "unreachable",
  "timeout",
  "blocked-host",
  "no-credential",
  "expired",
  "tool-missing",
  "not-signed-in",
  "helper-offline",
  "setup-needed",
  "app-in-testing",
  "mcp-error",
  "unexpected",
]);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

/** One line for the lamp: what is wrong, no more. */
export const FAILURE_LINE: Record<FailureReason, string> = {
  rejected: "The service no longer accepts the sign-in",
  forbidden: "The service refuses this account",
  "insufficient-scope": "The sign-in lacks access this needs",
  "not-found": "The address does not answer as this service",
  "rate-limited": "The service is limiting majhi",
  "service-down": "The service is having problems",
  unreachable: "majhi cannot reach the service",
  timeout: "The service did not answer in time",
  "blocked-host": "majhi refuses this address",
  "no-credential": "majhi holds no sign-in for it",
  expired: "The sign-in ended",
  "tool-missing": "The command-line tool is not installed",
  "not-signed-in": "The tool is not signed in",
  "helper-offline": "majhi's helper is not running",
  "setup-needed": "A setting at the service is off",
  "app-in-testing": "The Google app is still in Testing",
  "mcp-error": "The MCP server answered with an error",
  unexpected: "The service answered something majhi does not understand",
};

/** The exact next step for each reason, when the check knows nothing more precise. */
export const FAILURE_FIX: Record<FailureReason, string> = {
  rejected: "Reconnect it: sign in again, or paste a new token.",
  forbidden: "Use an account that may use this, or give it the access, then check again.",
  "insufficient-scope": "Reconnect and allow the access it asks for.",
  "not-found": "Check the host or address you entered, then connect again.",
  "rate-limited": "Wait a few minutes and check again.",
  "service-down": "Check the service's status page. majhi checks again on its own.",
  unreachable: "Check your internet connection, then check again.",
  timeout: "Check again. If it keeps happening, check the service's status page.",
  "blocked-host": "Use a public host name, or confirm that the address is on your own network.",
  "no-credential": "Connect it again.",
  expired: "Sign in again.",
  "tool-missing": "Install the tool on this Mac, then check again.",
  "not-signed-in": "Sign in again with the tool's own login.",
  "helper-offline": "Start majhi's helper on this Mac, then check again.",
  "setup-needed": "Turn the setting on at the service, then check again.",
  "app-in-testing": "Publish the app in the Google console, then sign in again.",
  "mcp-error": "Check again. If it keeps happening, remove it and connect it again.",
  unexpected: "Check again. If it keeps happening, the service may have changed.",
};

/**
 * Failures that say nothing about the credential: the service or the network is the problem, and the
 * next check can pass without the owner doing anything. A failure of these does not ask the owner.
 */
export const TRANSIENT_FAILURES: ReadonlySet<FailureReason> = new Set<FailureReason>([
  "rate-limited",
  "service-down",
  "unreachable",
  "timeout",
  "helper-offline",
]);

export const ConnectionFailureSchema = z.object({
  reason: FailureReasonSchema,
  /** The HTTP status or exit code the decision read, for the detail panel. */
  status: z.number().int().optional(),
  /** The exact next step. Defaults to `FAILURE_FIX[reason]`. Never holds a secret. */
  fix: z.string().max(400).optional(),
  /** A page that does the fix, like the exact setting or the token page. */
  fixUrl: z.url().optional(),
});
export type ConnectionFailure = z.infer<typeof ConnectionFailureSchema>;

const FailureFields = {
  at: z.iso.datetime(),
  reason: FailureReasonSchema,
  status: z.number().int().optional(),
  fix: z.string().max(400),
  fixUrl: z.url().optional(),
};

/**
 * Where a connection stands. `connected` always carries `verifiedAt` and what the check did, so the
 * state cannot be built without a pass.
 */
export const ConnectionHealthSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("connecting"), since: z.iso.datetime() }),
  z.object({
    state: z.literal("connected"),
    verifiedAt: z.iso.datetime(),
    /** What the passing check did, one short sentence each: "Asked GitHub who the token belongs to". */
    checked: z.array(z.string().min(1).max(200)).min(1),
    account: z.string().max(200).optional(),
  }),
  z.object({ state: z.literal("failed"), ...FailureFields }),
  z.object({
    state: z.literal("needs-attention"),
    ...FailureFields,
    /** When it last passed. */
    lastVerifiedAt: z.iso.datetime(),
    checked: z.array(z.string().min(1).max(200)).min(1),
    account: z.string().max(200).optional(),
  }),
]);
export type ConnectionHealth = z.infer<typeof ConnectionHealthSchema>;

/** What a check found, before the state machine reads it. */
export type CheckOutcome =
  | { ok: true; checked: string[]; account?: string | undefined }
  | { ok: false; failure: ConnectionFailure };

export type HealthEvent =
  | { type: "start"; at: string }
  | { type: "result"; at: string; outcome: CheckOutcome };

/**
 * The only way a state changes.
 * - `start` (a connect or a reconnect) goes to `connecting` from anywhere.
 * - A passing result goes to `connected` from anywhere.
 * - A failing result from `connected` or `needs-attention` goes to `needs-attention`, keeping the last
 *   time it passed. From `connecting`, `failed` or no state it goes to `failed`.
 */
export function nextHealth(prev: ConnectionHealth | undefined, event: HealthEvent): ConnectionHealth {
  if (event.type === "start") return { state: "connecting", since: event.at };
  const { outcome, at } = event;
  if (outcome.ok) {
    return {
      state: "connected",
      verifiedAt: at,
      checked: outcome.checked.length > 0 ? outcome.checked : ["Called the service with the stored sign-in"],
      ...(outcome.account === undefined ? {} : { account: outcome.account }),
    };
  }
  const f = outcome.failure;
  const body = {
    at,
    reason: f.reason,
    ...(f.status === undefined ? {} : { status: f.status }),
    fix: f.fix ?? FAILURE_FIX[f.reason],
    ...(f.fixUrl === undefined ? {} : { fixUrl: f.fixUrl }),
  };
  if (prev?.state === "connected") {
    return {
      state: "needs-attention",
      ...body,
      lastVerifiedAt: prev.verifiedAt,
      checked: prev.checked,
      ...(prev.account === undefined ? {} : { account: prev.account }),
    };
  }
  if (prev?.state === "needs-attention") {
    return {
      state: "needs-attention",
      ...body,
      lastVerifiedAt: prev.lastVerifiedAt,
      checked: prev.checked,
      ...(prev.account === undefined ? {} : { account: prev.account }),
    };
  }
  return { state: "failed", ...body };
}

// ---------------------------------------------------------------------------
// Reading a call's result. Every decision is a number or a code, never message text.

/** The reason for an HTTP status, or undefined for 2xx. 3xx counts as unexpected: majhi never follows a redirect with a token. */
export function failureFromHttp(status: number): FailureReason | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401) return "rejected";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not-found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "service-down";
  return "unexpected";
}

/** JSON-RPC and SDK error codes of an MCP call. */
export const MCP_CODE = {
  connectionClosed: -32000,
  requestTimeout: -32001,
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/**
 * The reason for an MCP error code. An HTTP-level code (100 to 599) is a status: the SDK puts the
 * status of a refused connection in `code`. A negative code is a JSON-RPC code.
 */
export function failureFromMcpCode(code: number): FailureReason {
  if (code >= 100 && code <= 599) return failureFromHttp(code) ?? "unexpected";
  if (code === MCP_CODE.requestTimeout) return "timeout";
  if (code === MCP_CODE.connectionClosed) return "unreachable";
  return "mcp-error";
}

/** Node network error codes that mean no answer at all. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
]);

/** The reason for a thrown error, read from its numeric or string `code` (and its `cause`'s), never its message. */
export function failureFromError(err: unknown): FailureReason {
  for (let cur: unknown = err, depth = 0; depth < 4 && typeof cur === "object" && cur !== null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "number") return failureFromMcpCode(code);
    if (typeof code === "string") {
      if (TIMEOUT_CODES.has(code)) return "timeout";
      if (NETWORK_CODES.has(code)) return "unreachable";
    }
    const name = (cur as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    // The MCP SDK's own class for "this server wants a sign-in".
    if (name === "UnauthorizedError" || (cur as object).constructor?.name === "UnauthorizedError") {
      return "rejected";
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return "unreachable";
}

/**
 * The reason for a command that ran: exit 0 passes, 127 or a program that does not exist is a missing
 * tool, a command stopped at its timeout (no code) is a timeout, anything else is a tool with no
 * working sign-in.
 */
export function failureFromExit(code: number | null, missing: boolean): FailureReason | undefined {
  if (missing || code === 127) return "tool-missing";
  if (code === null) return "timeout";
  return code === 0 ? undefined : "not-signed-in";
}

/** True when the failure asks the owner to do something. */
export function needsOwner(reason: FailureReason): boolean {
  return !TRANSIENT_FAILURES.has(reason);
}

/** The single lamp of a state, for rows and the sidebar: one word each. */
export function healthLine(health: ConnectionHealth | undefined): { word: string; line: string } {
  if (health === undefined) return { word: "Checking", line: "Not checked yet" };
  switch (health.state) {
    case "connecting":
      return { word: "Connecting", line: "Calling the service" };
    case "connected":
      return { word: "Connected", line: health.account ?? health.checked[0] ?? "Verified" };
    case "failed":
      return { word: "Failed", line: FAILURE_LINE[health.reason] };
    case "needs-attention":
      return { word: "Needs attention", line: FAILURE_LINE[health.reason] };
  }
}
