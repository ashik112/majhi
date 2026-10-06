import { FRAMEWORK_ROLES, kebab, type ScanContext } from "./context.ts";
import { depsOf } from "./deps.ts";
import { storeOfNpm, storeOfPython, techsOfDep } from "./known.ts";
import { addStore } from "./stores.ts";

/**
 * Dependencies of every member of the repo (the root and each workspace member): a framework is a role (React is a
 * frontend, Django a backend, Celery a worker), a sign-in library is auth, an SDK is an outside service, and a client
 * library for a datastore is a use of that store. Development dependencies are build tools, so only frameworks count.
 */
export function scanMembers(ctx: ScanContext): void {
  for (const member of ctx.scan.members) {
    const where = member.dir === "" ? "." : member.dir;
    for (const dep of depsOf(member)) {
      const cite = { path: dep.path, lines: [dep.line, dep.line] as [number, number] };
      for (const t of techsOfDep(dep.name, dep.python)) {
        if (dep.dev && !FRAMEWORK_ROLES.has(t.role)) continue;
        if (t.role === "database" || t.role === "cache" || t.role === "queue") continue;
        ctx.sink.add({
          kind: "role",
          role: t.role,
          where,
          tech: t.tech,
          basis: "declared",
          slug: `${t.role}-${kebab(t.tech)}-${kebab(where)}`,
          cites: [cite],
        });
      }
      const store = dep.python ? storeOfPython(dep.name) : storeOfNpm(dep.name);
      if (store !== undefined && !dep.dev) addStore(ctx, { store, basis: "declared", cite, where });
    }
  }
}
