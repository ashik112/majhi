import { PlaybookSchema } from "@majhi/shared";
import { expect, it } from "vitest";
import { BUILTIN } from "./catalog.ts";

it("every shipped playbook passes its schema and has its own id", () => {
  const bad = BUILTIN.filter((p) => !PlaybookSchema.safeParse(p).success).map((p) => p.id);
  expect(bad).toEqual([]);
  expect(new Set(BUILTIN.map((p) => p.id)).size).toBe(BUILTIN.length);
});
