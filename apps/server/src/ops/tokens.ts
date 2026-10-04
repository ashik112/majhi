import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PhoneAction } from "@majhi/shared";
import type { OpsRepo } from "./repo.ts";

/**
 * Single-use links for the phone's action buttons. A token is bound to one decision and one action,
 * signed with a key that lives in secrets.age, valid for a short time, and spent by its first use:
 * a copy of the link, a replay, a changed decision or action, a changed byte, or a stale link all get
 * the same refusal. Taking one button of a decision voids its others.
 */

export const TOKEN_TTL_MS = 60 * 60_000;

interface Payload {
  /** Token id. */
  j: string;
  /** Decision id. */
  d: string;
  /** Action. */
  a: PhoneAction;
  /** Expires, epoch ms. */
  e: number;
}

function b64(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(key: Buffer, body: string): Buffer {
  return createHmac("sha256", key).update(body).digest();
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

  /** A link token for one action on one decision. Undefined when no key is set up. */
  async mint(decision: string, action: PhoneAction): Promise<string | undefined> {
    const key = await this.key();
    if (key === undefined) return undefined;
    const jti = randomBytes(12).toString("base64url");
    const expires = this.now().getTime() + this.ttlMs;
    this.repo.addToken(jti, decision, action, new Date(expires).toISOString());
    const body = b64(JSON.stringify({ j: jti, d: decision, a: action, e: expires } satisfies Payload));
    return `${body}.${b64(sign(key, body))}`;
  }

  /**
   * Checks a token for the decision and action its link names and spends it. Everything that is wrong
   * with it is a refusal; the caller says one sentence for all of them.
   */
  async redeem(token: string, decision: string, action: string): Promise<TokenVerdict> {
    const key = await this.key();
    if (key === undefined) return { ok: false, why: "unknown" };
    const [body, sig, extra] = token.split(".");
    if (body === undefined || sig === undefined || extra !== undefined || body === "" || sig === "") {
      return { ok: false, why: "malformed" };
    }
    const expected = sign(key, body);
    let given: Buffer;
    try {
      given = Buffer.from(sig, "base64url");
    } catch {
      return { ok: false, why: "malformed" };
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, why: "signature" };
    }
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    } catch {
      return { ok: false, why: "malformed" };
    }
    if (
      typeof payload.j !== "string" ||
      typeof payload.d !== "string" ||
      typeof payload.a !== "string" ||
      typeof payload.e !== "number"
    ) {
      return { ok: false, why: "malformed" };
    }
    if (payload.d !== decision || payload.a !== action) return { ok: false, why: "mismatch" };
    if (payload.e < this.now().getTime()) return { ok: false, why: "expired" };
    const stored = this.repo.token(payload.j);
    if (stored === undefined) return { ok: false, why: "unknown" };
    if (stored.decision !== payload.d || stored.action !== payload.a) return { ok: false, why: "mismatch" };
    if (!this.repo.useToken(payload.j, this.now().toISOString())) return { ok: false, why: "used" };
    return { ok: true, decision: payload.d, action: payload.a };
  }

  /** Once a decision is answered, its remaining buttons are dead. */
  void(decision: string): void {
    this.repo.voidTokens(decision, this.now().toISOString());
  }
}
