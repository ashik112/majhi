import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

describe("parseEnv", () => {
  const base = { HOST_HOME: "/home/o", MAJHI_HOME: "/home/o/.majhi" };

  it("keeps a development browser origin separate from OAuth callbacks", () => {
    const env = parseEnv({
      ...base,
      MAJHI_ORIGIN: "http://127.0.0.1:7070",
      MAJHI_BROWSER_ORIGIN: "http://127.0.0.1:5173",
    });
    expect(env.origin).toBe("http://127.0.0.1:7070");
    expect(env.browserOrigin).toBe("http://127.0.0.1:5173");
    expect(parseEnv({ ...base, MAJHI_ORIGIN: "http://127.0.0.1:7072" }).browserOrigin).toBe(
      "http://127.0.0.1:7072",
    );
    expect(() => parseEnv({ ...base, MAJHI_BROWSER_ORIGIN: "file:///tmp" })).toThrow();
  });

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
});
