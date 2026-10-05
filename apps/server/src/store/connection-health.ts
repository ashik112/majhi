import { type ConnectionHealth, ConnectionHealthSchema } from "@majhi/shared";
import type Database from "better-sqlite3";

/** Where each connection stands (SPEC 5.14), kept across restarts. A row that no longer parses is ignored. */
export class ConnectionHealthRepo {
  constructor(private readonly sqlite: Database.Database) {}

  get(connection: string): ConnectionHealth | undefined {
    const row = this.sqlite
      .prepare("SELECT health FROM connection_health WHERE connection = ?")
      .get(connection) as { health: string } | undefined;
    return row === undefined ? undefined : parse(row.health);
  }

  all(): Map<string, ConnectionHealth> {
    const out = new Map<string, ConnectionHealth>();
    const rows = this.sqlite.prepare("SELECT connection, health FROM connection_health").all() as {
      connection: string;
      health: string;
    }[];
    for (const row of rows) {
      const health = parse(row.health);
      if (health !== undefined) out.set(row.connection, health);
    }
    return out;
  }

  set(connection: string, health: ConnectionHealth, at: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO connection_health (connection, health, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (connection) DO UPDATE SET health = excluded.health, updated_at = excluded.updated_at`,
      )
      .run(connection, JSON.stringify(health), at);
  }

  delete(connection: string): void {
    this.sqlite.prepare("DELETE FROM connection_health WHERE connection = ?").run(connection);
  }
}

function parse(text: string): ConnectionHealth | undefined {
  try {
    const parsed = ConnectionHealthSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
