import { mkdir } from "node:fs/promises";
import type {
  AccountProbe,
  AccountRuntime,
  AgentSession,
  LoginSpec,
  RuntimeOptions,
  SessionStart,
} from "@majhi/acp";
import type { AccountUsage, HealthCheck, ToolId, ToolInfo } from "@majhi/shared";
import type { AcpRuntime } from "../runtime.ts";
import { FakeSession } from "./fakeSession.ts";

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
  /** What `readUsage` returns, or throws when it is an Error. Undefined means the tool reports none. */
  usage: AccountUsage | Error | undefined;
  usageReads: AccountRuntime[];
  cliVersions: Partial<Record<ToolId, string>>;
  /** Every `startSession` call. */
  starts: SessionStart[];
  /** The sessions it handed out, oldest first. */
  sessions: FakeSession[];
  /** False: a resume request opens a new session instead, like an agent without session/load. */
  resumes: boolean;
  /** While set, `startSession` waits for it: a session that is slow to open. */
  startGate: Promise<void> | undefined;
  /** Makes `startSession` reject. */
  startError: Error | undefined;
  /** Accounts, by the end of their home folder, that are signed out: their starts fail and their probes say so. */
  signedOutHomes: string[];
  /** Shapes each new session, for example to set its `script`. */
  onSession: ((session: FakeSession, start: SessionStart) => void) | undefined;
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
    usage: undefined,
    usageReads: [],
    cliVersions: { claude: "2.1.0", codex: "0.158.0" },
    starts: [],
    sessions: [],
    startGate: undefined,
    startError: undefined,
    signedOutHomes: [],
    resumes: true,
    onSession: undefined,
    async startSession(start): Promise<AgentSession> {
      runtime.starts.push(start);
      await runtime.startGate;
      if (runtime.startError !== undefined) throw runtime.startError;
      if (runtime.signedOutHomes.some((h) => start.account.home.endsWith(h)))
        throw new Error("Not logged in. Run /login");
      const resumed = runtime.resumes ? start.resume : undefined;
      const session = new FakeSession(resumed ?? `fake-session-${runtime.sessions.length + 1}`);
      session.models = {
        models: [],
        efforts: [],
        defaultModel: start.model ?? "fake-model",
        defaultEffort: start.effort ?? "medium",
      };
      runtime.onSession?.(session, start);
      runtime.sessions.push(session);
      return session;
    },
    toolInfos: () => TOOLS,
    async prepareHome(account) {
      runtime.prepared.push(account);
      await mkdir(account.home, { recursive: true, mode: 0o700 });
    },
    loginCommand: () => runtime.login,
    async probeAccount(account, options) {
      runtime.probes.push({ account, options });
      if (runtime.signedOutHomes.some((h) => account.home.endsWith(h)))
        return { ...runtime.probe, health: failedHealth("auth") };
      return runtime.probe;
    },
    async readUsage(account) {
      runtime.usageReads.push(account);
      if (runtime.usage instanceof Error) throw runtime.usage;
      return runtime.usage;
    },
    async cliVersion(tool) {
      const version = runtime.cliVersions[tool];
      if (version === undefined) throw new Error(`${tool} is not installed`);
      return version;
    },
  };
  return runtime;
}
