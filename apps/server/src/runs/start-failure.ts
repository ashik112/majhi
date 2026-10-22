import { looksSignedOut } from "@majhi/acp";
import type { AccountStatus } from "@majhi/shared";

/** Why an agent could not start: its account is signed out or at its limit, or something else failed. */
export interface StartFailure {
  kind: "signed-out" | "limit" | "error";
  /** One line for the room: what is wrong, and for a sign-in what to do. */
  text: string;
  /** When a failed start's limit lifts (ISO), when the account's usage says. */
  resetsAt?: string | undefined;
}

/** What a fresh health check of the agent's account says. */
export interface AccountProbe {
  status: AccountStatus;
  /** When the full usage window resets (ISO). */
  resetsAt?: string | undefined;
}

const LIMIT = /usage limit|rate limit|limit reached|out of (credits|usage)|quota/i;

/** The first line of an error, which is what the room shows. */
export function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? text).trim();
}

/** "3:40 PM": the clock time of a reset, in the server's time zone. */
function clockOf(iso: string): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Sorts a failed start. The account's own state wins over the wording of the error, since the
 * tools word a sign-in or a limit in many ways. `account` is undefined when the agent's account
 * is unknown (the agent file itself failed to resolve).
 */
export function classifyStartFailure(input: {
  account: string | undefined;
  message: string;
  probe: AccountProbe | undefined;
}): StartFailure {
  const { account, message, probe } = input;
  if (account !== undefined) {
    if (probe?.status === "needs-login" || (probe?.status !== "at-limit" && looksSignedOut(message)))
      return { kind: "signed-out", text: `${account} is signed out. Sign in, then resume.` };
    if (probe?.status === "at-limit" || LIMIT.test(message)) {
      const until = probe?.resetsAt === undefined ? undefined : clockOf(probe.resetsAt);
      return {
        kind: "limit",
        text:
          until === undefined ? `${account} is at its limit` : `${account} is at its limit until ${until}`,
        ...(probe?.resetsAt === undefined ? {} : { resetsAt: probe.resetsAt }),
      };
    }
  }
  return { kind: "error", text: firstLine(message) };
}

/** True when the account can run agents again: signed in, at its limit or not. */
export function signedIn(status: AccountStatus): boolean {
  return status !== "needs-login" && status !== "unreachable" && status !== "unknown";
}
