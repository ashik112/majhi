import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BackupListSchema,
  BudgetStatusSchema,
  type CommandName,
  ConnectionViewSchema,
  commands,
  DecisionListSchema,
  McpSearchResultSchema,
  PRIVATE,
  ProjectDeployViewSchema,
  ProjectViewSchema,
  SkillInstallResultSchema,
  SkillSearchResultSchema,
  SlotCapacitySchema,
  WatchOverviewSchema,
} from "@majhi/shared";
import { z } from "zod";
import type { Store } from "../store/index.ts";
import {
  type AccountSlots,
  type Candidate,
  type HealthCheckView,
  type Signal,
  type StaleSecret,
  skillInstallInput,
  type UpkeepPorts,
  type WatchCoverage,
} from "./upkeep-ports.ts";

/**
 * The self-upkeep chores' ports over majhi's own commands. Reads only, plus the few steps the chores
 * may take: test a connection, run a health fix, install a skill (enabled for no agent), set the
 * agent slots. Anything destructive is left to the owner.
 */

type Run = (command: CommandName, input: unknown, reason: string) => Promise<{ output: unknown }>;

/** An inbox or paused task nobody touched for this long is proposed for closing. */
const IDLE_TASK_DAYS = 14;
/** A running preview older than this is proposed for stopping. */
const OLD_PREVIEW_DAYS = 3;
/** An item that waited for the owner this long is raised again. */
const WAITING_DAYS = 7;
/** The newest backup older than this is a finding. */
const BACKUP_STALE_DAYS = 2;
/** A backup that was never verified, or not for this long, is a finding. */
const VERIFY_STALE_DAYS = 14;
/** A weekly budget this used is near its cap. */
const BUDGET_NEAR = 80;
/** A secret request unanswered this long is checked again. */
const STALE_SECRET_DAYS = 3;
const DAY_MS = 86_400_000;

/** Frameworks and services worth a search, by the dependency that shows them. */
const KNOWN = [
  "react",
  "next",
  "vue",
  "svelte",
  "express",
  "fastify",
  "prisma",
  "drizzle",
  "playwright",
  "stripe",
  "postgres",
  "redis",
  "django",
  "flask",
  "fastapi",
  "rails",
  "terraform",
  "kubernetes",
];

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Search words of one project folder: its language and the known frameworks it depends on. */
export async function projectTerms(path: string): Promise<string[]> {
  const terms: string[] = [];
  const pkg = await readFile(join(path, "package.json"), "utf8").catch(() => undefined);
  if (pkg !== undefined) {
    terms.push((await exists(join(path, "tsconfig.json"))) ? "typescript" : "node");
    try {
      const parsed = z
        .object({
          dependencies: z.record(z.string(), z.string()).optional(),
          devDependencies: z.record(z.string(), z.string()).optional(),
        })
        .parse(JSON.parse(pkg));
      const names = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
      for (const k of KNOWN)
        if (names.some((n) => n === k || n.startsWith(`${k}-`) || n.includes(`/${k}`))) terms.push(k);
    } catch {
      // A package.json that does not parse is left to the project's own checks.
    }
  }
  const files: [string, string][] = [
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["go.mod", "go"],
    ["Gemfile", "ruby"],
    ["docker-compose.yml", "docker"],
    ["Dockerfile", "docker"],
  ];
  for (const [file, term] of files) if (await exists(join(path, file))) terms.push(term);
  return terms;
}

