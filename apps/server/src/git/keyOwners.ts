import { createHash } from "node:crypto";
import type { GitAcceptedKey, GitHostLogins, GitLogin } from "@majhi/shared";
import { z } from "zod";
import type { Probe } from "../orgs/gitAccount.ts";

/**
 * One account of a host and the SHA256 fingerprints of the SSH keys registered on it.
 * `undefined` fingerprints: the host would not list them (the token lacks the scope, or the API failed).
 */
export interface KeyOwner {
  account: string;
  fingerprints: ReadonlySet<string> | undefined;
}

/** `SHA256:` plus the unpadded base64 of the SHA-256 of the key's wire bytes, as `ssh-keygen -l` prints it. */
export function fingerprintOfPublicKey(line: string): string | undefined {
  const blob = line.trim().split(/\s+/)[1];
  if (blob === undefined) return undefined;
  const bytes = Buffer.from(blob, "base64");
  if (bytes.length === 0) return undefined;
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}

const SshKeysSchema = z.object({
  values: z.array(z.object({ key: z.string().optional(), fingerprint: z.string().optional() }).passthrough()),
});

const normalize = (fp: string): string => `SHA256:${fp.replace(/^SHA256:/i, "").replace(/=+$/, "")}`;

/**
 * The fingerprints of the SSH keys on a Bitbucket account. `GET /2.0/users/{selected_user}/ssh-keys`
 * needs the `account` scope (https://developer.atlassian.com/cloud/bitbucket/rest/api-group-ssh/).
 * Returns undefined when the API refuses or fails. Only the first page is read: 100 keys is plenty.
 */
export async function bitbucketKeyFingerprints(
  probe: Probe,
  headers: Record<string, string>,
  uuid: string,
): Promise<Set<string> | undefined> {
  try {
    const url = `https://api.bitbucket.org/2.0/users/${encodeURIComponent(uuid)}/ssh-keys?pagelen=100`;
    const answer = await probe(url, headers);
    if (answer.status < 200 || answer.status >= 300) return undefined;
    const parsed = SshKeysSchema.safeParse(answer.body);
    if (!parsed.success) return undefined;
    const out = new Set<string>();
    for (const k of parsed.data.values) {
      const fp = (k.key === undefined ? undefined : fingerprintOfPublicKey(k.key)) ?? k.fingerprint;
      if (fp !== undefined) out.add(normalize(fp));
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Turns the accepted keys that name no account into logins, when exactly the fingerprint is on an
 * account's key list. Keys no listed account owns stay in `keys`.
 */
export function resolveKeys(found: GitHostLogins, owners: readonly KeyOwner[]): GitHostLogins {
  if (found.keys === undefined || found.keys.length === 0) return found;
  const logins: GitLogin[] = [...found.logins];
  const rest: GitAcceptedKey[] = [];
  for (const key of found.keys) {
    const fp = key.fingerprint === undefined ? undefined : normalize(key.fingerprint);
    const owner = fp === undefined ? undefined : owners.find((o) => o.fingerprints?.has(fp) === true);
    if (fp === undefined || owner === undefined) {
      rest.push(key);
      continue;
    }
    logins.push({
      via: "ssh",
      ...(key.alias === undefined ? {} : { alias: key.alias }),
      account: owner.account,
      fingerprint: fp,
    });
  }
  const { keys: _dropped, ...base } = found;
  return { ...base, logins, ...(rest.length === 0 ? {} : { keys: rest }) };
}
