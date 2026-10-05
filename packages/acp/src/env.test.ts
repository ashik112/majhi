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

  it("skips base values that are not set", () => {
    expect(buildEnv({ tool: "codex", home: "/h/c" }, { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      HOME: "/h/c",
      CODEX_HOME: "/h/c",
    });
  });

  it("sets the API key only for API-key accounts", () => {
    const login = buildEnv({ tool: "claude", home: "/h" }, base);
    expect(login.ANTHROPIC_API_KEY).toBeUndefined();
    const key = buildEnv({ tool: "claude", home: "/h", apiKey: "sk-test" }, base);
    expect(key.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(key.DEFAULT_AUTH_REQUEST).toBeUndefined();
  });

  it("asks the Codex adapter to use the API key", () => {
    const env = buildEnv({ tool: "codex", home: "/h", apiKey: "sk-test" }, base);
    expect(env.CODEX_API_KEY).toBe("sk-test");
    expect(env.DEFAULT_AUTH_REQUEST).toBe('{"methodId":"api-key"}');
    expect(buildEnv({ tool: "codex", home: "/h" }, base).DEFAULT_AUTH_REQUEST).toBeUndefined();
  });

  it("sets the git author, committer and task, a hooks folder and gc settings for this run only", () => {
    const env = buildEnv({ tool: "claude", home: "/h" }, base, {
      author: { name: "Ada", email: "ada@acme.test" },
      committer: { name: "acme-dev via majhi", email: "majhi@majhi.local" },
      task: "ACM-1",
      branches: ["task/acm-1-x", "feature/y"],
      gitDirs: ["/w/api/.git", "/w/web/.git"],
      trailer: true,
      hooks: "/m/git-hooks",
    });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@acme.test",
      GIT_COMMITTER_NAME: "acme-dev via majhi",
      GIT_COMMITTER_EMAIL: "majhi@majhi.local",
      MAJHI_TASK: "ACM-1",
      MAJHI_BRANCHES: "task/acm-1-x feature/y",
      MAJHI_GIT_DIRS: "/w/api/.git\n/w/web/.git",
      MAJHI_TRAILER: "1",
      GIT_CONFIG_COUNT: "8",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/m/git-hooks",
      GIT_CONFIG_KEY_2: "gc.pruneExpire",
      GIT_CONFIG_VALUE_2: "never",
      GIT_CONFIG_KEY_6: "core.logAllRefUpdates",
      GIT_CONFIG_VALUE_6: "always",
      GIT_CONFIG_KEY_7: "gc.packRefs",
      GIT_CONFIG_VALUE_7: "false",
    });
  });

  it("with attribution off sets the same person for both and no task or hooks", () => {
    const ada = { name: "Ada", email: "ada@acme.test" };
    const env = buildEnv({ tool: "claude", home: "/h" }, base, { author: ada, committer: ada });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: "Ada",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@acme.test",
    });
    expect(Object.keys(env).filter((k) => k === "MAJHI_TASK" || k.startsWith("GIT_CONFIG_"))).toEqual([]);
  });

  it("never sets NO_BROWSER or any SSH variable, so agents have no SSH access", () => {
    const withSocket = { ...base, SSH_AUTH_SOCK: "/run/agent.sock" } as typeof base;
    const env = buildEnv({ tool: "claude", home: "/h", apiKey: "k" }, withSocket);
    expect(Object.keys(env).filter((k) => k === "NO_BROWSER" || k.startsWith("SSH_"))).toEqual([]);
  });
});

describe("loginCommand", () => {
  it("rejects API-key accounts and never shows a key", () => {
    expect(() => loginCommand({ tool: "claude", home: "/h", apiKey: "sk-secret" }, { base })).toThrow();
    const spec = loginCommand({ tool: "claude", home: "/h" }, { base });
    expect(spec.display).not.toContain("KEY");
  });
  it("keeps the owner's claude.ai connectors and plugin MCP servers out of Claude runs", () => {
    const env = buildEnv({ tool: "claude", home: "/h" }, { PATH: "/bin" });
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS).toBe("1");
  });
});
