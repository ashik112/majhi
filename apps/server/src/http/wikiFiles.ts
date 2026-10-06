import { type ApiError, CommitShaSchema, IdSchema } from "@majhi/shared";
import { type Context, Hono } from "hono";
import { serveSegments } from "./taskFiles.ts";

export interface WikiFilesDeps {
  /**
   * The folder of a project's source export at one commit, or undefined when the workspace has no such
   * project, its wiki is off, or that commit was never exported. The route trusts this answer for the scope
   * and checks the file path itself.
   */
  exportOf(org: string, project: string, commit: string): Promise<string | undefined>;
}

/** What the wiki never serves from an export: git's own folder and env files, which hold values. */
export function isWikiHidden(parts: readonly string[]): boolean {
  return parts.some((s) => s === ".git" || s.startsWith(".env"));
}

/**
 * `GET /api/wiki/<org>/<project>/<commit>/files/<path>`: a file of the clean source export a wiki page was
 * built from, so a source chip opens the code the claim cites at that commit. `?meta=1` and ranges work as
 * they do for task files. Nothing outside the export is served, also through symlinks.
 */
export function wikiFileRoutes(deps: WikiFilesDeps): Hono {
  const app = new Hono();
  app.get("/:org/:project/:commit/files/*", async (c: Context) => {
    const refuse = (status: 403 | 404, error: string) => c.json({ error } satisfies ApiError, status);
    const org = IdSchema.safeParse(c.req.param("org"));
    const project = IdSchema.safeParse(c.req.param("project"));
    const commit = CommitShaSchema.safeParse(c.req.param("commit"));
    if (!org.success || !project.success || !commit.success) return refuse(404, "No such wiki source.");
    const folder = await deps.exportOf(org.data, project.data, commit.data);
    if (folder === undefined) return refuse(404, "No such wiki source.");
    const prefix = `/api/wiki/${org.data}/${project.data}/${commit.data}/files/`;
    let segments: string[];
    try {
      segments = c.req.path.slice(prefix.length).split("/").map(decodeURIComponent);
    } catch {
      return refuse(404, "Not found.");
    }
    return serveSegments(c, folder, segments, "source export", isWikiHidden);
  });
  return app;
}
