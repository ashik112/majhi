import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./index.ts";
import { resetReportedRows } from "./tolerant.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetReportedRows();
});

describe("one bad row does not fail a read", () => {
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
});
