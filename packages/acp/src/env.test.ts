import { afterEach, describe, expect, it } from "vitest";
import { buildEnv } from "./env.ts";
import { loginCommand } from "./login.ts";

const base = { PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "C.UTF-8", SSH_AUTH_SOCK: "/run/agent.sock" };

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
      SSH_AUTH_SOCK: "/run/agent.sock",
      HOME: "/h/a",
      CLAUDE_CONFIG_DIR: "/h/a",
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

  it("sets the git identity", () => {
    const env = buildEnv({ tool: "claude", home: "/h" }, base, { name: "Ada", email: "ada@acme.test" });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@acme.test",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@acme.test",
    });
  });

  it("never sets NO_BROWSER or other SSH variables", () => {
    const env = buildEnv({ tool: "claude", home: "/h", apiKey: "k" }, base);
    expect(
      Object.keys(env).filter((k) => k === "NO_BROWSER" || (k.startsWith("SSH_") && k !== "SSH_AUTH_SOCK")),
    ).toEqual([]);
  });
});

describe("loginCommand", () => {
  it("builds the Claude login command", () => {
    const spec = loginCommand({ tool: "claude", home: "/h/a" }, { base });
    expect(spec.command).toBe("claude-agent-acp");
    expect(spec.args).toEqual(["--cli", "auth", "login", "--claudeai"]);
    expect(spec.display).toBe("CLAUDE_CONFIG_DIR=/h/a claude-agent-acp --cli auth login --claudeai");
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe("/h/a");
  });

  it("builds the Codex login command with an adapter override", () => {
    const spec = loginCommand(
      { tool: "codex", home: "/h/c" },
      { base, adapters: { codex: { command: "node", args: ["fake.ts"] } } },
    );
    expect(spec.command).toBe("node");
    expect(spec.args).toEqual(["fake.ts", "cli", "login", "--device-auth"]);
    expect(spec.env.CODEX_HOME).toBe("/h/c");
  });

  it("rejects API-key accounts and never shows a key", () => {
    expect(() => loginCommand({ tool: "claude", home: "/h", apiKey: "sk-secret" }, { base })).toThrow();
    const spec = loginCommand({ tool: "claude", home: "/h" }, { base });
    expect(spec.display).not.toContain("KEY");
  });
});