export function upkeepWorld(deps: {
  run: Run;
  store: Store;
  now: () => Date;
  machineBusy?: (() => string | undefined) | undefined;
  wake?: ((org: string, line: string) => void) | undefined;
}): UpkeepPorts {
  const daysSince = (at: string) => (deps.now().getTime() - Date.parse(at)) / DAY_MS;

  const connections = async (org: string) =>
    z
      .array(ConnectionViewSchema)
      .parse((await deps.run("connections.list", { org }, "Upkeep: connections")).output);

  return {
    async watchCoverage(org) {
      const projects = z
        .array(ProjectViewSchema)
        .parse((await deps.run("projects.list", {}, "Upkeep: projects")).output)
        .filter((p) => p.org === org && p.exists);
      const covered: WatchCoverage["projects"] = [];
      for (const p of projects) {
        const view = ProjectDeployViewSchema.parse(
          (await deps.run("projects.deployView", { project: p.id }, "Upkeep: deploy environments")).output,
        );
        covered.push({
          id: p.id,
          environments: view.environments.map((e) => ({ env: e.env, tier: e.tier, check: e.check })),
        });
      }
      const overview = WatchOverviewSchema.parse(
        (await deps.run("watch.overview", { org }, "Upkeep: watches")).output,
      );
      return {
        projects: covered,
        watches: overview.watches.map((w) => ({
          id: w.id,
          name: w.def.name,
          kind: w.def.spec.kind,
          target: "url" in w.def.spec ? w.def.spec.url : undefined,
          paused: w.status === "paused",
        })),
        connections: (await connections(org)).map((c) => ({ id: c.id, type: c.type, name: c.name })),
        incidents: overview.incidents.slice(0, 20).map((i) => ({ title: i.title, status: i.status })),
      };
    },

    async profile(org) {
      const terms: string[] = [];
      const projects = z
        .array(ProjectViewSchema)
        .parse((await deps.run("projects.list", {}, "Upkeep: projects")).output)
        .filter((p) => p.org === org && p.exists);
      for (const p of projects) terms.push(...(await projectTerms(p.path)));
      for (const c of await connections(org)) terms.push(c.type);
      // The most shared words first: what many projects use is what helps most.
      const count = new Map<string, number>();
      for (const t of terms) count.set(t, (count.get(t) ?? 0) + 1);
      return [...count.entries()].toSorted((a, b) => b[1] - a[1]).map(([t]) => t);
    },

    async search(kind, term): Promise<Candidate[]> {
      if (kind === "mcp") {
        const found = z
          .array(McpSearchResultSchema)
          .parse((await deps.run("mcp.search", { query: `${term}`, limit: 5 }, "Upkeep: search")).output);
        return found.map((m) => ({
          kind: "mcp" as const,
          id: m.name,
          title: m.title ?? m.name,
          description: m.description,
          source: m.repository,
          installed: false,
        }));
      }
      const found = z
        .array(SkillSearchResultSchema)
        .parse((await deps.run("skills.search", { query: term, limit: 5 }, "Upkeep: search")).output);
      return found.map((s) => ({
        kind: "skill" as const,
        id: s.id,
        title: s.name,
        description: `A skill from ${s.source}`,
        source: s.source,
        installs: s.installs,
        installed: s.installed,
        install: s.install,
      }));
    },

    async installSkill(_org, skill) {
      const input = skillInstallInput(skill);
      if (input === undefined) throw new Error(`${skill.title} has no valid local skill name`);
      const preview = SkillInstallResultSchema.parse(
        (await deps.run("skills.install", input, `Upkeep: preview ${skill.title}`)).output,
      );
      const previewId = "previewId" in preview ? (preview.previewId as string | undefined) : undefined;
      if (previewId === undefined) return;
      await deps.run("skills.install", { ...input, confirm: previewId }, `Upkeep: install ${skill.title}`);
    },

    async tidy(org): Promise<Signal[]> {
      const out: Signal[] = [];
      for (const t of deps.store.tasks.list(false)) {
        if ((t.org ?? PRIVATE) !== org || t.chat === true) continue;
        if ((t.status === "inbox" || t.status === "paused") && daysSince(t.updatedAt) >= IDLE_TASK_DAYS) {
          out.push({
            key: `tidy:idle:${t.id}`,
            title: `Close ${t.id}? Nothing changed in ${Math.floor(daysSince(t.updatedAt))} days`,
            detail: `${t.title} sits in ${t.status}. Close it if it is dropped.`,
            severity: "info",
          });
        }
      }
      const boxes = (await deps.run("containers.list", {}, "Upkeep: previews")).output as {
        containers?: { task: string; name: string; kind: string; status: string; startedAt: string }[];
      };
      for (const c of boxes.containers ?? []) {
        if (c.kind === "preview" && c.status === "running" && daysSince(c.startedAt) >= OLD_PREVIEW_DAYS) {
          if ((deps.store.tasks.get(c.task)?.org ?? PRIVATE) !== org) continue;
          out.push({
            key: `tidy:preview:${c.task}:${c.name}`,
            title: `The preview ${c.name} of ${c.task} runs for ${Math.floor(daysSince(c.startedAt))} days`,
            detail: "Stop it if nobody looks at it. A stopped preview comes back with the next start.",
            severity: "info",
          });
        }
      }
      const watches = WatchOverviewSchema.parse(
        (await deps.run("watch.overview", { org }, "Upkeep: watches")).output,
      );
      for (const w of watches.watches) {
        const dead = w.status !== "paused" && w.samples24.length >= 6 && w.samples24.every((s) => !s.ok);
        if (dead) {
          out.push({
            key: `tidy:watch:${w.id}`,
            title: `The watch ${w.id} could not read its value all day`,
            detail: `${w.unavailable ?? "Every look failed"}. Fix what it watches or remove it.`,
            severity: "low",
          });
        }
      }
      const waiting = DecisionListSchema.parse(
        (await deps.run("decisions.list", { org }, "Upkeep: waiting items")).output,
      );
      for (const d of waiting.decisions) {
        if (daysSince(d.at) >= WAITING_DAYS) {
          out.push({
            key: `tidy:waiting:${d.id}`,
            title: `Still waiting for you after ${Math.floor(daysSince(d.at))} days: ${d.title}`,
            detail: "Answer it or dismiss it so it stops holding work up.",
            severity: "low",
          });
        }
      }
      return out;
    },

    async staleSecrets(org) {
      const saved = new Set(
        z
          .array(z.object({ name: z.string() }))
          .parse((await deps.run("secrets.list", {}, "Upkeep: secrets")).output)
          .map((s) => s.name),
      );
      const out: StaleSecret[] = [];
      // The oldest pending request for a secret name stays; later ones for the same name collapse into it.
      const first = new Map<string, { task: string; item: string }>();
      for (const item of deps.store.room.waitingDecisions()) {
        if (item.type !== "secret-request") continue;
        const task = deps.store.tasks.get(item.task);
        if ((task?.org ?? PRIVATE) !== org) continue;
        const older = first.get(item.name);
        if (older === undefined) first.set(item.name, { task: item.task, item: item.id });
        if (older !== undefined) {
          out.push({
            task: item.task,
            item: item.id,
            label: item.label,
            obsolete: `${older.task} already asks for the same secret:${item.name}, so one request is enough`,
          });
          continue;
        }
        if (daysSince(item.at) < STALE_SECRET_DAYS) continue;
        const obsolete =
          task === undefined || task.status === "done"
            ? "Its task is closed"
            : saved.has(item.name)
              ? `${item.name} was saved another way`
              : undefined;
        out.push({ task: item.task, item: item.id, label: item.label, obsolete });
      }
      return out;
    },

    async pendingSecrets(org) {
      return deps.store.room
        .waitingDecisions()
        .flatMap((item) =>
          item.type === "secret-request" && (deps.store.tasks.get(item.task)?.org ?? PRIVATE) === org
            ? [`${item.task}/${item.id}`]
            : [],
        );
    },

    wakeCaptain(org, line) {
      deps.wake?.(org, line);
    },

    async withdrawSecret(task, item, reason) {
      await deps.run(
        "room.approve",
        { task, item, decision: "reject", reason: `no longer needed (${reason.toLowerCase()})` },
        "Upkeep: withdraw a stale secret request",
      );
    },

    async failingConnections(org) {
      return (await connections(org))
        .filter((c) => c.lastTest?.ok === false)
        .map((c) => ({ id: c.id, name: c.name }));
    },

    async retest(connection) {
      const r = (await deps.run("connections.test", { id: connection }, "Upkeep: test again")).output;
      return commands["connections.test"].output.parse(r).ok;
    },

    async health(): Promise<HealthCheckView[]> {
      const r = commands["health.run"].output.parse(
        (await deps.run("health.run", {}, "Upkeep: health")).output,
      );
      return r.checks.map((c) => ({
        id: c.id,
        group: c.group,
        label: c.label,
        ok: c.ok,
        detail: c.detail,
        fix: c.fix,
      }));
    },

    async healthFix(id) {
      const r = commands["health.fix"].output.parse(
        (await deps.run("health.fix", { id }, `Upkeep: fix ${id}`)).output,
      );
      return { ok: r.ok, detail: r.detail, needsOwner: r.open !== undefined };
    },

    async reportBug(title, details) {
      await deps.run("captain.reportBug", { title, details }, "Upkeep: a health check fails");
    },

    async checklist(): Promise<Signal[]> {
      const out: Signal[] = [];
      const backups = BackupListSchema.parse((await deps.run("backup.list", {}, "Upkeep: backups")).output);
      if (backups.lastError !== undefined) {
        out.push({
          key: "check:backup:error",
          title: "The last backup failed",
          detail: backups.lastError.detail,
          severity: "high",
        });
      } else if (backups.lastAt === undefined || daysSince(backups.lastAt) >= BACKUP_STALE_DAYS) {
        out.push({
          key: "check:backup:old",
          title: "No recent backup",
          detail:
            backups.lastAt === undefined
              ? "majhi has no backup yet."
              : `The newest backup is ${Math.floor(daysSince(backups.lastAt))} days old.`,
          severity: "high",
        });
      }
      const verified = backups.lastVerify;
      if (verified === undefined || verified.ok === false || daysSince(verified.at) >= VERIFY_STALE_DAYS) {
        out.push({
          key: "check:backup:verify",
          title: "The backup was not checked lately",
          detail:
            verified?.ok === false
              ? `The last check failed: ${verified.detail}`
              : "A backup that was never opened may not restore.",
          severity: verified?.ok === false ? "high" : "medium",
        });
      }
      const budgets = BudgetStatusSchema.parse(
        (await deps.run("budgets.status", {}, "Upkeep: budgets")).output,
      );
      for (const row of budgets.rows) {
        if (row.percent >= BUDGET_NEAR) {
          out.push({
            key: `check:budget:${row.scope}:${row.id}`,
            title: `${row.id} used ${Math.round(row.percent)}% of its weekly budget`,
            detail: `Resets ${row.resetsAt.slice(0, 10)}. Raise the budget or slow the work down.`,
            severity: row.percent >= 100 ? "high" : "medium",
          });
        }
      }
      const health = commands["health.run"].output.parse(
        (await deps.run("health.run", {}, "Upkeep: disk")).output,
      );
      for (const c of health.checks) {
        if (c.group === "disk" && c.ok === false) {
          out.push({
            key: `check:disk:${c.id}`,
            title: c.label,
            detail: c.detail,
            severity: "medium",
          });
        }
      }
      return out;
    },

    machineBusy: () => deps.machineBusy?.(),
    async slots(): Promise<AccountSlots[]> {
      const cap = SlotCapacitySchema.parse((await deps.run("tasks.slots", {}, "Upkeep: slots")).output);
      const budgets = BudgetStatusSchema.parse(
        (await deps.run("budgets.status", {}, "Upkeep: budgets")).output,
      );
      return cap.accounts.map((a) => {
        const row = budgets.rows.find((r) => r.scope === "account" && r.id === a.account);
        return { ...a, headroom: row === undefined || (row.percent < BUDGET_NEAR && !row.paused) };
      });
    },

    async setAccountSlots(limit) {
      await deps.run("settings.set", { limits: { per_account: limit } }, "Upkeep: agents wait for a slot");
    },
  };
}
