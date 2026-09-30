/**
 * Merge order of a multi-repo task (SPEC 5.5). A project that others depend on merges first;
 * projects with no link between them keep the order the task lists its repos in.
 */

/** Project id to the ids it `depends-on`. Projects with no links may be missing. */
export type ProjectGraph = ReadonlyMap<string, readonly string[]>;

/** The project links form a loop, so there is no order that puts every dependency first. */
export class MergeOrderCycle extends Error {
  constructor(readonly path: readonly string[]) {
    super(`The project links form a loop: ${path.join(" -> ")}. Remove one link.`);
  }
}

/**
 * A path that leads from `from` back to `target` along `depends-on` links, or undefined.
 * `[from, ..., target]`. With `from === target` and one step it is a self-link.
 */
export function pathBetween(graph: ProjectGraph, from: string, target: string): string[] | undefined {
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | undefined => {
    for (const next of graph.get(at) ?? []) {
      if (next === target) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(from, [from]);
}

/**
 * The task's projects, dependencies first. Dependencies count through projects the task does not
 * touch (A depends on C depends on B puts B before A). Ties keep the task's own order.
 * Throws `MergeOrderCycle` when a project depends on itself, directly or through others.
 */
export function mergeOrder(projects: readonly string[], graph: ProjectGraph): string[] {
  const unique = [...new Set(projects)];
  for (const p of unique) {
    const loop = pathBetween(graph, p, p);
    if (loop !== undefined) throw new MergeOrderCycle(loop);
  }
  // `before.get(a)` holds the task projects that must merge before `a`.
  const before = new Map(
    unique.map((a) => [a, unique.filter((b) => b !== a && pathBetween(graph, a, b) !== undefined)] as const),
  );
  const out: string[] = [];
  const left = new Set(unique);
  while (left.size > 0) {
    const next = unique.find((p) => left.has(p) && (before.get(p) ?? []).every((b) => !left.has(b)));
    // Cannot happen without a cycle, which was refused above.
    if (next === undefined) throw new MergeOrderCycle([...left]);
    out.push(next);
    left.delete(next);
  }
  return out;
}

/** Whether `order` puts a project before something it depends on. Empty when it does not. */
export function orderViolations(order: readonly string[], graph: ProjectGraph): string[] {
  const out: string[] = [];
  order.forEach((a, i) => {
    for (const b of order.slice(i + 1)) {
      if (pathBetween(graph, a, b) !== undefined) out.push(`${a} depends on ${b}, but merges first`);
    }
  });
  return out;
}
