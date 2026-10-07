import { describe, expect, it } from "vitest";
import { fingerprintOfPublicKey, resolveKeys } from "./keyOwners.ts";

describe("resolveKeys", () => {
  const blob = Buffer.from("acme-test-key-bytes").toString("base64");
  const fp = fingerprintOfPublicKey(`ssh-ed25519 ${blob} acme@laptop`) ?? "";
  const found = { host: "bitbucket.org", logins: [], keys: [{ fingerprint: fp }] };

  it("ties an accepted key with no account to the account whose key list holds its fingerprint", async () => {
    const out = await resolveKeys(found, [{ account: "acme-dev", fingerprints: new Set([fp]) }]);
    expect(out.logins).toEqual([{ via: "ssh", account: "acme-dev", fingerprint: fp }]);
    expect(out.keys).toBeUndefined();
  });

  it("leaves a key that is not in the account's list, or a list that could not be read, unmatched", async () => {
    const other = new Set(["SHA256:somethingElse"]);
    for (const fingerprints of [other, undefined]) {
      const out = await resolveKeys(found, [{ account: "acme-dev", fingerprints }]);
      expect(out.logins).toEqual([]);
      expect(out.keys).toEqual([{ fingerprint: fp }]);
    }
  });

  it("when the list can't be read, a key that reaches the account's repo counts and one that does not stays unmatched", async () => {
    const owner = (reaches: boolean) => ({
      account: "acme-dev",
      fingerprints: undefined,
      target: "acme/api",
      reach: async () => reaches,
    });
    const works = await resolveKeys(found, [owner(true)]);
    expect(works.logins).toEqual([{ via: "ssh", account: "acme-dev", fingerprint: fp }]);
    expect(works.keys).toBeUndefined();
    const fails = await resolveKeys(found, [owner(false)]);
    expect(fails.logins).toEqual([]);
    expect(fails.keys).toEqual([{ fingerprint: fp }]);
  });
});
