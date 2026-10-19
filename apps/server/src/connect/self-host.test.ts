import { describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { assertHostAllowed } from "./self-host.ts";

const answers = (addresses: string[]) => async () => addresses;

describe("assertHostAllowed", () => {
  it("refuses a public name that resolves to a private address, unless the owner confirms", async () => {
    const lookup = answers(["10.1.2.3"]);
    await expect(assertHostAllowed("git.acme.test", { lookup })).rejects.toBeInstanceOf(UserError);
    await expect(assertHostAllowed("git.acme.test", { lookup, allowPrivate: true })).resolves.toBeUndefined();
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
});
