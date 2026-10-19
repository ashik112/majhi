import { afterEach, describe, expect, it } from "vitest";
import { buildEnv } from "./env.ts";
import { loginCommand } from "./login.ts";

const base = { PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "C.UTF-8" };

describe("buildEnv", () => {
  afterEach(() => {
    delete process.env.MAJHI_TEST_SENTINEL;
    delete process.env.SSH_KEY_PATH;
  });

  it("never copies from process.env", () => {
    process.env.MAJHI_TEST_SENTINEL = "leak";
    process.env.SSH_KEY_PATH = "/home/me/.ssh/id_ed25519";
    const env = buildEnv({ tool: "claude", home: "/h/a" }, base);
    expect(env).toEqual({
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      HOME: "/h/a",
      CLAUDE_CONFIG_DIR: "/h/a",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "1",
    });
  });
});
