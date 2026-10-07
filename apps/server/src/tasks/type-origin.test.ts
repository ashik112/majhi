import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";
import { originFor } from "./provenance.ts";
import { typist } from "./typing.ts";

let w: World;
afterEach(() => w?.cleanup());

const box = (extra: Record<string, unknown> = {}) => ({
  text: "Cart badge shows the wrong count",
  repos: [{ project: "acme-api" }],
  start: false,
  ...extra,
});

describe("the type an owner sets", () => {
  it("stays when the captain or inference would change it", async () => {
    w = await taskWorld();
    const { services } = w.h.majhi;
    const made = (await w.h.cmd("tasks.create", box({ type: "design" }))).body as Task;
    expect(made.typing).toEqual({ type: "design", by: "owner" });

    expect(() => services.tasks.setType(made.id, "bug", "captain")).toThrow(/owner set the type/);
    expect(services.tasks.get(made.id).typing).toEqual({ type: "design", by: "owner" });

    const changed = await w.h.cmd("tasks.setType", { id: made.id, type: "bug" });
    expect((changed.body as Task).typing).toEqual({ type: "bug", by: "owner" });
  });
});

describe("who may type a task", () => {
  const where = { boss: "boss", lane: "acme", taskOrg: "acme" };
  it("is the owner for any task and the captain only for the workspace it speaks in", () => {
    expect(typist({ kind: "owner" }, where)).toEqual({ by: "owner" });
    expect(typist({ kind: "agent", id: "boss" }, where)).toEqual({ by: "captain" });
    expect(typist({ kind: "agent", id: "boss" }, { ...where, taskOrg: "globex" })).toHaveProperty("refusal");
    expect(typist({ kind: "agent", id: "boss" }, { ...where, lane: undefined })).toHaveProperty("refusal");
    expect(typist({ kind: "agent", id: "acme-builder" }, where)).toHaveProperty("refusal");
  });
});

describe("a task's origin stays in its workspace", () => {
  const finding = { kind: "finding", finding: 7, source: "ci", severity: "low" } as const;

  it("refuses a reference into another workspace and takes one in its own", () => {
    expect(() =>
      originFor({ kind: "ref", origin: finding, workspace: "globex" }, { org: "acme", parent: undefined }),
    ).toThrow(/only points at things in its own workspace/);
    expect(
      originFor({ kind: "ref", origin: finding, workspace: "acme" }, { org: "acme", parent: undefined }),
    ).toEqual(finding);
    expect(
      originFor(
        { kind: "ref", origin: finding, workspace: "private" },
        { org: undefined, parent: undefined },
      ),
    ).toEqual(finding);
  });

  it("makes no task when the creator's finding is in another workspace", async () => {
    w = await taskWorld();
    const { services } = w.h.majhi;
    await expect(
      services.tasks.create({
        text: "Fix it",
        repos: [{ project: "acme-api" }],
        attachments: [],
        start: false,
        provenance: { kind: "ref", origin: finding, workspace: "globex" },
      }),
    ).rejects.toThrow(/own workspace/);
    expect(services.store.tasks.list(true)).toEqual([]);
  });
});
