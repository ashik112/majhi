import { type ProjectCard, ProjectCardSchema } from "@majhi/shared";
import type Database from "better-sqlite3";

interface Row {
  card: string;
  facts_hash: string;
}

/** The cards in majhi's database, one row per project. */
export class CardRepo {
  constructor(private readonly db: Database.Database) {}

  get(project: string): { card: ProjectCard; factsHash: string } | undefined {
    const row = this.db
      .prepare("SELECT card, facts_hash FROM project_cards WHERE project = ?")
      .get(project) as Row | undefined;
    return row === undefined ? undefined : parse(row);
  }

  all(): { card: ProjectCard; factsHash: string }[] {
    return (this.db.prepare("SELECT card, facts_hash FROM project_cards").all() as Row[]).flatMap((r) => {
      const found = parse(r);
      return found === undefined ? [] : [found];
    });
  }

  put(card: ProjectCard, factsHash: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO project_cards (project, card, facts_hash, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET card = excluded.card, facts_hash = excluded.facts_hash, updated_at = excluded.updated_at`,
      )
      .run(card.project, JSON.stringify(card), factsHash, at);
  }

  remove(project: string): void {
    this.db.prepare("DELETE FROM project_cards WHERE project = ?").run(project);
  }
}

/** A row that no longer parses (an older shape) counts as no card: the next refresh rewrites it. */
function parse(row: Row): { card: ProjectCard; factsHash: string } | undefined {
  try {
    const card = ProjectCardSchema.safeParse(JSON.parse(row.card));
    return card.success ? { card: card.data, factsHash: row.facts_hash } : undefined;
  } catch {
    return undefined;
  }
}
