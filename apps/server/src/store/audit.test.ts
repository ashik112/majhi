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

  it("writes the task's org when the caller gives none", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-1", "acme"));
    store.tasks.insert(task("PRV-1", undefined));
    store.permissions.log(row({ task: "ACME-1", at: "2026-01-01T00:00:00.000Z", detail: "origin/main" }));
    store.permissions.log(row({ task: "PRV-1", at: "2026-01-02T00:00:00.000Z" }));
    store.permissions.log(row({ task: "ACME-1", at: "2026-01-03T00:00:00.000Z", org: "globex" }));
    expect(store.permissions.audit("ACME-1")).toMatchObject([
      { org: "acme", detail: "origin/main" },
      { org: "globex" },
    ]);
    expect(store.permissions.audit("PRV-1")[0]?.org).toBe("private");
    store.close();
  });
});

describe("audit list", () => {
  function seeded(): Store {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-1", "acme"));
    store.tasks.insert(task("GLX-1", "globex"));
    const log = (r: Parameters<typeof row>[0]) => store.permissions.log(row(r));
    log({ task: "ACME-1", at: "2026-01-01T10:00:00.000Z", kind: "push" });
    log({ task: "ACME-1", at: "2026-01-02T10:00:00.000Z", kind: "merge", agent: "lead" });
    log({
      task: "GLX-1",
      at: "2026-01-03T10:00:00.000Z",
      kind: "merge",
      decision: "failed",
      detail: "main: conflict",
    });
    log({ task: "GLX-1", at: "2026-01-04T10:00:00.000Z", kind: "edit", decision: "deny", by: "rule" });
    log({ task: "ACME-1", at: "2026-01-05T10:00:00.000Z", kind: "mr" });
    return store;
  }

  it("lists newest first, and offers every kind, agent and org", () => {
    const store = seeded();
    const all = store.permissions.list({});
    expect(all.entries.map((e) => e.kind)).toEqual(["mr", "edit", "merge", "merge", "push"]);
    expect(all.next).toBeUndefined();
    expect(all.kinds).toEqual(["edit", "merge", "mr", "push"]);
    expect(all.agents).toEqual(["builder", "lead"]);
    expect(all.orgs).toEqual(["acme", "globex"]);
    store.close();
  });

  it("filters by org, task, kinds, agent and decision, together", () => {
    const store = seeded();
    const kinds = (input: Parameters<Store["permissions"]["list"]>[0]) =>
      store.permissions.list(input).entries.map((e) => e.kind);
    expect(kinds({ org: "globex" })).toEqual(["edit", "merge"]);
    expect(kinds({ task: "ACME-1" })).toEqual(["mr", "merge", "push"]);
    expect(kinds({ kinds: ["push", "mr"] })).toEqual(["mr", "push"]);
    expect(kinds({ agent: "lead" })).toEqual(["merge"]);
    expect(kinds({ decision: "failed" })).toEqual(["merge"]);
    expect(kinds({ org: "acme", kinds: ["merge", "edit"] })).toEqual(["merge"]);
    // The dropdowns still list everything while a filter is on.
    expect(store.permissions.list({ org: "globex" }).orgs).toEqual(["acme", "globex"]);
    store.close();
  });

  it("filters by a date range: a date alone covers the whole day, both ends included", () => {
    const store = seeded();
    const days = (input: Parameters<Store["permissions"]["list"]>[0]) =>
      store.permissions.list(input).entries.map((e) => e.at.slice(8, 10));
    expect(days({ from: "2026-01-02", to: "2026-01-04" })).toEqual(["04", "03", "02"]);
    expect(days({ to: "2026-01-01" })).toEqual(["01"]);
    expect(days({ from: "2026-01-04T10:00:00.001Z" })).toEqual(["05"]);
    expect(days({ to: "2026-01-02T09:59:59Z" })).toEqual(["01"]);
    store.close();
  });

  it("pages with the before cursor, with no row twice or missed", () => {
    const store = seeded();
    const first = store.permissions.list({ limit: 2 });
    expect(first.entries.map((e) => e.kind)).toEqual(["mr", "edit"]);
    expect(first.next).toBe(first.entries[1]?.id);
    const second = store.permissions.list({ limit: 2, before: first.next });
    expect(second.entries.map((e) => e.kind)).toEqual(["merge", "merge"]);
    const last = store.permissions.list({ limit: 2, before: second.next });
    expect(last.entries.map((e) => e.kind)).toEqual(["push"]);
    expect(last.next).toBeUndefined();
    // A row written after the first page does not shift the next one.
    store.permissions.log(row({ task: "ACME-1", at: "2026-01-06T10:00:00.000Z", kind: "late" }));
    expect(store.permissions.list({ limit: 2, before: first.next }).entries.map((e) => e.kind)).toEqual([
      "merge",
      "merge",
    ]);
    store.close();
  });
});
