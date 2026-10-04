import { detectSecrets } from "@majhi/shared";
import type { ShipCheck } from "../captain/ports.ts";
import { mergeConflicts } from "../git/merge.ts";
import type { MrService } from "../mrs/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";

/**
 * The cheap checks of a task in review, read live each time: it is in review and no agent works in
 * it, no card waits for the owner, it changes no protected repo, something changed, it is committed,
 * it merges cleanly into its base, and the diff holds no secret. The ship chore, the captain's lane
 * and the checked hand-off all read the same answer (SPEC 5.18, "One way to ship").
 *
 * A reason only the owner can clear (a card waits, a protected repo) carries `owner`: the lead is not
 * told about it.
 */

export interface ReadyDeps {
  store: Pick<Store, "tasks" | "room">;
  room: Pick<RoomService, "flush">;
  runs: { working(task: string): string[] };
  mrs: Pick<MrService, "shipOptions">;
  tasks: Pick<TaskService, "diff">;
}

const WAITING = ["approval", "ask", "choice", "owner-question", "secret-request", "permission"] as const;

export async function shipReadiness(deps: ReadyDeps, id: string): Promise<ShipCheck> {
  const { store } = deps;
  const task = store.tasks.get(id);
  if (task === undefined || task.status !== "review")
    return { ready: false, why: "it is not in review", owner: true };
  if (deps.runs.working(id).length > 0)
    return { ready: false, why: "an agent is still working", owner: true };
  deps.room.flush(id);
  const waiting = WAITING.find((type) => store.room.pendingOfType(id, type).length > 0);
  if (waiting !== undefined)
    return { ready: false, why: `a ${waiting.replace("-", " ")} card waits for you`, owner: true };
  const options = await deps.mrs.shipOptions(id);
  if ((options.protected ?? []).length > 0) {
    return { ready: false, why: "it changes a protected repo, which only you ship", owner: true };
  }
  const changed = options.changed ?? [];
  if (changed.length === 0) return { ready: false, why: "nothing changed since it started", owner: true };
  if (!options.merge.ok) return { ready: false, why: options.merge.why ?? "it cannot merge now" };
  // Merges cleanly means git says so now, not that something is ahead: main may have moved since.
  for (const c of changed) {
    const repo = task.repos.find((r) => r.project === c.project);
    if (repo === undefined) continue;
    const conflicts = await mergeConflicts(repo.source, repo.branch, c.base).catch(() => []);
    if (conflicts.length > 0) {
      const listed = `${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? " and more" : ""}`;
      return { ready: false, why: `it conflicts with ${c.base} in ${listed}`, conflict: true };
    }
  }
  const diffs = await deps.tasks.diff(id);
  for (const d of diffs) {
    if (d.error !== undefined)
      return { ready: false, why: `the diff of ${d.project} could not be read`, owner: true };
    if (d.uncommitted) return { ready: false, why: `${d.project} has uncommitted changes` };
    if (d.omitted > 0 || d.files.some((f) => f.truncated)) {
      return { ready: false, why: `the diff of ${d.project} is too large to check for secrets`, owner: true };
    }
    const added = d.files
      .flatMap((f) => f.patch.split("\n"))
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .join("\n");
    if (detectSecrets(added).length > 0)
      return { ready: false, why: `the diff of ${d.project} holds what looks like a secret` };
  }
  const into = [...new Set(changed.map((c) => c.base))].join(", ");
  return {
    ready: true,
    evidence: `committed, merges cleanly into ${into}, no card waits, no secret in the diff`,
    targets: changed.map((c) => ({ project: c.project, into: c.base, base: c.base })),
  };
}
