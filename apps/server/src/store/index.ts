import { join } from "node:path";
import type Database from "better-sqlite3";
import { LifecycleRows } from "../tasks/lifecycle/rows.ts";
import { UsageEvents } from "../usage/events.ts";
import { WikiRepo } from "../wiki/repo.ts";
import { ChatStateRepo } from "./chat-state.ts";
import { ClientRepo } from "./client.ts";
import { ConnectionHealthRepo } from "./connection-health.ts";
import { ConversationsRepo } from "./conversations.ts";
import { createDb, type SqliteBaseline } from "./db.ts";
import { DeployRepo } from "./deploys.ts";
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
  /** The task lifecycle's rows: status, hold, audit trail and outbox. Written only by `tasks/lifecycle/apply.ts`. */
  readonly lifecycle: LifecycleRows;
  readonly room: RoomRepo;
  readonly runs: RunRepo;
  readonly permissions: PermissionRepo;
  readonly plans: PlanRepo;
  readonly chats: ChatStateRepo;
  readonly connectionHealth: ConnectionHealthRepo;
  /** Client rooms, contacts and the read position of each chat app account. */
  readonly client: ClientRepo;
  /** The chat dock: the owner's conversations and what they have read. */
  readonly conversations: ConversationsRepo;
  /** What majhi put into contexts, for the token receipts. */
  readonly usageEvents: UsageEvents;
  /** The deploy records: one row per target and commit. */
  readonly deploys: DeployRepo;
  /** The project wiki's pages, their versions and each project's state. */
  readonly wiki: WikiRepo;
  /** The SQLite version and pragmas the connection runs with. */
  readonly baseline: SqliteBaseline;
  private readonly sqlite: Database.Database;

  constructor(file: string) {
    const { sqlite, db, baseline } = createDb(file);
    this.sqlite = sqlite;
    this.baseline = baseline;
    this.deploys = new DeployRepo(sqlite);
    this.tasks = new TaskRepo(db, this.deploys);
    this.lifecycle = new LifecycleRows(db);
    this.room = new RoomRepo(db);
    this.runs = new RunRepo(db);
    this.permissions = new PermissionRepo(db);
    this.plans = new PlanRepo(db);
    this.chats = new ChatStateRepo(sqlite);
    this.connectionHealth = new ConnectionHealthRepo(sqlite);
    this.client = new ClientRepo(sqlite);
    this.conversations = new ConversationsRepo(db);
    this.usageEvents = new UsageEvents(sqlite);
    this.wiki = new WikiRepo(sqlite);
  }

  static open(majhiHome: string): Store {
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
