import {
  buildTrail,
  CHAT_APP_LABEL,
  type ChildFact,
  type DeployAsk,
  type DeployStepView,
  type HandoffState,
  handoffNoChanges,
  type OriginView,
  type ShipView,
  type Task,
  type TaskDetail,
  type TrailFacts,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import { opensMergeRequest, type ShipPlan } from "../ship/plan.ts";
import type { Store } from "../store/index.ts";
import type { AreasReader } from "./areas.ts";

export interface DetailDeps {
  store: Pick<Store, "tasks" | "room" | "client">;
  areas: AreasReader;
  /** The hand-off state of a task: its check of the current head and what the check is doing now. */
  handoff(id: string): Promise<HandoffState>;
  /** Who does each step of shipping a task, by the one ship decision. */
  ship(id: string): Promise<ShipPlan>;
  /** The ids of a workspace's projects. */
  projectsOf(org: string): Promise<string[]>;
  /** What happens to each deploy target of the projects the task changed, and the question for the owner. */
  deploys?: { describe(task: Task): Promise<{ steps: readonly DeployStepView[]; ask?: DeployAsk }> };
}

/** The check of a task as the trail shows it: running or queued, else the result for the current head. Nothing when there is none. */
export function checkFacts(state: HandoffState): TrailFacts["check"] {
  if (state.activity !== undefined) return { result: state.activity.phase };
  const current = state.current;
  if (current === undefined || state.stale) return undefined;
  // Nothing changed, so nothing was checked: no tick for it.
  if (handoffNoChanges(current.steps)) return undefined;
  return current.verdict === "green"
    ? { result: "green" }
    : { result: "red", ...(current.failed === undefined ? {} : { failedStep: current.failed.step }) };
}

/** The facts a trail is made of, for one task: what its repos and links hold now. */
export function trailFactsOf(task: Task, children: readonly ChildFact[]): Omit<TrailFacts, "check"> {
  return {
    children,
    mrs: task.repos.flatMap((r) =>
      r.mr === undefined
        ? []
        : [{ project: r.project, number: r.mr.number, url: r.mr.url, state: r.mr.state, ci: r.mr.ci }],
    ),
    merged: task.repos.filter((r) => r.shipped !== undefined).map((r) => r.project),
    pendingShip:
      task.pendingShip === undefined
        ? []
        : task.pendingShip.targets === undefined
          ? task.repos.map((r) => r.project)
          : Object.keys(task.pendingShip.targets),
  };
}

/**
 * The step of shipping that waits for the owner in a task in review: the merge when it is theirs, or the
 * push when the project works through merge requests and the captain would merge but may not push.
 * Undefined when the captain does the next step, or the task changed no code.
 */
export function ownerStepOf(
  task: Task,
  plan: Pick<ShipPlan, "steps" | "way" | "waits">,
): "merge" | "push" | undefined {
  if (!task.repos.some((r) => r.writes !== false)) return undefined;
  // The captain's merge waits for the deploy plan: that is its own step, not one the owner is waited for.
  if (plan.waits !== undefined) return undefined;
  if (plan.steps.merge === "owner") return opensMergeRequest(plan) ? undefined : "merge";
  return plan.way === "merge-request" && plan.steps.push === "owner" ? "push" : undefined;
}

function shipView(plan: ShipPlan): ShipView {
  const { steps } = plan;
  return {
    merge: steps.merge,
    push: steps.push,
    deployStaging: steps.deployStaging,
    deployProduction: steps.deployProduction,
    tell: steps.tell,
    way: plan.way,
    ...(plan.ruleSubject === undefined ? {} : { rule: plan.ruleSubject }),
    ...(plan.waits === undefined ? {} : { waits: plan.waits }),
  };
}

/**
 * The single read of a task for its page: where it came from, the parts of the system it touches and
 * its whole trail, with each child listed and the hand-off check joined in.
 */
export class TaskDetails {
  constructor(private readonly deps: DetailDeps) {}

  /** A client origin reads "Telegram · Acme ops · Sara": the app, the room and who wrote. */
  private withSender(origin: OriginView | undefined): OriginView | undefined {
    if (origin?.kind !== "client") return origin;
    const { store } = this.deps;
    const item = store.room.get(origin.room, origin.item);
    const app = store.client.room(origin.room)?.chat.app;
    const parts = [
      app === undefined ? undefined : CHAT_APP_LABEL[app],
      origin.name,
      item?.type === "client" ? item.sender.name : undefined,
    ].filter((p): p is string => p !== undefined && p !== "");
    return parts.length === 0
      ? origin
      : { ...origin, from: parts.join(" · "), ...(app === undefined ? {} : { app }) };
  }

  async detail(id: string): Promise<TaskDetail> {
    const { store } = this.deps;
    const task = store.tasks.get(id);
    if (task === undefined) throw new UserError(`Task ${id} does not exist.`, 404);
    const facts = store.tasks.statusFacts();
    const children: ChildFact[] = store.tasks.children(id).flatMap((child) => {
      const f = facts.get(child);
      return f === undefined ? [] : [{ id: child, ...f }];
    });
    const [areas, state] = await Promise.all([
      this.deps.areas.of(task),
      this.deps.handoff(id).catch(() => undefined),
    ]);
    const check = state === undefined ? undefined : checkFacts(state);
    const origin = this.withSender(store.tasks.originView(id));
    const plan =
      task.status === "review" || task.status === "mr"
        ? await this.deps.ship(id).catch(() => undefined)
        : undefined;
    // A task that changed no code has nothing to merge: no merge step waits for the owner.
    const nothingToMerge =
      state?.current !== undefined && !state.stale && handoffNoChanges(state.current.steps);
    const owner =
      plan === undefined || task.status !== "review" || nothingToMerge ? undefined : ownerStepOf(task, plan);
    const deployed = await this.deps.deploys?.describe(task).catch(() => undefined);
    return {
      task: id,
      ...(origin === undefined ? {} : { origin }),
      areas,
      trail: buildTrail({
        ...trailFactsOf(task, children),
        ...(check === undefined ? {} : { check }),
        ...(owner === undefined ? {} : { owner }),
        ...(plan?.waits === undefined || task.status !== "review" ? {} : { planWait: true }),
        ...(deployed === undefined ? {} : { deploys: deployed.steps }),
      }),
      ...(plan === undefined ? {} : { ship: shipView(plan) }),
      ...(deployed?.ask === undefined ? {} : { deployAsk: deployed.ask }),
    };
  }

  /** The names of the parts of the system a workspace's projects have, for the ship rules' area picker. */
  async areaNames(org: string): Promise<string[]> {
    return this.deps.areas.componentNames(org, await this.deps.projectsOf(org));
  }

  /** The areas of the tasks on a board, a few at a time. Ids that do not exist are left out. */
  areas(ids: readonly string[]) {
    return this.deps.areas.many(ids.flatMap((id) => this.deps.store.tasks.get(id) ?? []));
  }
}
