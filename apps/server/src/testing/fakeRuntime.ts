import { mkdir } from "node:fs/promises";
import type { AccountProbe, AccountRuntime, LoginSpec, RuntimeOptions } from "@majhi/acp";
import type { HealthCheck, ToolId, ToolInfo } from "@majhi/shared";
import type { AcpRuntime } from "../runtime.ts";

const TOOLS: ToolInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    authModes: ["login", "api-key"],
    loginHint: "Sign in",
    apiKeyLabel: "Anthropic API key",
  },
  {
    id: "codex",
    name: "Codex",
    authModes: ["login", "api-key"],
    loginHint: "Sign in",
    apiKeyLabel: "OpenAI API key",
  },
];

export const OK_HEALTH: HealthCheck = {
  ok: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  durationMs: 5,
  steps: [
    { name: "cli", ok: true, detail: "1.0.0" },
    { name: "auth", ok: true, detail: "signed in" },
    { name: "acp", ok: true, detail: "session opened" },
  ],
};

export function failedHealth(step: "cli" | "auth" | "acp"): HealthCheck {
  return {
    ok: false,
    checkedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 5,
    steps: [{ name: step, ok: false, detail: `${step} failed` }],
  };
}

export interface FakeRuntime extends AcpRuntime {
  /** What the next probes return. */
  probe: AccountProbe;
  probes: { account: AccountRuntime; options: RuntimeOptions }[];
  prepared: AccountRuntime[];
  /** What `loginCommand` returns. */
  login: LoginSpec;
  cliVersions: Partial<Record<ToolId, string>>;
}

/** A runtime that starts nothing. Tests change `probe` and read `probes` and `prepared`. */
export function fakeRuntime(): FakeRuntime {
  const runtime: FakeRuntime = {
    probe: {
      health: OK_HEALTH,
      signedInAs: "owner@example.com",
      models: {
        models: [
          { id: "opus", name: "Opus" },
          { id: "sonnet", name: "Sonnet" },
        ],
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
        defaultModel: "sonnet",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    probes: [],
    prepared: [],
    login: {
      command: "/bin/sh",
      args: ["-c", "echo login"],
      env: { PATH: "/usr/bin:/bin" },
      display: "fake login",
    },
    cliVersions: { claude: "2.1.0", codex: "0.158.0" },
    toolInfos: () => TOOLS,
    async prepareHome(account) {
      runtime.prepared.push(account);
      await mkdir(account.home, { recursive: true, mode: 0o700 });
    },
    loginCommand: () => runtime.login,
    async probeAccount(account, options) {
      runtime.probes.push({ account, options });
      return runtime.probe;
    },
    async cliVersion(tool) {
      const version = runtime.cliVersions[tool];
      if (version === undefined) throw new Error(`${tool} is not installed`);
      return version;
    },
  };
  return runtime;
}
