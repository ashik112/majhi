/**
 * The homes a spec can start from (`useHome` in fixture.ts), written before the server starts so no
 * CLI runs: `roots` is past first run with `~/Work`; `team` is what phase1.spec.ts sets up through
 * the UI; `team-api` adds the project api. The files are what majhi itself writes for them (config,
 * agent files, the account cache, the fake Claude login and secrets.age).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeAgent } from "../apps/server/src/agents/file.ts";
import { SecretStore } from "../apps/server/src/secrets/store.ts";
import {
  AccountModelsSchema,
  AccountUsageSchema,
  type Agent,
  HealthCheckSchema,
} from "../packages/shared/src/index.ts";
import { MAJHI_HOME, SECRETS_KEY_FILE } from "./paths.ts";

/** The models, efforts and usage the fake adapters report (see start-server.ts). */
const MODELS = ["fake-model-a", "fake-model-b", "fake-model-c"];
const EFFORTS = ["low", "medium", "high"];

const LOGINS = {
  "claude-personal": "private",
  "claude-acme-1": "acme",
  "claude-acme-2": "acme",
} as const;

type Fm = Agent["frontmatter"];
const AGENTS: Fm[] = [
  agent("acme-lead", "Lead", "claude-acme-1"),
  agent("acme-builder", "Builder", "claude-acme-2"),
  agent("acme-reviewer", "Reviewer", "claude-acme-1"),
  { ...agent("majhi-boss", "Root", "claude-personal"), scope: "root", where: ["anywhere"], origin: "setup" },
];
const BOSS_INSTRUCTIONS =
  "You set up and run majhi for the owner. You help create accounts, agents and tasks, and you explain what you did in plain words. Ask before you change anything that is hard to undo.";

function agent(id: string, role: Fm["role"], account: string): Fm {
  return {
    id,
    scope: "acme",
    role,
    account,
    where: ["acme"],
    perms: ["edit", "shell"],
    tools: [],
    connections: [],
    skills: [],
    origin: "owner",
  };
}

const ROOTS_YAML = "workspaces:\n  - ~/Work\n";

const TEAM_YAML = `${ROOTS_YAML}orgs:
  acme:
    name: Acme
accounts:
${Object.entries(LOGINS)
  .map(([id, org]) => `  ${id}:\n    tool: claude\n    org: ${org}\n    auth: login\n`)
  .join("")}  codex-key:
    tool: codex
    org: acme
    auth: api-key
    key: secret:codex-key
boss: majhi-boss
`;

const API_YAML = `projects:
  api:
    org: acme
    path: ~/Work/alpha-api
    aliases: [backend]
`;

/** A passed health check with the fakes' models, as `accounts.health` caches it. */
function cache(id: string, tool: "claude" | "codex") {
  const now = new Date();
  const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  const health = HealthCheckSchema.parse({
    ok: true,
    checkedAt: now.toISOString(),
    durationMs: 1500,
    steps: [
      { name: "cli", ok: true, detail: tool === "claude" ? "2.1.284 (Claude Code)" : "codex-cli 0.158.0" },
      { name: "auth", ok: true, detail: tool === "claude" ? "fake@example.com" : "API key" },
      { name: "acp", ok: true, detail: "3 models" },
    ],
  });
  const option = (v: string) => ({ id: v, name: v });
  const models = AccountModelsSchema.parse({
    account: id,
    models: MODELS.map(option),
    efforts: EFFORTS.map(option),
    defaultModel: MODELS[0],
    defaultEffort: EFFORTS[0],
    fetchedAt: now.toISOString(),
  });
  if (tool === "codex") return { health, models };
  // Read right after a sign-in: 5 hours 42 %, week 18 %, Opus 30 %, plan max.
  const usage = AccountUsageSchema.parse({
    plan: "max",
    window: { usedPct: 42, resetsAt: later(3) },
    weekly: { usedPct: 18, resetsAt: later(72) },
    models: [{ label: "Opus", usedPct: 30, resetsAt: later(72) }],
    estimated: false,
    updatedAt: now.toISOString(),
  });
  return { health, signedInAs: "fake@example.com", models, usage };
}

export async function seedHome(seed: "roots" | "team" | "team-api"): Promise<void> {
  if (seed === "roots") {
    writeFileSync(join(MAJHI_HOME, "majhi.yaml"), ROOTS_YAML);
    return;
  }
  writeFileSync(join(MAJHI_HOME, "majhi.yaml"), seed === "team-api" ? TEAM_YAML + API_YAML : TEAM_YAML);

  mkdirSync(join(MAJHI_HOME, "agents"), { recursive: true });
  for (const frontmatter of AGENTS) {
    const instructions =
      frontmatter.id === "majhi-boss" ? BOSS_INSTRUCTIONS : "Work inside the task worktree.";
    writeFileSync(
      join(MAJHI_HOME, "agents", `${frontmatter.id}.md`),
      serializeAgent({ frontmatter, instructions }),
    );
  }

  const cacheDir = join(MAJHI_HOME, "cache", "accounts");
  mkdirSync(cacheDir, { recursive: true });
  for (const id of Object.keys(LOGINS)) {
    // What the fake Claude login writes once a code is pasted (see @majhi/acp/testing).
    const home = join(MAJHI_HOME, "accounts", id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: 0 },
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify(cache(id, "claude")));
  }
  writeFileSync(join(cacheDir, "codex-key.json"), JSON.stringify(cache("codex-key", "codex")));
  await new SecretStore(MAJHI_HOME, SECRETS_KEY_FILE).set("codex-key", "sk-test-fake-0000");
}
