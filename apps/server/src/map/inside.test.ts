import { GraphifyFactsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { buildInside } from "./inside.ts";

const ctx = { project: "acme", dbs: [], services: [], owner: () => undefined };

const def = (id: string, file: string, line = 1, end = 20) => ({ id, file, line, end, doc: "" });

/** One route calls `save` (proved by an import) and `guess` (a match by name alone). Both reach a table. */
const facts = GraphifyFactsSchema.parse({
  v: 3,
  files: 3,
  calls: [],
  inside: {
    defs: [
      def("get /orders", "src/orders/routes.ts"),
      def("save", "src/billing/save.ts"),
      def("guess", "src/audit/guess.ts"),
    ],
    calls: [
      { from: "get /orders", to: "save", line: 3, how: "import" },
      { from: "get /orders", to: "guess", line: 4, how: "name" },
      { from: "get /orders", to: "guess", line: 5 },
    ],
    uses: [
      { fn: "save", name: "SQLite", kind: "db", line: 5, verb: "write", target: "invoices" },
      { fn: "guess", name: "SQLite", kind: "db", line: 5, verb: "write", target: "audit_log" },
    ],
    entries: [
      { kind: "HTTP", label: "GET /orders", file: "src/orders/routes.ts", line: 2, fn: "get /orders" },
    ],
    stores: [],
  },
});

describe("Inside trace", () => {
  it("follows only calls the code proves, never a match by name", () => {
    const built = buildInside(facts, ctx);
    const steps = built?.spec.entries[0]?.steps ?? [];
    expect(steps.map((s) => s.part)).toEqual(["Orders", "Billing", "Database"]);
    expect(steps.some((s) => s.fns.some((f) => f.id === "guess"))).toBe(false);
    expect(built?.spec.data.map((d) => d.name)).toEqual(["invoices"]);
  });

  it("does not read facts written before calls were proved", () => {
    expect(buildInside({ ...facts, v: 2 }, ctx)).toBeUndefined();
  });
});
