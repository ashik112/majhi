import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingsRepo } from "../findings/repo.ts";
import { Store } from "./index.ts";
import { parseRows, resetReportedRows } from "./tolerant.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetReportedRows();
});

describe("one bad row does not fail a read", () => {
  it("lists the findings that parse when one has a source this build does not know", () => {
    const store = new Store(":memory:");
    const repo = new FindingsRepo(store.raw);
    const at = "2027-01-01T00:00:00.000Z";
    const add = (key: string) =>
      repo.add({
        org: "acme",
        source: "follow-up",
        title: key,
        detail: "",
        evidence: [],
        severity: "info",
        dedupeKey: key,
        by: "captain",
        at,
      });
    add("one");
    const bad = add("two");
    add("three");
    store.raw.prepare("UPDATE findings SET source = 'not-a-source' WHERE id = ?").run(bad.id);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const listed = repo.list({ limit: 10 });
    expect(listed.map((f) => f.title).sort()).toEqual(["one", "three"]);
    expect(repo.get(bad.id)).toBeUndefined();
    // Reported once, however often it is read.
    repo.list({ limit: 10 });
    repo.list({ limit: 10 });
    expect(log).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("lists the tasks that parse when one has a status this build does not know", () => {
    const store = new Store(":memory:");
    const put = store.raw.prepare(
      "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES (?, ?, 'b', 'code', ?, '/t', '[]', 'x', 'x')",
    );
    put.run("ACME-1", "good", "inbox");
    put.run("ACME-2", "odd", "from-the-future");
    put.run("ACME-3", "also good", "review");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      store.tasks
        .list(true)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["ACME-1", "ACME-3"]);
    expect(store.tasks.getMany(["ACME-1", "ACME-2", "ACME-3"]).map((t) => t.id)).toEqual([
      "ACME-1",
      "ACME-3",
    ]);
    store.close();
  });

  it("parseRows keeps order and skips only the rows that throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = parseRows(
      "t",
      [1, 2, 3, 4],
      (n) => n,
      (n) => {
        if (n % 2 === 0) throw new Error("no");
        return n * 10;
      },
    );
    expect(out).toEqual([10, 30]);
  });
});
