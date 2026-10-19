import type { DeployEnvironment } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { environmentsProblem } from "./rails.ts";

/** What the captain may not do to a project's deploys, whatever its prompt says. */

const prod: DeployEnvironment = { env: "production", tier: "production" };

describe("environments the captain changes", () => {
  it("never sets a tier to staging, not even on an environment that is production", () => {
    expect(environmentsProblem([prod], [prod, { env: "qa", tier: "staging" }], "captain")).toContain(
      "Only the owner sets qa to staging",
    );
    expect(environmentsProblem([prod], [{ ...prod, tier: "staging" }], "captain")).toContain(
      "Only the owner sets production to staging",
    );
  });
});
