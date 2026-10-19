import { describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { assertHostAllowed } from "./self-host.ts";

const answers = (addresses: string[]) => async () => addresses;

/** What the owner sees for a host: it goes through, only the owner can confirm it, or it never goes. */
type Outcome = "allowed" | "owner confirms" | "never";

describe("assertHostAllowed", () => {
  it.each<[host: string, resolvesTo: string[], outcome: Outcome]>([
    ["8.8.8.8", [], "allowed"],
    ["127.0.0.1", [], "owner confirms"],
    ["10.1.2.3", [], "owner confirms"],
    ["172.16.0.1", [], "owner confirms"],
    ["172.32.0.1", [], "allowed"],
    ["192.168.1.9", [], "owner confirms"],
    ["100.64.0.1", [], "owner confirms"],
    ["169.254.169.254", [], "never"],
    ["169.254.1.1", [], "never"],
    ["0.0.0.0", [], "never"],
    ["[::1]", [], "owner confirms"],
    ["[::]", [], "never"],
    ["[fd12:3456::1]", [], "owner confirms"],
    ["[fe80::1]", [], "never"],
    ["[fd00:ec2::254]", [], "never"],
    ["[::ffff:127.0.0.1]", [], "owner confirms"],
    ["[::ffff:10.0.0.1]", [], "owner confirms"],
    ["[2606:4700::1111]", [], "allowed"],
    ["git.acme.test", ["203.0.114.5"], "allowed"],
    ["git.acme.test", ["10.1.2.3"], "owner confirms"],
    ["metadata.acme.test", ["169.254.169.254"], "never"],
  ])(
    "never sends a token to a private, loopback, link-local or metadata address: %s resolving to %j is %s",
    async (host, resolvesTo, outcome) => {
      const lookup = answers(resolvesTo);
      if (outcome === "allowed") {
        await expect(assertHostAllowed(host, { lookup })).resolves.toBeUndefined();
        return;
      }
      await expect(assertHostAllowed(host, { lookup })).rejects.toBeInstanceOf(UserError);
      if (outcome === "owner confirms") {
        await expect(assertHostAllowed(host, { lookup, allowPrivate: true })).resolves.toBeUndefined();
        return;
      }
      await expect(assertHostAllowed(host, { lookup, allowPrivate: true })).rejects.toThrow(/metadata/);
    },
  );
});
