import type { CommandName } from "@majhi/shared";
import { pageRef } from "@majhi/shared";
import { shipAsked } from "../ship/plan.ts";
import { shipState } from "./keys.ts";
import type { CaptainPorts } from "./ports.ts";
import type { CaptainRepo, KeyClaim } from "./repo.ts";
import { branchAllowed } from "./rules.ts";
import type { Workspace } from "./runner.ts";

/**
 * One way to ship (SPEC 5.18, "One rule set"). The ship chore and the captain's lane both merge,
 * and both go through here: the same readiness checks (committed, merges cleanly, no card waits, no
 * secret in the diff, not a protected repo), the same branches the workspace ships to, the same
 * key per task, heads and bases, so a state that was shipped or asked for is not shipped again (G1).
 * The chore calls the ports directly with the same rules; the lane's calls are checked here before
 * they run and logged here after, in the same log, so the key holds for both.
 * Registering a repo is the same: the lane may register only what the projects chore would.
 */

/** The commands of the lane that ship, and count as one ship each. */
export const SHIP_COMMANDS: ReadonlySet<string> = new Set([
  "tasks.merge",
  "tasks.mergeMrs",
  "tasks.resolveShip",
]);

export interface LaneGateDeps {
  repo: CaptainRepo;
  ports: Pick<CaptainPorts, "reviewTasks" | "shipCheck" | "newRepos" | "shipPlan"> &
    Partial<Pick<CaptainPorts, "shipFailed">>;
  workspace(org: string): Promise<Workspace | undefined>;
  now(): Date;
}

export class LaneGate {
  /** The key each checked call will have in the log, kept until the call ran: the task leaves review when it ships. */
  private readonly keys = new Map<string, string>();

  constructor(private readonly deps: LaneGateDeps) {}

  /** Whether a lane call is one this gate checks. */
  covers(command: CommandName | string): boolean {
    return SHIP_COMMANDS.has(command) || command === "projects.register";
  }

  /** Why the lane may not make this call now, or undefined. */
  async check(org: string, command: string, input: Record<string, unknown>): Promise<string | undefined> {
    if (command === "projects.register") return this.register(org, input);
    if (!SHIP_COMMANDS.has(command)) return undefined;
    const ws = await this.deps.workspace(org);
    if (ws === undefined) return undefined;
    const id = typeof input.id === "string" ? input.id : undefined;
    if (id === undefined) return undefined;
    // The chore's own decision: who does the merge here, and how the work lands.
    const plan = await this.deps.ports.shipPlan(org, id);
    if (plan.steps.merge !== "captain") return `Refused: ${shipAsked("merge", ws.name, plan)}.`;
    if (command === "tasks.merge" && plan.way === "merge-request") {
      return `Refused: ${id} works through merge requests. Open one with tasks.openMrs, and the captain merges it once it is green.`;
    }
    const key = await this.keyOf(org, command, id, ws.day);
    this.keys.set(`${command}:${id}`, key);
    const early = this.deps.repo.keyState(key, this.deps.now().toISOString());
    if (early !== "free") return this.repeatText(command, id, early);
    if (command === "tasks.merge") {
      // The chore's own checks, so the lane cannot ship what the chore would leave.
      const check = await this.deps.ports.shipCheck(org, id);
      if (!check.ready) return `Refused: ${id} is not ready to ship: ${check.why}.`;
      const into = typeof input.into === "string" ? input.into : undefined;
      const targets = (input.targets ?? {}) as Record<string, string>;
      const outside = check.targets.filter(
        (t) => !branchAllowed(ws.rules, targets[t.project] ?? into ?? t.into, t.base),
      );
      if (outside.length > 0) {
        return `Refused: ${[...new Set(outside.map((o) => targets[o.project] ?? into ?? o.into))].join(", ")} is not a branch ${ws.name} ships to.`;
      }
    }
    // The key is taken in one insert, after the checks, so two calls for one state cannot both ship.
    // It is given back when the call fails (`ran`) and its log line holds it when the call worked.
    const claim = this.claim(key, id);
    return claim === "taken" ? undefined : this.repeatText(command, id, claim);
  }

