/**
 * A realistic majhi home for screenshots of the pages (`pnpm exec playwright test -c playwright.ui.config.ts`).
 * Writes majhi.yaml, agent files and the account cache, so no CLI runs and no tokens are spent.
 * Not used by the phase specs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeAgent } from "../apps/server/src/agents/file.ts";
import type { Agent } from "../packages/shared/src/index.ts";
import { HOST_HOME, MAJHI_HOME } from "./paths.ts";

const NOW = Date.now();
/** A time today at `hours` (14.5 is 2:30 PM), so the tables read "resets 2:30 PM" whatever time the shot is taken. */
const at = (hours: number) => {
  const d = new Date(NOW);
  d.setHours(Math.floor(hours), Math.round((hours % 1) * 60), 0, 0);
  return d.toISOString();
};
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

interface Seed {
  tool: "claude" | "codex";
  org: string;
  /** Percent used in the current window and the week; absent means no usage read yet. */
  window?: [number, number];
  week?: number;
  opus?: number;
  health?: "ok" | "signed-out";
}

const ACCOUNTS: Record<string, Seed> = {
  "claude-personal": { tool: "claude", org: "private", window: [22, 14.17], week: 31, health: "ok" },
  "claude-globex": { tool: "claude", org: "globex", window: [64, 13.5], week: 48, opus: 61, health: "ok" },
  "claude-globex-2": { tool: "claude", org: "globex", window: [12, 16.08], week: 20, health: "ok" },
  "codex-acme": { tool: "codex", org: "acme", window: [71, 13.83], week: 55, health: "ok" },
  "claude-acme": { tool: "claude", org: "acme", window: [5, 17.33], week: 9, health: "ok" },
  "claude-northwind": { tool: "claude", org: "northwind", window: [100, 15.67], week: 83, health: "ok" },
  "codex-northwind": { tool: "codex", org: "northwind", window: [18, 16.5], week: 26, health: "ok" },
  "claude-legacy": { tool: "claude", org: "globex", health: "signed-out" },
};

const ORGS = `orgs:
  globex:
    name: Globex
    color: "#8ab8f5"
    key: GLX
    base: develop
    identity:
      name: Ashik
      email: ashik@globex.example
  acme:
    name: Acme
    color: "#f0b455"
    key: ACM
  northwind:
    name: Northwind
    color: "#c3a6f5"
    key: NW
    base: main
`;

function accountsYaml(): string {
  const lines = ["accounts:"];
  for (const [id, a] of Object.entries(ACCOUNTS)) {
    lines.push(`  ${id}:`, `    tool: ${a.tool}`, `    org: ${a.org}`, "    auth: login");
  }
  return `${lines.join("\n")}\n`;
}

const PROJECTS = `projects:
  alpha-api:
    org: globex
    path: ~/Work/alpha-api
    aliases: [api, backend]
    base: develop
  beta-web:
    org: acme
    path: ~/Work/beta-web
    aliases: [web]
  gamma-infra:
    org: northwind
    path: ~/Work/ops/gamma-infra
`;

function step(name: "cli" | "auth" | "acp" | "model", ok: boolean, detail: string) {
  return { name, ok, detail };
}

function cache(id: string, a: Seed) {
  const ok = a.health !== "signed-out";
  const health = {
    ok,
    checkedAt: ago(2),
    durationMs: 1400,
    steps: ok
      ? [
          step("cli", true, "claude 2.1.0"),
          step("auth", true, `${id}@example.com`),
          step("acp", true, "session opened"),
        ]
      : [step("cli", true, "claude 2.1.0"), step("auth", false, "Not signed in")],
  };
  const models = {
    account: id,
    models:
      a.tool === "claude"
        ? [
            { id: "opus-5.5", name: "Opus 5.5" },
            { id: "sonnet-5.5", name: "Sonnet 5.5" },
            { id: "haiku-4.5", name: "Haiku 4.5" },
          ]
        : [
            { id: "gpt-5.5", name: "GPT-5.5" },
            { id: "gpt-5.5-mini", name: "GPT-5.5 mini" },
          ],
    efforts: [
      { id: "low", name: "Low" },
      { id: "medium", name: "Medium" },
      { id: "high", name: "High" },
    ],
    defaultModel: a.tool === "claude" ? "sonnet-5.5" : "gpt-5.5",
    defaultEffort: "medium",
    fetchedAt: ago(2),
  };
  const usage =
    a.window && ok
      ? {
          plan: "max",
          window: { usedPct: a.window[0], resetsAt: at(a.window[1]) },
          ...(a.week === undefined
            ? {}
            : { weekly: { usedPct: a.week, resetsAt: new Date(NOW + 72 * 3_600_000).toISOString() } }),
          models: a.opus === undefined ? [] : [{ label: "Opus", usedPct: a.opus, resetsAt: at(72) }],
          estimated: false,
          updatedAt: ago(2),
        }
      : undefined;
  return { health, ...(ok ? { signedInAs: `${id}@example.com`, models } : {}), ...(usage ? { usage } : {}) };
}

