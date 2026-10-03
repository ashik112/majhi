import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

describe("parseEnv", () => {
  const base = { HOST_HOME: "/home/o", MAJHI_HOME: "/home/o/.majhi" };

  it("defaults the secrets key file and passes only PATH, TMPDIR and LANG to agents, never the SSH agent socket", () => {
    const env = parseEnv({
      ...base,
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      SSH_AUTH_SOCK: "/run/ssh.sock",
      AWS_SECRET_ACCESS_KEY: "nope",
      ANTHROPIC_API_KEY: "nope",
    });
    expect(env.secretsKeyFile).toBe("/run/secrets/majhi_key");
    expect(env.runtime).toEqual({
      base: { PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "C.UTF-8" },
      adapters: {},
      usage: {},
    });
  });

  it("runs agents in runner containers unless MAJHI_RUNNER=local is set", () => {
    expect(parseEnv(base).runner.mode).toBe("container");
    expect(parseEnv({ ...base, MAJHI_RUNNER: "" }).runner.mode).toBe("container");
    expect(parseEnv({ ...base, MAJHI_RUNNER: "local" }).runner.mode).toBe("local");
  });

  it("reads the baked-in commit, and says dev when the image was built without one", () => {
    expect(parseEnv({ ...base, MAJHI_COMMIT: "abc1234" }).commit).toBe("abc1234");
    expect(parseEnv({ ...base, MAJHI_COMMIT: "" }).commit).toBe("dev");
    expect(parseEnv(base).commit).toBe("dev");
  });

  it("knows when the owner turned the SSH agent off, and only then", () => {
    const socket = "/home/o/.majhi/run/ssh-agent.sock";
    expect(parseEnv({ ...base, MAJHI_SSH_AGENT: "off" }).sshAgentOff).toBe(true);
    expect(parseEnv({ ...base, MAJHI_SSH_AGENT: socket }).sshAgentOff).toBe(false);
    expect(parseEnv({ ...base, MAJHI_SSH_AGENT: "" }).sshAgentOff).toBe(false);
    expect(parseEnv(base).sshAgentOff).toBe(false);
  });

  it("reads adapter commands as JSON arrays", () => {
    const env = parseEnv({
      ...base,
      MAJHI_ADAPTER_CLAUDE: '["node","/x/fake.ts","--tool","claude"]',
      MAJHI_SECRETS_KEY_FILE: "/k/key",
    });
    expect(env.runtime.adapters).toEqual({
      claude: { command: "node", args: ["/x/fake.ts", "--tool", "claude"] },
    });
    expect(env.secretsKeyFile).toBe("/k/key");
  });

  it("reads the Claude usage helper override", () => {
    const env = parseEnv({ ...base, MAJHI_USAGE_CLAUDE: '["node","/x/fake.ts","usage"]' });
    expect(env.runtime.usage).toEqual({ claude: { command: "node", args: ["/x/fake.ts", "usage"] } });
  });

  it("rejects an adapter that is not a JSON array of strings", () => {
    expect(() => parseEnv({ ...base, MAJHI_ADAPTER_CODEX: "codex-acp" })).toThrow(/MAJHI_ADAPTER_CODEX/);
    expect(() => parseEnv({ ...base, MAJHI_ADAPTER_CODEX: "[]" })).toThrow(/MAJHI_ADAPTER_CODEX/);
    expect(() => parseEnv({ ...base, MAJHI_ADAPTER_CODEX: "[1]" })).toThrow(/MAJHI_ADAPTER_CODEX/);
  });
});
