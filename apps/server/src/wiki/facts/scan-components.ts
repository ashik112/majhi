import { kebab, type ScanContext } from "./context.ts";
import { baseOf } from "./read.ts";

/**
 * Components, folder first: every folder with a manifest (an app, a package, a service) is a component, named for
 * the folder, with the role its dependencies show. The root folder is not one: it is the repo itself, and a
 * component's folder is a path inside it.
 */
export function scanComponents(ctx: ScanContext): void {
  for (const member of ctx.scan.members) {
    if (member.dir === "") continue;
    const manifest = member.pkg?.path ?? member.py?.path ?? member.requirements[0]?.path;
    if (manifest === undefined) continue;
    const prefix = `${member.dir}/`;
    ctx.sink.add({
      kind: "component",
      name: baseOf(member.dir),
      folder: member.dir,
      role: ctx.rolesOf(member.dir)[0] ?? "unknown",
      files: ctx.scan.paths.filter((p) => p.startsWith(prefix)).length,
      basis: "declared",
      slug: kebab(member.dir),
      cites: [{ path: manifest, lines: [1, 1] }],
    });
  }
}
