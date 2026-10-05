/**
 * Progress meter for the task lifecycle migration (docs/design/task-lifecycle.md, section 6).
 *
 * It resolves symbols with the TypeScript compiler (the native TS 7 API, `typescript/unstable/sync`),
 * not text: each tracked field or function below is located by its declaration, then the checker
 * lists every reference to it, across the server and web programs. A reference is a read or a write
 * site. Test files are left out. The total outside the lifecycle module should trend to zero.
 *
 * Run: `pnpm exec tsx scripts/census-lifecycle.ts`
 *   --files            per-file rows
 *   --json             machine output
 *   --check <file>     exit 1 if any symbol's count is above the baseline in <file>
 *   --write <file>     write the current counts as the baseline
 *
 * Limits: the compiler only sees code. Raw SQL strings (`db.prepare("UPDATE autonomy_tasks ...")`)
 * are not references, so step (c) of the plan moves those statements to the typed drizzle tables
 * first. The unstable API can change between TS releases; the repo pins typescript, so a bump
 * means rerunning this script once.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ast from "typescript/unstable/ast";
import { API, type Project } from "typescript/unstable/sync";

const ROOT = join(import.meta.dirname, "..");
const PROJECTS = ["apps/server/tsconfig.json", "apps/web/tsconfig.json"];
/** Where the new code lives. Sites in here are the model, not debt. */
const LIFECYCLE_DIRS = ["apps/server/src/tasks/lifecycle/", "packages/shared/src/lifecycle/"];

interface Tracked {
  /** What the owner reads in the table. */
  label: string;
  /** The file holding the declaration, relative to the repo root. */
  file: string;
  /** The declared name: a property, method, function or variable. */
  name: string;
  /** The declaration must sit inside a declaration with this name (class, interface, schema). */
  within?: string;
}

const TRACKED: Tracked[] = [
  {
    label: "status writes: LifecycleRows.commit",
    file: "apps/server/src/tasks/lifecycle/rows.ts",
    name: "commit",
    within: "LifecycleRows",
  },
  {
    label: "Task.pausedReason",
    file: "packages/shared/src/tasks.ts",
    name: "pausedReason",
    within: "TaskSchema",
  },
  { label: "Task.pausedBy", file: "packages/shared/src/tasks.ts", name: "pausedBy", within: "TaskSchema" },
  {
    label: "tasks.paused_reason column",
    file: "apps/server/src/store/schema.ts",
    name: "pausedReason",
    within: "tasks",
  },
  {
    label: "tasks.paused_by column",
    file: "apps/server/src/store/schema.ts",
    name: "pausedBy",
    within: "tasks",
  },
  {
    label: "tasks.start_when_ready column",
    file: "apps/server/src/store/schema.ts",
    name: "startWhenReady",
    within: "tasks",
  },
  { label: "waitsForOwner()", file: "packages/shared/src/tasks.ts", name: "waitsForOwner" },
  { label: "resumeRefusal()", file: "apps/server/src/autonomy/resume.ts", name: "resumeRefusal" },
  { label: "pausedLabel()", file: "apps/server/src/autonomy/resume.ts", name: "pausedLabel" },
  {
    label: "autonomy task held",
    file: "apps/server/src/autonomy/repo.ts",
    name: "held",
    within: "AutonomyTaskRow",
  },
  {
    label: "autonomy task heldScope",
    file: "apps/server/src/autonomy/repo.ts",
    name: "heldScope",
    within: "AutonomyTaskRow",
  },
  {
    label: "autonomy task resumedAt",
    file: "apps/server/src/autonomy/repo.ts",
    name: "resumedAt",
    within: "AutonomyTaskRow",
  },
  {
    label: "autonomy_tasks.held column",
    file: "apps/server/src/store/schema.ts",
    name: "held",
    within: "autonomyTasks",
  },
  {
    label: "autonomy_tasks.held_scope column",
    file: "apps/server/src/store/schema.ts",
    name: "heldScope",
    within: "autonomyTasks",
  },
  {
    label: "autonomy_tasks.resumed_at column",
    file: "apps/server/src/store/schema.ts",
    name: "resumedAt",
    within: "autonomyTasks",
  },
  {
    label: "AutonomyState.holds",
    file: "apps/server/src/autonomy/repo.ts",
    name: "holds",
    within: "AutonomyState",
  },
  {
    label: "QueueItem.waitFor",
    file: "packages/shared/src/autonomy.ts",
    name: "waitFor",
    within: "QueueItemSchema",
  },
  {
    label: "QueueItem.readyAt",
    file: "packages/shared/src/autonomy.ts",
    name: "readyAt",
    within: "QueueItemSchema",
  },
  { label: "AgentRun.paused", file: "apps/server/src/runs/run.ts", name: "paused", within: "AgentRun" },
  { label: "AgentRun.held", file: "apps/server/src/runs/run.ts", name: "held", within: "AgentRun" },
  { label: "budget alert resumedAt()", file: "apps/server/src/budgets/repo.ts", name: "resumedAt" },
];

