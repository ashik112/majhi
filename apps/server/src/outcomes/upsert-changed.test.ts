import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { type Derived, OutcomesRepo } from "./repo.ts";

const at = "2027-01-01T00:00:00.000Z";
const later = "2027-01-02T00:00:00.000Z";

const base = (subject: string, over: Partial<Derived> = {}): Derived => ({
  subject,
  kind: "action",
  org: "acme",
  key: "merge",
  at,
  ...over,
});

describe("outcomes pass writes only what changed", () => {
  it("writes new rows and judgments that moved, and nothing for rows that are the same", () => {
    const store = new Store(":memory:");
    const repo = new OutcomesRepo(store.raw);
    const rows = [base("a:1"), base("a:2", { result: "kept" }), base("a:3")];
    expect(repo.upsertChanged(rows, at)).toBe(3);
    expect(repo.upsertChanged(rows, later)).toBe(0);
    // A judgment arriving later is written, and the others stay untouched.
    expect(
      repo.upsertChanged(
        [rows[0] as Derived, base("a:2", { result: "kept" }), base("a:3", { result: "undone" })],
        later,
      ),
    ).toBe(1);
    expect(repo.get("a:3")?.result).toBe("undone");
    expect(repo.get("a:3")?.settledAt).toBe(later);
    expect(repo.get("a:2")?.settledAt).toBe(at);
    store.close();
  });
});
