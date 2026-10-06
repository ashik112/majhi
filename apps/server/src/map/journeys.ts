import type { JourneyStep, ProjectMap } from "@majhi/shared";
import { UserError } from "../errors.ts";

/**
 * Checks a journey's steps against one workspace's own map. Every box must be on that map and a named
 * line must exist and join the same two boxes, so a journey can never point at another workspace's
 * projects or lines. Throws a plain reason.
 */
export function assertJourneySteps(map: ProjectMap, steps: readonly JourneyStep[]): void {
  const nodes = new Set(map.nodes.map((n) => n.id));
  const edges = new Map(map.edges.map((e) => [e.id, e]));
  steps.forEach((s, i) => {
    for (const id of [s.from, s.to]) {
      if (!nodes.has(id)) throw new UserError(`Step ${i + 1}: "${id}" is not on this workspace's map.`, 400);
    }
    if (s.edge === undefined) return;
    const line = edges.get(s.edge);
    if (line === undefined) throw new UserError(`Step ${i + 1}: that line is not on this workspace's map.`, 400);
    if (line.from !== s.from || line.to !== s.to) {
      throw new UserError(`Step ${i + 1}: that line does not go from ${s.from} to ${s.to}.`, 400);
    }
  });
}
