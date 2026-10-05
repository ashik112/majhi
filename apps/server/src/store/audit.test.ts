import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type AuditRow, Store } from "./index.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

function task(id: string, org: string | undefined): Task {
  return {
    id,
    title: id,
    brief: "b",
    kind: "code",
    ...(org === undefined ? {} : { org }),
    status: "review",
    folder: `/tasks/${id}`,
    repos: [],
    team: ["builder"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

function row(patch: Partial<AuditRow> & Pick<AuditRow, "task" | "at">): AuditRow {
  return {
    agent: "builder",
    kind: "push",
    title: "Push of acme-api",
    decision: "done",
    by: "owner",
    ...patch,
  };
}

describe("audit org and detail", () => {
  it("fills org on rows that already exist, and keeps them readable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "majhi-db-"));
    const file = join(dir, "majhi.db");
    const old = new Database(file);
    migrate(
      old,
      MIGRATIONS.filter((m) => m.id < 106),
    );
    const addTask = old.prepare(
      "INSERT INTO tasks (id, title, brief, kind, org, status, folder, team, created_at, updated_at) VALUES (?,'t','b','code',?,'review','/t','[]','x','x')",
    );
    addTask.run("ACME-1", "acme");
    addTask.run("PRV-1", null);
    const addAudit = old.prepare(
      "INSERT INTO audit (task, agent, kind, title, decision, by, at) VALUES (?,'builder','edit','Edit a.ts','allow','rule','2026-01-01T00:00:00.000Z')",
    );
    for (const id of ["ACME-1", "PRV-1", "GONE-1"]) addAudit.run(id);
    old.close();

    const store = new Store(file);
    try {
      expect(store.permissions.audit("ACME-1")[0]).toMatchObject({ org: "acme", title: "Edit a.ts" });
      expect(store.permissions.audit("PRV-1")[0]?.org).toBe("private");
      // The task was already deleted: the row stays, with no org.
      expect(store.permissions.audit("GONE-1")[0]?.org).toBeUndefined();
      expect(store.permissions.list({}).entries).toHaveLength(3);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
