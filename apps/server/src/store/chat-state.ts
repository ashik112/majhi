import type Database from "better-sqlite3";

export type TitledBy = "owner" | "auto";

export interface ChatState {
  /** The time (`at`) of the last message memory read. Undefined: none read yet. */
  extractedAt: string | undefined;
  /** Who set the title last. Undefined: nobody; it is the default or the first line. */
  titledBy: TitledBy | undefined;
  /** The owner messages the chat had when the title was last made. */
  titledOwnerMessages: number;
}

interface Row {
  extracted_at: string | null;
  titled_by: string | null;
  titled_owner_messages: number;
}

/** What majhi did with each chat: how far memory has read it and who titled it. */
export class ChatStateRepo {
  constructor(private readonly sqlite: Database.Database) {}

  get(task: string): ChatState {
    const row = this.sqlite
      .prepare("SELECT extracted_at, titled_by, titled_owner_messages FROM chat_state WHERE task = ?")
      .get(task) as Row | undefined;
    return {
      extractedAt: row?.extracted_at ?? undefined,
      titledBy: row?.titled_by === "owner" || row?.titled_by === "auto" ? row.titled_by : undefined,
      titledOwnerMessages: row?.titled_owner_messages ?? 0,
    };
  }

  /** Only moves forward: an older time never replaces a newer one. */
  setExtracted(task: string, at: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO chat_state (task, extracted_at) VALUES (?, ?)
         ON CONFLICT (task) DO UPDATE SET extracted_at = excluded.extracted_at
         WHERE chat_state.extracted_at IS NULL OR chat_state.extracted_at < excluded.extracted_at`,
      )
      .run(task, at);
  }

  setTitle(task: string, by: TitledBy, ownerMessages: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO chat_state (task, titled_by, titled_owner_messages) VALUES (?, ?, ?)
         ON CONFLICT (task) DO UPDATE SET titled_by = excluded.titled_by,
           titled_owner_messages = excluded.titled_owner_messages`,
      )
      .run(task, by, ownerMessages);
  }

  /** The owner renamed the chat: majhi never sets its title again. */
  markOwnerTitled(task: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO chat_state (task, titled_by) VALUES (?, 'owner')
         ON CONFLICT (task) DO UPDATE SET titled_by = 'owner'`,
      )
      .run(task);
  }
}
