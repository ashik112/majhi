import { z } from "zod";
import { kebab, nameOfDir, type ScanContext } from "./context.ts";

/**
 * Files that say where a folder runs (`vercel.json`, `fly.toml`, `Procfile`): the folder is a unit that runs on that
 * platform. A folder that is also a member takes its role from its dependencies. The `crons` of `vercel.json` are timers.
 */

const Crons = z.looseObject({
  crons: z
    .array(z.looseObject({ path: z.string().optional().catch(undefined), schedule: z.string() }))
    .optional()
    .catch(undefined),
});

export function scanMarkers(ctx: ScanContext): void {
  for (const marker of ctx.scan.markers) {
    // Named for the platform too: a `wrangler.jsonc` in the root deploys one part of the repo, not the whole system.
    const name = `${nameOfDir(marker.dir, ctx.sink.repo)}-${kebab(marker.label)}`;
    ctx.sink.add({
      kind: "unit",
      name,
      role: ctx.rolesOf(marker.dir)[0] ?? "unknown",
      runsOn: marker.label,
      ports: [],
      dependsOn: [],
      basis: "declared",
      slug: kebab(name),
      cites: [{ path: marker.path, lines: [1, 1] }],
    });
    const crons = marker.located === undefined ? undefined : Crons.safeParse(marker.located.data);
    crons?.data?.crons?.forEach((cron, i) => {
      const line = marker.located?.lineOf(["crons", i]) ?? 1;
      ctx.sink.add({
        kind: "entry",
        entry: {
          type: "timer",
          schedule: cron.schedule,
          ...(cron.path === undefined ? {} : { handler: cron.path }),
        },
        basis: "declared",
        slug: `timer-${kebab(name)}-${i}`,
        cites: [{ path: marker.path, lines: [line, line] }],
      });
    });
  }
}
