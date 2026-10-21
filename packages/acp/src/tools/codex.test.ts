import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeOptions } from "../index.ts";
import { codex } from "./codex.ts";

// OpenAI's signing key, and a stranger's that OpenAI never published.
const openai = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const URL = "https://keys.test/jwks.json";
const jwks = {
  keys: [{ ...openai.publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" }],
};

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
function token(
  who: { account: string; user: string; email: string },
  over: { key?: KeyObject; kid?: string; iss?: string; exp?: number } = {},
): string {
  const head = b64({ alg: "RS256", typ: "JWT", kid: over.kid ?? "key-1" });
  const body = b64({
    iss: over.iss ?? "https://auth.openai.com",
    exp: over.exp ?? Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: who.account, chatgpt_user_id: who.user },
    "https://api.openai.com/profile": { email: who.email },
  });
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), over.key ?? openai.privateKey).toString(
    "base64url",
  );
  return `${head}.${body}.${signature}`;
}

const OWNER = { account: "acct-owner", user: "user-owner", email: "owner@acme.test" };
const OTHER = { account: "acct-other", user: "user-other", email: "sam@globex.test" };

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "majhi-codex-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

async function identityOf(
  authJson: object,
  jwksFetch: typeof fetch = (async () => Response.json(jwks)) as typeof fetch,
) {
  await writeFile(join(home, "auth.json"), JSON.stringify(authJson));
  const options: RuntimeOptions = { base: { PATH: "/usr/bin" }, jwks: { url: URL, fetch: jwksFetch } };
  return codex.readIdentity({
    account: { tool: "codex", home },
    env: {},
    adapter: codex.adapter,
    options,
    timeoutMs: 1000,
  });
}

describe("Codex sign-in identity", () => {
  it("is the signed access token's account and user, and a genuine id_token beside another account's access token is refused", async () => {
    expect(await identityOf({ tokens: { access_token: token(OWNER) } })).toEqual({
      id: "acct-owner/user-owner",
      label: "owner@acme.test",
    });

    // The owner's genuine id_token and account_id, next to a validly signed access token of another account:
    // the answer is the other account (so the pin refuses it), never the owner.
    const ownerIdToken = token(OWNER);
    const swapped = await identityOf({
      tokens: { id_token: ownerIdToken, account_id: OWNER.account, access_token: token(OTHER) },
    });
    expect(swapped.id).toBe("acct-other/user-other");
    expect(swapped.id).not.toBe("acct-owner/user-owner");
  });

  it.each([
    ["a token signed with a key OpenAI never published", () => token(OWNER, { key: stranger.privateKey })],
    ["a key id OpenAI does not publish", () => token(OWNER, { kid: "key-unknown" })],
    ["another issuer", () => token(OWNER, { iss: "https://evil.test" })],
    ["an expired token", () => token(OWNER, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ["a token with no signature", () => token(OWNER).split(".").slice(0, 2).join(".")],
  ])("refuses %s", async (_name, make) => {
    await expect(identityOf({ tokens: { access_token: make() } })).rejects.toThrow();
  });

  it("refuses when OpenAI's keys cannot be read", async () => {
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    // A kid no earlier test cached, so the key set must be fetched.
    await expect(
      identityOf({ tokens: { access_token: token(OWNER, { kid: "key-2" }) } }, down),
    ).rejects.toThrow(/could not read OpenAI's signing keys/);
  });
});