type Fm = Agent["frontmatter"];
function agent(
  id: string,
  scope: string,
  role: Fm["role"],
  account: string,
  model: string,
  extra: Partial<Fm> = {},
  instructions = "Work only inside the task worktree. Small commits with the task key in the message. Run the project's tests, then @mention the reviewer.",
): [string, string] {
  const frontmatter: Fm = {
    id,
    scope,
    role,
    account,
    model,
    where: scope === "root" ? ["anywhere"] : [scope],
    perms: ["edit", "shell"],
    tools: [],
    connections: [],
    skills: [],
    origin: "setup",
    ...extra,
  };
  return [id, serializeAgent({ frontmatter, instructions })];
}

export function seedUiHome(): void {
  mkdirSync(join(MAJHI_HOME, "agents"), { recursive: true });
  mkdirSync(join(MAJHI_HOME, "cache", "accounts"), { recursive: true });
  writeFileSync(
    join(MAJHI_HOME, "majhi.yaml"),
    `workspaces:\n  - ~/Work\n  - ~/Projects\nboss: setup\n${ORGS}${accountsYaml()}${PROJECTS}`,
  );
  const agents = [
    agent(
      "setup",
      "root",
      "Root",
      "claude-personal",
      "opus-5.5",
      { perms: ["edit", "shell"] },
      "Scan ~/Work and ~/.ssh/config. Draft orgs, accounts and agents, and never write config without my confirmation.",
    ),
    agent("dispatcher", "root", "Lead", "claude-personal", "sonnet-5.5", { origin: "owner" }),
    agent("housekeeper", "root", "Root", "claude-personal", "haiku-4.5", { origin: "owner" }),
    agent("globex-lead", "globex", "Lead", "claude-globex", "opus-5.5", {
      perms: ["shell", "mr"],
      fallback: "globex-builder-2",
    }),
    agent("globex-builder", "globex", "Builder", "claude-globex", "sonnet-5.5", {
      perms: ["edit", "shell", "push"],
      fallback: "globex-builder-2",
    }),
    agent("globex-builder-2", "globex", "Builder", "claude-globex-2", "sonnet-5.5"),
    agent("globex-reviewer", "globex", "Reviewer", "claude-globex-2", "haiku-4.5", { perms: [] }),
    agent("acme-lead", "acme", "Lead", "codex-acme", "gpt-5.5", { effort: "high" }),
    agent("acme-builder", "acme", "Builder", "codex-acme", "gpt-5.5", { effort: "medium" }),
    agent("nw-lead", "northwind", "Lead", "claude-northwind", "opus-5.5"),
    agent("nw-builder", "northwind", "Builder", "codex-northwind", "gpt-5.5", { origin: "owner" }),
  ];
  for (const [id, text] of agents) writeFileSync(join(MAJHI_HOME, "agents", `${id}.md`), text);
  // A file that does not load, so the errors group shows up.
  writeFileSync(join(MAJHI_HOME, "agents", "broken.md"), "---\nrole: Builder\n---\nNo id here.\n");
  for (const [id, a] of Object.entries(ACCOUNTS)) {
    writeFileSync(join(MAJHI_HOME, "cache", "accounts", `${id}.json`), JSON.stringify(cache(id, a)));
  }
  void HOST_HOME;
}