function nameOf(node: ast.Node): string | undefined {
  const name = (node as { name?: ast.Node }).name;
  return name !== undefined && ast.isIdentifier(name) ? name.text : undefined;
}

/** The name node of the first declaration called `name` inside a declaration called `within`. */
function locate(project: Project, t: Tracked): ast.Node | undefined {
  const sf = project.program.getSourceFile(join(ROOT, t.file));
  if (sf === undefined) return undefined;
  let found: ast.Node | undefined;
  const visit = (node: ast.Node, inside: boolean): void => {
    if (found !== undefined) return;
    const own = nameOf(node);
    if (own === t.name && inside) {
      found = (node as { name?: ast.Node }).name;
      return;
    }
    const nowInside = inside || t.within === undefined || own === t.within;
    node.forEachChild((child) => {
      visit(child, nowInside);
    });
  };
  sf.forEachChild((child) => {
    visit(child, t.within === undefined);
  });
  return found;
}

const isTest = (file: string): boolean =>
  file.endsWith(".test.ts") ||
  file.endsWith(".test.tsx") ||
  file.includes("/testing/") ||
  file.includes("/e2e/");

interface Site {
  label: string;
  file: string;
}

function collect(): Site[] {
  const api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({ openProject: join(ROOT, PROJECTS[0] ?? "") } as never);
  const projects: Project[] = [];
  for (const p of PROJECTS) {
    const snap = p === PROJECTS[0] ? snapshot : api.updateSnapshot({ openProject: join(ROOT, p) } as never);
    const project = snap.getProject(join(ROOT, p));
    if (project !== undefined) projects.push(project);
  }
  const seen = new Set<string>();
  const sites: Site[] = [];
  for (const t of TRACKED) {
    const home = projects[0];
    const decl = home === undefined ? undefined : locate(home, t);
    if (decl === undefined) throw new Error(`census: declaration not found for "${t.label}" in ${t.file}`);
    for (const project of projects) {
      const target = locate(project, t);
      if (target === undefined) continue;
      for (const entry of project.checker.getReferencedSymbolsForNode(target, target.pos)) {
        for (const ref of entry.references) {
          const key = `${t.label}|${ref.path}|${ref.index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const file =
            ref.path.startsWith(ROOT.toLowerCase()) || ref.path.startsWith(ROOT)
              ? ref.path.slice(ROOT.length + 1)
              : ref.path;
          if (file.includes("node_modules") || isTest(file)) continue;
          sites.push({ label: t.label, file });
        }
      }
    }
  }
  api.close();
  return sites;
}

const sites = collect();
const inLifecycle = (s: Site): boolean => LIFECYCLE_DIRS.some((d) => s.file.startsWith(d));
const outside = sites.filter((s) => !inLifecycle(s));
const countBy = <K extends string>(rows: Site[], key: (s: Site) => K): Map<K, number> => {
  const m = new Map<K, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
};
const bySymbol = countBy(outside, (s) => s.label);
const filesOf = (rows: Site[]): number => new Set(rows.map((r) => r.file)).size;
const symbolCounts: Record<string, number> = Object.fromEntries(
  TRACKED.map((t) => [t.label, bySymbol.get(t.label) ?? 0]),
);

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ totalOutside: outside.length, filesOutside: filesOf(outside), symbolCounts }, null, 2),
  );
} else {
  if (process.argv.includes("--files")) {
    const perFile = new Map<string, number>();
    for (const s of sites)
      perFile.set(
        `${s.label}\t${s.file}${inLifecycle(s) ? " (lifecycle)" : ""}`,
        (perFile.get(`${s.label}\t${s.file}${inLifecycle(s) ? " (lifecycle)" : ""}`) ?? 0) + 1,
      );
    console.log("count  symbol                                file");
    for (const [k, n] of [...perFile].sort((a, b) => b[1] - a[1])) {
      const [label = "", file = ""] = k.split("\t");
      console.log(`${String(n).padStart(5)}  ${label.padEnd(36)}  ${file}`);
    }
    console.log("");
  }
  console.log("symbol                                sites");
  for (const [label, n] of Object.entries(symbolCounts).sort((a, b) => b[1] - a[1]))
    console.log(`${label.padEnd(36)}  ${String(n).padStart(5)}`);
  console.log("");
  console.log(`outside the lifecycle module: ${outside.length} sites in ${filesOf(outside)} files`);
  console.log(`inside the lifecycle module:  ${sites.length - outside.length} sites`);
}

const write = arg("--write");
if (write !== undefined) writeFileSync(write, `${JSON.stringify(symbolCounts, null, 2)}\n`);

const check = arg("--check");
if (check !== undefined) {
  const baseline = JSON.parse(readFileSync(check, "utf8")) as Record<string, number>;
  const worse = Object.entries(symbolCounts).filter(([label, n]) => n > (baseline[label] ?? 0));
  for (const [label, n] of worse) console.error(`census: ${label} rose from ${baseline[label] ?? 0} to ${n}`);
  if (worse.length > 0) process.exit(1);
}
