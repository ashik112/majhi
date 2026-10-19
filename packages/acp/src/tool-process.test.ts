import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../testing/index.ts";
import type { AccountRuntime, RuntimeOptions } from "./index.ts";
import { probeAccount } from "./probe.ts";
import { dockerRunArgs, type RunnerConfig } from "./runner/docker.ts";
import { localSpawner, type SpawnRequest } from "./spawn.ts";

const cfg: RunnerConfig = {
  image: "majhi-runner:dev",
  network: "majhi-runners",
  user: "501:20",
  cliEnv: { PATH: "/usr/bin" },
  majhiHome: "/Users/owner/.majhi",
  protectedPaths: ["/Users/owner/.config/majhi/secrets.key"],
};

describe("an account probe in a runner container", () => {
  it("mounts only that account's home, never another account's or the majhi folder", async () => {
    const seen: SpawnRequest[] = [];
    const options: RuntimeOptions = {
      base: { PATH: process.env.PATH ?? "/usr/bin" },
      adapters: { claude: fakeAdapter("claude", { signedIn: true }) },
      // Records each request, then runs the fake agent next to the test: only the request is under test.
      spawner: async (req) => {
        seen.push(req);
        return localSpawner({ ...req, cwd: process.cwd(), scratch: false });
      },
    };
    const account: AccountRuntime = { tool: "claude", home: "/Users/owner/.majhi/accounts/claude-acme" };

    const probe = await probeAccount(account, options);

    expect(probe.health.steps.map((s) => s.name)).toEqual(["cli", "auth", "acp"]);
    expect(seen.length).toBe(3);
    for (const req of seen) {
      expect(req.account).toEqual(account);
      expect(req.mounts ?? []).toEqual([]);
      expect(req.scratch).toBe(true);
      const mounts = dockerRunArgs(req, cfg, "majhi-run-test")
        .filter((_, i, all) => all[i - 1] === "--mount")
        .map((m) => m.split(",")[1]);
      expect(mounts).toEqual(["source=/Users/owner/.majhi/accounts/claude-acme"]);
    }
  });
});
