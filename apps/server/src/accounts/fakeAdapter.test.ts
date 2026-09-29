import { fakeAdapter } from "@majhi/acp/testing";
import { COMMAND_META_HEADER } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { generateKey } from "../secrets/store.ts";
import { createMajhi, type Majhi } from "../server.ts";
import { tempDir, testEnv, writeKeyFile } from "../testing/fixtures.ts";

/** The real runtime from @majhi/acp, with the adapter command pointed at the fake ACP agent. No tokens. */
describe("health and models through the real runtime and the fake adapter", () => {
  let cleanup: () => Promise<void>;
  let majhi: Majhi;

  afterEach(async () => {
    majhi?.close();
    await cleanup?.();
  });

  async function setup(adapter: Parameters<typeof fakeAdapter>[1]) {
    const temp = await tempDir();
    cleanup = temp.cleanup;
    const base = testEnv(temp.dir);
    await writeKeyFile(base.secretsKeyFile, await generateKey());
    const env = testEnv(temp.dir, {
      runtime: { ...base.runtime, adapters: { claude: fakeAdapter("claude", adapter) } },
    });
    majhi = createMajhi(env);
    // biome-ignore lint/suspicious/noExplicitAny: test helper; each test asserts the fields it reads
    const cmd = async (name: string, body: unknown = {}): Promise<{ status: number; body: any }> => {
      const res = await majhi.app.request(`/api/cmd/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", [COMMAND_META_HEADER]: "{}" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    await cmd("workspaces.set", { workspaces: ["~/Work"] });
    await cmd("orgs.create", { id: "acme", name: "Acme" });
    await cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" });
    return { cmd, env };
  }

  it("a signed-in account is healthy, offers models, and passes the agent check", async () => {
    const { cmd } = await setup({ signedIn: true, models: ["opus", "sonnet"], efforts: ["low", "high"] });

    const health = await cmd("accounts.health", { id: "claude-acme" });
    expect(health.status).toBe(200);
    expect(health.body.account.status).toBe("healthy");
    expect(health.body.health.steps.map((s: { name: string; ok: boolean }) => [s.name, s.ok])).toEqual([
      ["cli", true],
      ["auth", true],
      ["acp", true],
    ]);

    const models = await cmd("accounts.models", { id: "claude-acme" });
    expect(models.body.models.map((m: { id: string }) => m.id)).toEqual(["opus", "sonnet"]);
    expect(models.body.efforts.map((m: { id: string }) => m.id)).toEqual(["low", "high"]);

    await cmd("agents.create", {
      id: "builder",
      frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", model: "opus", effort: "high" },
      instructions: "Build.",
    });
    const agent = await cmd("agents.health", { id: "builder" });
    expect(agent.body.ok).toBe(true);
    expect(agent.body.steps.at(-1).name).toBe("model");
  });
});