  /** Takes the key of a ship: `taken`, or why not (done before, or running now). Typed. */
  claim(key: string, task: string): KeyClaim {
    return this.deps.repo.claimKey("ship", key, task, this.deps.now().toISOString());
  }

  private repeatText(command: string, id: string, why: "repeat" | "in-flight"): string {
    if (why === "in-flight") {
      return `Refused: ${id} is being ${command === "tasks.resolveShip" ? "sent to its lead" : "shipped"} by another call in this state. Wait for it.`;
    }
    return `Refused: ${id} was already ${command === "tasks.resolveShip" ? "sent to its lead to resolve" : "shipped or handed over"} in this state. Change something first, or leave it for the owner.`;
  }

  /** The lane's call ran: it counts as one ship in the chore's log, so the cap and the key hold for both. */
  async ran(
    org: string,
    command: string,
    input: Record<string, unknown>,
    reason: string,
    outcome: { ok: boolean; error?: string | undefined },
  ): Promise<void> {
    if (!SHIP_COMMANDS.has(command)) return;
    const ws = await this.deps.workspace(org);
    const id = typeof input.id === "string" ? input.id : undefined;
    if (ws === undefined || id === undefined) return;
    const at = this.deps.now().toISOString();
    const key = this.keys.get(`${command}:${id}`) ?? (await this.keyOf(org, command, id, ws.day));
    this.keys.delete(`${command}:${id}`);
    const verb = command === "tasks.resolveShip" ? "Asked the lead of" : "Shipped";
    this.deps.repo.addAction({
      key: outcome.ok ? key : `${key}:failed:${at}`,
      org,
      chore: "ship",
      day: ws.day,
      at,
      text: outcome.ok
        ? `${verb} ${id} from the captain's lane`
        : `${command === "tasks.resolveShip" ? `Asking the lead of ${id} to resolve failed` : `Ship failed for ${id}`}: ${outcome.error ?? "it did not go"}`,
      reason: reason === "" ? `In ${ws.name} the captain decides when work is merged` : reason,
      task: id,
      outcome: outcome.ok ? "done" : "failed",
      undoNote: "Shipped by the captain's own call: revert it from the task if needed",
    });
    if (!outcome.ok && command !== "tasks.resolveShip") {
      await this.deps.ports.shipFailed?.(org, id, outcome.error ?? "it did not go").catch(() => undefined);
    }
    // The log line holds the key now; after a failure the key is free to try again.
    this.deps.repo.releaseKey(key);
  }

  /** The key a ship of this task in this state has in the log: the chore's key for a merge. */
  private async keyOf(org: string, command: string, id: string, day: string): Promise<string> {
    // Not in review (a resolve of a done task): the day stands for its state.
    const found = (await this.deps.ports.reviewTasks(org)).find((t) => t.id === id);
    const heads = found === undefined || found.heads === "" ? `day:${day}` : shipState(found);
    if (command === "tasks.resolveShip") return `ship:resolve:${id}:${heads}`;
    if (command === "tasks.mergeMrs") return `ship:mrs:${id}:${heads}`;
    return `ship:${id}:${heads}`;
  }

  /** The lane registers only what the projects chore would: a repo of the workspace's folder, not yet registered. */
  private async register(org: string, input: Record<string, unknown>): Promise<string | undefined> {
    const path = typeof input.path === "string" ? input.path : undefined;
    const repos = await this.deps.ports.newRepos(org);
    if (path !== undefined && repos.some((r) => r.path === path)) return undefined;
    const listed = repos.map((r) => r.path).slice(0, 5);
    return listed.length === 0
      ? `Refused: no unregistered repo sits in this workspace's folder, so there is nothing to register. Which repos agents reach is the owner's, on ${pageRef("projects")}.`
      : `Refused: ${path ?? "that path"} is not an unregistered repo in this workspace's folder. These are: ${listed.join(", ")}.`;
  }
}
