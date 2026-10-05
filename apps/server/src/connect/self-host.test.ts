import { describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { assertHostAllowed } from "./self-host.ts";

const answers = (addresses: string[]) => async () => addresses;

describe("assertHostAllowed", () => {
  it("accepts a public host", async () => {
    await expect(
      assertHostAllowed("git.acme.test", { lookup: answers(["203.0.114.5"]) }),
    ).resolves.toBeUndefined();
  });

  it("refuses a public name that resolves to a private address, unless the owner confirms", async () => {
    const lookup = answers(["10.1.2.3"]);
    await expect(assertHostAllowed("git.acme.test", { lookup })).rejects.toBeInstanceOf(UserError);
    await expect(assertHostAllowed("git.acme.test", { lookup, allowPrivate: true })).resolves.toBeUndefined();
  });

  it("refuses when any one answer is private", async () => {
    await expect(
      assertHostAllowed("git.acme.test", { lookup: answers(["203.0.114.5", "127.0.0.1"]) }),
    ).rejects.toThrow(/private network/);
  });

  it("refuses loopback, private and number-trick hosts without a lookup", async () => {
    const never = async () => {
      throw new Error("must not look up");
    };
    for (const host of ["localhost", "127.0.0.1", "192.168.0.7:8443", "2130706433", "gitlab", "[::1]"]) {
      await expect(assertHostAllowed(host, { lookup: never })).rejects.toBeInstanceOf(UserError);
    }
  });

  it("never allows a metadata address, not by name and not by number, even when confirmed", async () => {
    for (const host of ["169.254.169.254", "metadata.acme.test"]) {
      await expect(
        assertHostAllowed(host, {
          allowPrivate: true,
          lookup: answers(["169.254.169.254"]),
        }),
      ).rejects.toThrow(/metadata/);
    }
  });

  it("says so when the name does not exist", async () => {
    const lookup = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    await expect(assertHostAllowed("nope.acme.test", { lookup })).rejects.toThrow(
      /cannot find nope\.acme\.test/,
    );
  });
});
