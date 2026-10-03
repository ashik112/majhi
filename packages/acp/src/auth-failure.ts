import { AcpAuthRequired, isAuthRequired } from "./acp-session.ts";

/**
 * The one list of how Claude Code, Codex and ACP say that an account's sign-in no longer works.
 * Run failures, failed starts and usage reads all ask here. Checked on errors and on the last
 * message of a turn that failed, never on an agent's ordinary output: agents write about
 * authentication too.
 */
const SIGNED_OUT: readonly RegExp[] = [
  // Claude Code: "Failed to authenticate: OAuth session expired and could not be refreshed".
  /\bfailed to authenticate\b/i,
  /\boauth (session|token)\b.*\b(expired|revoked|invalid)\b/i,
  /\bcould not be refreshed\b/i,
  // Codex: "Your refresh token has expired. Please log out and sign in again."
  /\brefresh token (has expired|expired|was already used|is invalid|was revoked)\b/i,
  /\b(log|sign) ?out and (log|sign) ?in again\b/i,
  // Claude Code: "Invalid API key · Please run /login".
  /\brun \/login\b/i,
  /\bnot (logged|signed) in\b/i,
  /\b(logged|signed) out\b/i,
  /\b(log|sign) ?in (required|again|first)\b/i,
  // ACP's authRequired error, and the API's authentication_error.
  /\bauthentication (required|failed|error)\b/i,
  /\bauthentication_error\b/i,
  /\binvalid (api key|x-api-key|bearer token|credentials)\b/i,
  /\b401\b.*\bunauthori[sz]ed\b|\bunauthori[sz]ed\b.*\b401\b/i,
  /\b(access token|token|session) (has )?expired\b/i,
];

/** Longer lines are an agent's prose, not a CLI's error. */
const ERROR_LINE_MAX = 400;

/** Whether one error text says the sign-in no longer works. */
export function looksSignedOut(text: string): boolean {
  return SIGNED_OUT.some((re) => re.test(text));
}

/**
 * Whether a failed prompt or start failed on the account's sign-in: ACP's auth-required error, or
 * an error whose words say so. `lastText` is the agent's last message in the failed turn: the CLIs
 * print their auth error there ("Failed to authenticate: ...") and the prompt then fails with a
 * generic "Authentication required". Only its first line counts, and only when it is short.
 */
export function isAuthFailure(err: unknown, lastText?: string): boolean {
  if (err instanceof AcpAuthRequired || isAuthRequired(err)) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (looksSignedOut(message)) return true;
  const line = (lastText ?? "").trim().split("\n", 1)[0]?.trim() ?? "";
  return line !== "" && line.length <= ERROR_LINE_MAX && looksSignedOut(line);
}

/**
 * A usage read found that the CLI cannot use its sign-in: the token expired and could not be
 * refreshed, or was refused. The account needs a new sign-in.
 */
export class SignInExpired extends Error {
  constructor(
    message = "The sign-in expired and could not be refreshed. Sign in again from Studio > Accounts.",
  ) {
    super(message);
    this.name = "SignInExpired";
  }
}
