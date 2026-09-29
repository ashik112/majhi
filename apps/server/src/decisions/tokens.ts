import { randomBytes } from "node:crypto";

export interface DecideCaller {
  task: string;
  agent: string;
}

/** Bearer tokens for `majhi-decide`, one per agent session, with the calls made so far. */
export class DecideTokens {
  private readonly tokens = new Map<string, DecideCaller & { calls: number }>();

  issue(caller: DecideCaller): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, { ...caller, calls: 0 });
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  lookup(token: string): DecideCaller | undefined {
    return this.tokens.get(token);
  }

  /** Counts one call and returns how many this token has made, or undefined for an unknown token. */
  count(token: string): number | undefined {
    const entry = this.tokens.get(token);
    if (entry === undefined) return undefined;
    entry.calls += 1;
    return entry.calls;
  }

  get size(): number {
    return this.tokens.size;
  }
}
