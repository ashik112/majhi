import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { z } from "zod";

/** Where OpenAI publishes the keys its sign-in tokens are signed with (checked: RS256 keys with a `kid`). */
export const OPENAI_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const OPENAI_ISSUER = "https://auth.openai.com";
const JWKS_TIMEOUT_MS = 10_000;

const Header = z.looseObject({ alg: z.literal("RS256"), kid: z.string() });

const Claims = z.looseObject({
  iss: z.string(),
  exp: z.number(),
  "https://api.openai.com/auth": z.looseObject({
    chatgpt_account_id: z.string(),
    chatgpt_user_id: z.string().optional(),
    user_id: z.string().optional(),
  }),
  "https://api.openai.com/profile": z.looseObject({ email: z.string().optional() }).optional(),
});

const Jwks = z.looseObject({
  keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })),
});

/** What a verified token says about who holds it. */
export interface OpenAiHolder {
  accountId: string;
  userId: string;
  email: string | undefined;
}

export interface JwksOptions {
  /** Replaces `fetch` for the key set. Tests serve their own. */
  fetch?: typeof fetch | undefined;
  url?: string | undefined;
  /** The clock, for the token's `exp`. */
  now?: (() => number) | undefined;
}

/** Keys already fetched, by key set and `kid`: the set is read again only for a `kid` it has not seen. */
const keys = new Map<string, KeyObject>();

async function keyFor(kid: string, options: JwksOptions): Promise<KeyObject> {
  const url = options.url ?? OPENAI_JWKS_URL;
  const known = keys.get(`${url}#${kid}`);
  if (known !== undefined) return known;
  let body: unknown;
  try {
    const res = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new Error(
      `could not read OpenAI's signing keys: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const set = Jwks.safeParse(body);
  if (!set.success) throw new Error("OpenAI's signing keys came in a shape majhi does not know");
  for (const jwk of set.data.keys) {
    if (jwk.kid === undefined || jwk.kty !== "RSA") continue;
    try {
      keys.set(`${url}#${jwk.kid}`, createPublicKey({ key: jwk, format: "jwk" }));
    } catch {
      // A key that does not load is no key.
    }
  }
  const found = keys.get(`${url}#${kid}`);
  if (found === undefined) throw new Error("the sign-in is signed with a key OpenAI does not publish");
  return found;
}

function part(text: string | undefined): unknown {
  try {
    return JSON.parse(Buffer.from(text ?? "", "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Checks that an OpenAI access token is really OpenAI's (RS256 signature against OpenAI's published keys, issuer,
 * not expired) and says who holds it. Every agent can read and write `auth.json`, so nothing in that file but a
 * signed token can say who the account is. Rejects with a one-line message when the token does not verify, and
 * when the keys cannot be read: no answer is no proof.
 */
export async function verifyOpenAiToken(token: string, options: JwksOptions = {}): Promise<OpenAiHolder> {
  const [head, body, signature, extra] = token.split(".");
  if (head === undefined || body === undefined || signature === undefined || extra !== undefined) {
    throw new Error("the sign-in token is not a signed token");
  }
  const header = Header.safeParse(part(head));
  if (!header.success) throw new Error("the sign-in token is not signed with RS256");
  const key = await keyFor(header.data.kid, options);
  const signed = verify("sha256", Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url"));
  if (!signed) throw new Error("the sign-in token's signature is not OpenAI's");
  const claims = Claims.safeParse(part(body));
  if (!claims.success) throw new Error("the sign-in token has no account in it");
  if (claims.data.iss !== OPENAI_ISSUER) throw new Error("the sign-in token is not from OpenAI");
  if (claims.data.exp * 1000 <= (options.now?.() ?? Date.now()))
    throw new Error("the sign-in token has expired");
  const auth = claims.data["https://api.openai.com/auth"];
  const userId = auth.chatgpt_user_id ?? auth.user_id;
  if (userId === undefined) throw new Error("the sign-in token names no user");
  return {
    accountId: auth.chatgpt_account_id,
    userId,
    email: claims.data["https://api.openai.com/profile"]?.email,
  };
}
