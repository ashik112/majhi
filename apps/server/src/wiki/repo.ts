import {
  CommitShaSchema,
  type OwnerAnswer,
  type OwnerCallAnswer,
  type OwnerRoleAnswer,
  RepoPathSchema,
  type WikiAnswer,
  WikiAnswerSchema,
  type WikiPage,
  type WikiPageId,
  WikiPageIdSchema,
  WikiPageSchema,
  type WikiPageSummary,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import { WikiPlanSchema } from "./plan.ts";
import { applyRoleChoices } from "./roles.ts";
import { endpointId } from "./system/address.ts";

export const WikiGapsSchema = z.object({
  couldNot: z
    .array(z.object({ page: WikiPageIdSchema, topic: z.string().max(300), why: z.string().max(600) }))
    .max(400),
  failed: z.array(z.object({ page: WikiPageIdSchema, problem: z.string().max(600) })).max(100),
});
export type WikiGaps = z.infer<typeof WikiGapsSchema>;

/** What an update leaves per project besides the pages: where it got to, and which files each page was written from. */
export const WikiStateSchema = z.object({
  /** The commit the pages were built from. Absent: never built. */
  builtCommit: CommitShaSchema.optional(),
  /** Page to the repo files it was written from. A page is rewritten when one of these changes. */
  sources: z.record(WikiPageIdSchema, z.array(RepoPathSchema).max(5000)),
  /** The `WIKI_RULES` of the last update. */
  rules: z.number().int().nonnegative(),
  /** The main flows chosen at the first build. Absent: not chosen yet. */
  plan: WikiPlanSchema.optional(),
  /** What the writer could not settle, and the pages it could not write, per page. A page written again replaces its own. */
  gaps: WikiGapsSchema.default({ couldNot: [], failed: [] }),
  lastError: z.string().max(500).optional(),
  updatedAt: z.string().optional(),
});
export type WikiState = z.infer<typeof WikiStateSchema>;

export const EMPTY_WIKI_STATE: WikiState = { sources: {}, rules: 0, gaps: { couldNot: [], failed: [] } };

/** The `project` of the state row of a workspace's own pages. A project id is never empty, so it cannot be one. */
export const WORKSPACE_STATE = "";

/** One question the owner answered, as the row's key: a later answer to the same question has the same key. */
export function answerKey(a: WikiAnswer): string {
  switch (a.kind) {
    case "address":
      return `address:${endpointId(a.host, a.port, a.scope)}`;
    case "call":
      return `call:${a.repo}:${a.method} ${a.path}`;
    case "role":
      return `role:${a.project}:${a.role}:${a.where}`;
  }
}

export interface StoredPage {
  page: WikiPage;
  updatedAt: string;
}

/** A version a newer save replaced. */
export interface PageVersion {
  seq: number;
  page: WikiPage;
  savedAt: string;
}

interface PageRow {
  n: number;
  org: string;
  project: string | null;
  id: string;
  page: string;
  built_from: string;
  v: number;
  updated_at: string;
}

interface VersionRow {
  seq: number;
  page: string;
  saved_at: string;
}

interface StateRow {
  built_commit: string | null;
  sources: string;
  rules: number;
  plan: string | null;
  gaps: string;
  last_error: string | null;
  updated_at: string | null;
}

function parsePage(json: string): WikiPage | undefined {
  try {
    const parsed = WikiPageSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stored wiki: pages, every version a save replaced, and the state of each project. JSON columns are
 * checked by zod on the way out, and a row that no longer parses reads as absent (a page written by a build
 * that is gone, or edited by hand). Its text is kept: a later save archives it before it is replaced.
 */
export class WikiRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Runs `fn` as one transaction: a run's pages and its state land together or not at all. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  page(org: string, project: string | undefined, id: WikiPageId): StoredPage | undefined {
    const row = this.row(org, project, id);
    if (row === undefined) return undefined;
    const page = parsePage(row.page);
    return page === undefined ? undefined : { page, updatedAt: row.updated_at };
  }

  /** The whole pages of one project, or of the workspace when `project` is absent. Rows that do not parse are left out. */
  loaded(org: string, project: string | undefined): WikiPage[] {
    const rows = this.db
      .prepare("SELECT * FROM wiki_pages WHERE org = ? AND ifnull(project, '') = ? ORDER BY id")
      .all(org, project ?? "") as PageRow[];
    return rows.flatMap((row) => {
      const page = parsePage(row.page);
      return page === undefined ? [] : [page];
    });
  }

  /** The pages of one project, or of the workspace when `project` is absent. Rows that do not parse are left out. */
  pages(org: string, project: string | undefined): WikiPageSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM wiki_pages WHERE org = ? AND ifnull(project, '') = ? ORDER BY id")
      .all(org, project ?? "") as PageRow[];
    return rows.flatMap((row) => {
      const page = parsePage(row.page);
      if (page === undefined) return [];
      return [
        {
          id: page.id,
          kind: page.kind,
          title: page.title,
          ...(page.project === undefined ? {} : { project: page.project }),
          updatedAt: row.updated_at,
        },
      ];
    });
  }

  /**
   * Stores a page. The version it replaces moves to the history first, so no saved version is lost.
   * A page equal to the stored one writes nothing and returns false, so an update that changed nothing is a no-op.
   */
  save(page: WikiPage): boolean {
    const next = WikiPageSchema.parse(page);
    const json = JSON.stringify(next);
    const builtFrom = JSON.stringify(next.builtFrom);
    return this.transaction(() => {
      const row = this.row(next.org, next.project, next.id);
      if (row === undefined) {
        this.db
          .prepare(
            `INSERT INTO wiki_pages (org, project, id, kind, page, built_from, v, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(next.org, next.project ?? null, next.id, next.kind, json, builtFrom, next.v, this.now());
        return true;
      }
      if (row.page === json) return false;
      this.archive(row);
      this.db
        .prepare(
          "UPDATE wiki_pages SET kind = ?, page = ?, built_from = ?, v = ?, updated_at = ? WHERE n = ?",
        )
        .run(next.kind, json, builtFrom, next.v, this.now(), row.n);
      return true;
    });
  }

  /** Removes a page that is no longer written (a component that is gone). Its versions stay in the history. */
  remove(org: string, project: string | undefined, id: WikiPageId): boolean {
    return this.transaction(() => {
      const row = this.row(org, project, id);
      if (row === undefined) return false;
      this.archive(row);
      this.db.prepare("DELETE FROM wiki_pages WHERE n = ?").run(row.n);
      return true;
    });
  }

  /** Versions a save replaced, newest first. A version that does not parse is left out. */
  versions(org: string, project: string | undefined, id: WikiPageId): PageVersion[] {
    const row = this.row(org, project, id);
    if (row === undefined) return [];
    const rows = this.db
      .prepare("SELECT seq, page, saved_at FROM wiki_page_versions WHERE page_n = ? ORDER BY seq DESC")
      .all(row.n) as VersionRow[];
    return rows.flatMap((r) => {
      const page = parsePage(r.page);
      return page === undefined ? [] : [{ seq: r.seq, page, savedAt: r.saved_at }];
    });
  }

  versionCount(org: string, project: string | undefined, id: WikiPageId): number {
    const row = this.row(org, project, id);
    if (row === undefined) return 0;
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM wiki_page_versions WHERE page_n = ?")
      .get(row.n) as {
      n: number;
    };
    return count.n;
  }

  /** Everything the owner told the wiki of a workspace. A row that does not parse reads as absent. */
  answers(org: string): WikiAnswer[] {
    const rows = this.db.prepare("SELECT answer FROM wiki_answers WHERE org = ? ORDER BY key").all(org) as {
      answer: string;
    }[];
    return rows.flatMap((row) => {
      try {
        const parsed = WikiAnswerSchema.safeParse(JSON.parse(row.answer));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  addressAnswers(org: string): OwnerAnswer[] {
    return this.answers(org).flatMap((a) =>
      a.kind === "address" ? [{ host: a.host, port: a.port, scope: a.scope, to: a.to }] : [],
    );
  }

  callAnswers(org: string): OwnerCallAnswer[] {
    return this.answers(org).flatMap((a) =>
      a.kind === "call" ? [{ repo: a.repo, method: a.method, path: a.path, to: a.to }] : [],
    );
  }

  roleAnswers(org: string): OwnerRoleAnswer[] {
    return this.answers(org).flatMap((a) =>
      a.kind === "role" ? [{ project: a.project, role: a.role, where: a.where, choice: a.choice }] : [],
    );
  }

  /** Replaces every answer of one kind in a workspace with `next`, in one transaction. Other kinds and other workspaces are untouched. */
  replaceAnswers(org: string, kind: WikiAnswer["kind"], next: readonly WikiAnswer[]): void {
    const rows = next.map((a) => WikiAnswerSchema.parse(a));
    if (rows.some((a) => a.kind !== kind)) throw new Error(`Every answer to replace is a ${kind} answer.`);
    this.transaction(() => {
      this.db.prepare("DELETE FROM wiki_answers WHERE org = ? AND key LIKE ?").run(org, `${kind}:%`);
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO wiki_answers (org, key, answer, updated_at) VALUES (?, ?, ?, ?)",
      );
      for (const a of rows) insert.run(org, answerKey(a), JSON.stringify(a), this.now());
    });
  }

  /** A page as the owner sees it: a project overview with the owner's role decisions applied. Stored pages are never changed by it. */
  shown(page: WikiPage): WikiPage {
    return page.kind === "overview" && page.project !== undefined
      ? applyRoleChoices(page, this.roleAnswers(page.org))
      : page;
  }

  /** A project's state. A project never updated, or a row that no longer parses, reads as never built. */
  state(org: string, project: string): WikiState {
    const row = this.db.prepare("SELECT * FROM wiki_state WHERE org = ? AND project = ?").get(org, project) as
      | StateRow
      | undefined;
    if (row === undefined) return EMPTY_WIKI_STATE;
    try {
      const parsed = WikiStateSchema.safeParse({
        ...(row.built_commit === null ? {} : { builtCommit: row.built_commit }),
        sources: JSON.parse(row.sources),
        rules: row.rules,
        ...(row.plan === null ? {} : { plan: JSON.parse(row.plan) }),
        gaps: JSON.parse(row.gaps),
        ...(row.last_error === null ? {} : { lastError: row.last_error }),
        ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
      });
      return parsed.success ? parsed.data : EMPTY_WIKI_STATE;
    } catch {
      return EMPTY_WIKI_STATE;
    }
  }

  saveState(org: string, project: string, state: WikiState): void {
    const next = WikiStateSchema.parse(state);
    this.db
      .prepare(
        `INSERT INTO wiki_state (org, project, built_commit, sources, rules, plan, gaps, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org, project) DO UPDATE SET built_commit = excluded.built_commit,
           sources = excluded.sources, rules = excluded.rules, plan = excluded.plan, gaps = excluded.gaps,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(
        org,
        project,
        next.builtCommit ?? null,
        JSON.stringify(next.sources),
        next.rules,
        next.plan === undefined ? null : JSON.stringify(next.plan),
        JSON.stringify(next.gaps),
        next.lastError ?? null,
        next.updatedAt ?? this.now(),
      );
  }

  private row(org: string, project: string | undefined, id: WikiPageId): PageRow | undefined {
    return this.db
      .prepare("SELECT * FROM wiki_pages WHERE org = ? AND ifnull(project, '') = ? AND id = ?")
      .get(org, project ?? "", id) as PageRow | undefined;
  }

  private archive(row: PageRow): void {
    const last = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM wiki_page_versions WHERE page_n = ?")
      .get(row.n) as { seq: number };
    this.db
      .prepare(
        `INSERT INTO wiki_page_versions (page_n, seq, org, project, id, page, built_from, v, saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.n,
        last.seq + 1,
        row.org,
        row.project,
        row.id,
        row.page,
        row.built_from,
        row.v,
        row.updated_at,
      );
  }
}
