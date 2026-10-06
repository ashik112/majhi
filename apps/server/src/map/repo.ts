import {
  EMPTY_MAP,
  type Journey,
  JourneySchema,
  MAP_RULES,
  MapEndpointSchema,
  type MapReport,
  MapReportSchema,
  MapResolutionSchema,
  MapRoleSettingSchema,
  PRIVATE,
  type ProjectMap,
  ProjectMapSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

/** What the passes write beside the boxes and lines. `rules` says which version of the passes wrote it. */
const ExtraSchema = z.object({
  rules: z.number().int(),
  endpoints: z.array(MapEndpointSchema),
  resolutions: z.array(MapResolutionSchema),
  roles: z.array(MapRoleSettingSchema),
});

interface MapRow {
  extra: string | null;
  org: string;
  v: number;
  nodes: string;
  edges: string;
  removed: string;
  updated_at: string | null;
  report: string | null;
}

export interface StoredMap {
  map: ProjectMap;
  updatedAt?: string | undefined;
  report?: MapReport | undefined;
}

/** The stored map of each workspace, and the facts of majhi's own records the map reads (merges, tasks that changed repos together). */
export class MapRepo {
  constructor(private readonly db: Database.Database) {}

  /** A workspace's map. A row that no longer parses reads as an empty map that was never updated. */
  get(org: string): StoredMap {
    const row = this.db.prepare("SELECT * FROM project_maps WHERE org = ?").get(org) as MapRow | undefined;
    if (row === undefined) return { map: EMPTY_MAP };
    try {
      const extra = row.extra === null ? undefined : ExtraSchema.safeParse(JSON.parse(row.extra));
      // A map drawn by older rules is shown as never updated; what the owner removed still holds.
      if (extra?.success !== true || extra.data.rules !== MAP_RULES) {
        return {
          map: { ...EMPTY_MAP, removed: ProjectMapSchema.shape.removed.parse(JSON.parse(row.removed)) },
        };
      }
      const map = ProjectMapSchema.parse({
        v: row.v,
        nodes: JSON.parse(row.nodes),
        edges: JSON.parse(row.edges),
        removed: JSON.parse(row.removed),
        endpoints: extra.data.endpoints,
        resolutions: extra.data.resolutions,
        roles: extra.data.roles,
      });
      const report = row.report === null ? undefined : MapReportSchema.safeParse(JSON.parse(row.report));
      return {
        map,
        ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
        ...(report?.success === true ? { report: report.data } : {}),
      };
    } catch {
      return { map: EMPTY_MAP };
    }
  }

  save(org: string, map: ProjectMap, updatedAt: string | undefined, report: MapReport | undefined): void {
    this.db
      .prepare(
        `INSERT INTO project_maps (org, v, nodes, edges, removed, updated_at, report, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org) DO UPDATE SET v = excluded.v, nodes = excluded.nodes, edges = excluded.edges,
           removed = excluded.removed, updated_at = excluded.updated_at, report = excluded.report,
           extra = excluded.extra`,
      )
      .run(
        org,
        map.v,
        JSON.stringify(map.nodes),
        JSON.stringify(map.edges),
        JSON.stringify(map.removed),
        updatedAt ?? null,
        report === undefined ? null : JSON.stringify(report),
        JSON.stringify({
          rules: MAP_RULES,
          endpoints: map.endpoints,
          resolutions: map.resolutions,
          roles: map.roles,
        }),
      );
  }

  /** Reads, changes and writes one workspace's map in one transaction, so two owners' clicks cannot lose each other's change. */
  change(org: string, fn: (map: ProjectMap) => ProjectMap): StoredMap {
    return this.db.transaction(() => {
      const stored = this.get(org);
      const next = fn(stored.map);
      this.save(org, next, stored.updatedAt, stored.report);
      return { ...stored, map: next };
    })();
  }

  /** A workspace's journeys, oldest first. A row that no longer parses is left out. */
  journeys(org: string): Journey[] {
    const rows = this.db
      .prepare("SELECT id, name, steps, created_at FROM map_journeys WHERE org = ? ORDER BY created_at, rowid")
      .all(org) as { id: string; name: string; steps: string; created_at: string }[];
    return rows.flatMap((r) => {
      try {
        const parsed = JourneySchema.safeParse({
          id: r.id,
          name: r.name,
          steps: JSON.parse(r.steps),
          createdAt: r.created_at,
        });
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  saveJourney(org: string, journey: Journey): void {
    this.db
      .prepare(
        `INSERT INTO map_journeys (org, id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org, id) DO UPDATE SET name = excluded.name, steps = excluded.steps`,
      )
      .run(org, journey.id, journey.name, JSON.stringify(journey.steps), journey.createdAt);
  }

  /** Whether a journey of that workspace was removed. */
  removeJourney(org: string, id: string): boolean {
    return this.db.prepare("DELETE FROM map_journeys WHERE org = ? AND id = ?").run(org, id).changes > 0;
  }

  /**
   * Tasks of the workspace that were merged since `since` (all of them without it): tasks with a
   * `merge` row in the audit log that went through. A task counts once however many repos it merged.
   */
  mergesSince(org: string, since: string | undefined): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT task) AS n FROM audit
         WHERE kind = 'merge' AND decision = 'done' AND org = @org AND (@since IS NULL OR at > @since)`,
      )
      .get({ org, since: since ?? null }) as { n: number };
    return row.n;
  }

  /**
   * How many tasks of the workspace changed each pair of projects (both are repos of the task), for the pairs
   * with at least `min` tasks. Chats and the captain's own threads do not count.
   */
  togetherPairs(org: string, min: number): { a: string; b: string; tasks: number }[] {
    return this.db
      .prepare(
        `SELECT x.project AS a, y.project AS b, COUNT(*) AS tasks
         FROM task_repos x
         JOIN task_repos y ON y.task = x.task AND y.project > x.project
         JOIN tasks ON tasks.id = x.task
         WHERE tasks.kind != 'chat'
           AND (tasks.org = @org OR (@org = @private AND tasks.org IS NULL))
         GROUP BY x.project, y.project
         HAVING COUNT(*) >= @min
         ORDER BY tasks DESC, a, b`,
      )
      .all({ org, private: PRIVATE, min }) as { a: string; b: string; tasks: number }[];
  }

  /** Tasks that changed a project since `since`: ids of tasks whose repo row names it and that were updated after. */
  changedSince(org: string, since: string): { project: string; tasks: number }[] {
    return this.db
      .prepare(
        `SELECT task_repos.project AS project, COUNT(DISTINCT tasks.id) AS tasks
         FROM task_repos JOIN tasks ON tasks.id = task_repos.task
         WHERE tasks.kind != 'chat' AND tasks.updated_at > @since
           AND (tasks.org = @org OR (@org = @private AND tasks.org IS NULL))
         GROUP BY task_repos.project`,
      )
      .all({ org, private: PRIVATE, since }) as { project: string; tasks: number }[];
  }
}
