import { describe, expect, it } from "vitest";
import { mayRetype, type TypeBy } from "./task-type.ts";

describe("who may change a task's type", () => {
  const by: TypeBy[] = ["owner", "captain", "intake"];
  const allowed = (current: TypeBy | undefined) =>
    by.filter((who) => mayRetype(current === undefined ? undefined : { type: "bug", by: current }, who));

  it("lets anyone type an untyped task", () => {
    expect(allowed(undefined)).toEqual(["owner", "captain", "intake"]);
  });

  it("lets anyone replace an inferred type", () => {
    expect(allowed("intake")).toEqual(["owner", "captain", "intake"]);
  });
});
