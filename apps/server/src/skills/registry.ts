import type { SkillSearchResult } from "@majhi/shared";
import { z } from "zod";
import { UserError } from "../errors.ts";

/** The skills.sh directory. `GET /api/search?q=` answers JSON; `skills find` itself is interactive. */
export const SKILLS_DIRECTORY = "https://skills.sh";
const TIMEOUT_MS = 10_000;

const ResponseSchema = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      skillId: z.string().optional(),
      name: z.string(),
      installs: z.number().optional(),
    }),
  ),
});

type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export class SkillRegistry {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly base: string = SKILLS_DIRECTORY,
  ) {}

  /** Search results, most installed first. Each names its source repo so the owner can review it. */
  async search(query: string, limit: number): Promise<Omit<SkillSearchResult, "installed">[]> {
    let body: unknown;
    try {
      const res = await this.fetchFn(`${this.base}/api/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      throw new UserError(
        `Could not reach the skills.sh directory (${err instanceof Error ? err.message : "failed"}). Install by link instead.`,
      );
    }
    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success)
      throw new UserError("The skills.sh directory answered in a shape majhi does not know.");
    return parsed.data.skills.slice(0, limit).map((s) => ({
      id: s.id,
      name: s.name,
      source: s.source,
      install: { source: s.source, ...(s.skillId === undefined ? {} : { skill: s.skillId }) },
      ...(s.installs === undefined ? {} : { installs: Math.max(0, Math.trunc(s.installs)) }),
      url: `${this.base}/${s.id}`,
    }));
  }
}
