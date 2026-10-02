import { join } from "node:path";
import type Database from "better-sqlite3";
import { applyPendingRestore } from "../backup/service.ts";
import { UsageEvents } from "../usage/events.ts";
import { ChatStateRepo } from "./chat-state.ts";
import { createDb } from "./db.ts";
import { PlanRepo } from "./plans.ts";
import { RoomRepo } from "./room.ts";
import { PermissionRepo, RunRepo } from "./runs.ts";
import { TaskRepo } from "./tasks.ts";

export type { ChatState, TitledBy } from "./chat-state.ts";
export type { NewPlan, PlanRow } from "./plans.ts";
export type { RoomPayload } from "./room.ts";
export type { AuditRow, RunRow } from "./runs.ts";

export const DB_FILE_NAME = "majhi.db";

/** `<majhi home>/majhi.db`: tasks, room items, runs and permission decisions. */
export class Store {
  readonly tasks: TaskRepo;
  readonly room: RoomRepo;
  readonly runs: RunRepo;
  readonly permissions: PermissionRepo;
  readonly plans: PlanRepo;
  readonly chats: ChatStateRepo;
  /** What majhi put into contexts, for the token receipts. */
  readonly usageEvents: UsageEvents;
  private readonly sqlite: Database.Database;

  constructor(file: string) {
    const { sqlite, db } = createDb(file);
    this.sqlite = sqlite;
    this.tasks = new TaskRepo(db);
    this.room = new RoomRepo(db);
    this.runs = new RunRepo(db);
    this.permissions = new PermissionRepo(db);
    this.plans = new PlanRepo(db);
    this.chats = new ChatStateRepo(sqlite);
    this.usageEvents = new UsageEvents(sqlite);
  }

  static open(majhiHome: string): Store {
    // A restore the owner picked in Hub setup replaces the file before anything opens it.
    applyPendingRestore(majhiHome, DB_FILE_NAME);
    return new Store(join(majhiHome, DB_FILE_NAME));
  }

  /** Raw handle, for tests that check pragmas and tables. */
  get raw(): Database.Database {
    return this.sqlite;
  }

  close(): void {
    if (this.sqlite.open) this.sqlite.close();
  }
}
