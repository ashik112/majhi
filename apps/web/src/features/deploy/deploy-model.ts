import {
  DEPLOY_STATE_WORD,
  type DeployRecord,
  type DeployRunStep,
  type DeployStepView,
  deployHasCommit,
  deployRunLine,
  deployStepOfRecord,
  type GitHost,
  type ProjectDeployView,
} from "@majhi/shared";
import type { DotTone } from "@/components/ui/status-dot";
import { formatAgo } from "@/lib/format";

/** The project's wiki page that says how it deploys. One place to change when the page's id is final. */
export const DEPLOY_PAGE_ID = "deploys";

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** The runs of a step in one line, in the order they go: "GitLab job build → GitLab job deploy". */
export const runsLine = (runs: readonly DeployRunStep[]): string => runs.map(deployRunLine).join(" → ");

/** The git host a run goes through, for its icon. A Vercel project or an ssh command has none. */
export function runHost(run: DeployRunStep): GitHost {
  switch (run.kind) {
    case "github-workflow":
      return "github";
    case "gitlab-job":
    case "gitlab-pipeline":
      return "gitlab";
    case "bitbucket-pipeline":
      return "bitbucket";
    case "vercel":
    case "ssh":
      return "other";
  }
}

/** The inputs of every run as "KEY=value" parts, each once, in the order they are written. */
export function inputsOf(runs: readonly DeployRunStep[]): string[] {
  const parts = runs.flatMap((run) => {
    const given =
      run.kind === "github-workflow" ? run.inputs : "variables" in run ? run.variables : undefined;
    return Object.entries(given ?? {}).map(([key, value]) => `${key}=${value}`);
  });
  return [...new Set(parts)];
}

/** The newest deploy of an environment that has started: a planned or held record has not reached it. */
export function lastReached(history: readonly DeployRecord[], env: string): DeployRecord | undefined {
  return history.find(
    (r) => r.env === env && deployHasCommit(r) && r.state !== "planned" && r.state !== "held",
  );
}

/** "5 min ago", "3 h ago", "2d ago": time since, in the unit the row has room for. */
function agoWord(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days >= 1 ? `${days}d ago` : formatAgo(iso, now);
}

export interface ReachedLook {
  tone: DotTone;
  text: string;
}

/** What the environment's row says about its newest deploy: version and time, or what went wrong. */
export function reachedLook(r: DeployRecord, now: number): ReachedLook {
  const ago = agoWord(r.finishedAt ?? r.updatedAt, now);
  switch (r.state) {
    case "live":
      return { tone: "green", text: `${shortSha(r.commit)} · ${ago}` };
    case "failed":
    case "rolled-back":
      return {
        tone: "amber",
        text: `${ago} · ${r.check?.ok === false ? "check failed" : DEPLOY_STATE_WORD[r.state]}`,
      };
    default:
      return { tone: "working", text: DEPLOY_STATE_WORD[r.state] };
  }
}

/** A step of a task's deploy plan, and whether it may be rolled back now. */
export interface PlanStep {
  view: DeployStepView;
  canRollBack: boolean;
  /** The rollback of this step is running now. */
  rollingBack: boolean;
}

/**
 * The records a rollback may start from: the newest deploy of each environment when it is live, or failed with
 * a rollback that did not work. Anything older is not where the environment stands.
 */
function rollbackRecordIds(history: readonly DeployRecord[]): Set<number> {
  const seen = new Set<string>();
  const ids = new Set<number>();
  for (const r of history) {
    if (seen.has(r.env) || r.state === "planned" || r.state === "held") continue;
    seen.add(r.env);
    // Nothing to go back to for the first deploy of an environment.
    if (r.previous === undefined) continue;
    if (r.state === "live" || (r.state === "failed" && r.rollback?.ok === false)) ids.add(r.id);
  }
  return ids;
}

/**
 * A task's deploy steps, read from the deploy views of the projects it changed: the newest record of each
 * environment that belongs to the task, in the plan's order. Nothing is stored; the views are the source.
 */
export function planStepsOf(task: string, views: readonly (ProjectDeployView | undefined)[]): PlanStep[] {
  const steps = views.flatMap((view) => {
    if (view === undefined) return [];
    const rollable = rollbackRecordIds(view.history);
    const seen = new Set<string>();
    return view.history
      .filter((r) => r.task === task)
      .flatMap((r): PlanStep[] => {
        if (seen.has(r.env)) return [];
        seen.add(r.env);
        const tier = view.environments.find((e) => e.env === r.env)?.tier;
        return [
          {
            view: deployStepOfRecord(r, tier),
            canRollBack: rollable.has(r.id) && !view.rollingBack.includes(r.id),
            rollingBack: view.rollingBack.includes(r.id),
          },
        ];
      });
  });
  return steps.sort((a, b) => (a.view.seq ?? 0) - (b.view.seq ?? 0));
}
