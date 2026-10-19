import { describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { assertHostAllowed } from "./self-host.ts";

const answers = (addresses: string[]) => async () => addresses;

describe("assertHostAllowed", () => {
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
