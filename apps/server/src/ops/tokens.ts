import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PhoneAction } from "@majhi/shared";
import type { OpsRepo } from "./repo.ts";

/**
 * Single-use links for the phone's action buttons. A link names an opaque reference, never a decision:
 * `/ops/phone/<ref>/<action>?t=<token>`. The decision lives in majhi's database next to the reference,
 * so a push on ntfy.sh carries no task id and no decision id. The token is signed with a key from
 * secrets.age over the reference, the action, the expiry and the decision it is bound to; it is valid for
 * a short time and spent by its first use. A copy, a replay, another decision, another action, a changed
 * byte or a stale link all get the same refusal. Taking one button of a decision voids its others.
 */

export const TOKEN_TTL_MS = 60 * 60_000;

interface Payload {
  /** Reference: random, also the link's path. */
  j: string;
  /** Action. */
  a: PhoneAction;
  /** Expires, epoch ms. */
  e: number;
}

function b64(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(key: Buffer, body: string, decision: string): Buffer {
  return createHmac("sha256", key).update(`${body}\n${decision}`).digest();
}

export type TokenVerdict =
  | { ok: true; decision: string; action: PhoneAction }
  | { ok: false; why: "malformed" | "signature" | "expired" | "mismatch" | "used" | "unknown" };

export class PhoneTokens {
  constructor(
    private readonly repo: OpsRepo,
    /** The signing key, read from secrets.age when needed. */
    private readonly key: () => Promise<Buffer | undefined>,
    private readonly now: () => Date,
    private readonly ttlMs = TOKEN_TTL_MS,
  ) {}

  /** A link for one action on one decision: the reference and the token. Undefined when no key is set up. */
  async mint(decision: string, action: PhoneAction): Promise<{ ref: string; token: string } | undefined> {
    const key = await this.key();
    if (key === undefined) return undefined;
    const ref = randomBytes(12).toString("base64url");
    const expires = this.now().getTime() + this.ttlMs;
    this.repo.addToken(ref, decision, action, new Date(expires).toISOString());
    const body = b64(JSON.stringify({ j: ref, a: action, e: expires } satisfies Payload));
    return { ref, token: `${body}.${b64(sign(key, body, decision))}` };
  }

  /**
   * Checks a token for the reference and action its link names, and spends it. Everything that is wrong
   * with it is a refusal; the caller says one sentence for all of them.
   */
  async redeem(token: string, ref: string, action: string): Promise<TokenVerdict> {
    const key = await this.key();
    if (key === undefined) return { ok: false, why: "unknown" };
    const [body, sig, extra] = token.split(".");
    if (body === undefined || sig === undefined || extra !== undefined || body === "" || sig === "") {
      return { ok: false, why: "malformed" };
    }
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    } catch {
      return { ok: false, why: "malformed" };
    }
    if (typeof payload.j !== "string" || typeof payload.a !== "string" || typeof payload.e !== "number") {
      return { ok: false, why: "malformed" };
    }
    if (payload.j !== ref || payload.a !== action) return { ok: false, why: "mismatch" };
    const stored = this.repo.token(ref);
    if (stored === undefined) return { ok: false, why: "unknown" };
    const expected = sign(key, body, stored.decision);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, why: "signature" };
    }
    if (stored.action !== payload.a) return { ok: false, why: "mismatch" };
    if (payload.e < this.now().getTime() || Date.parse(stored.expiresAt) < this.now().getTime()) {
      return { ok: false, why: "expired" };
    }
    if (!this.repo.useToken(ref, this.now().toISOString())) return { ok: false, why: "used" };
    return { ok: true, decision: stored.decision, action: payload.a };
  }

  /** Once a decision is answered, its remaining buttons are dead. */
  void(decision: string): void {
    this.repo.voidTokens(decision, this.now().toISOString());
  }
}
