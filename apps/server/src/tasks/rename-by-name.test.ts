import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function started(text: string): Promise<Task> {
  w = await taskWorld();
  const made = await w.h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: true });
  expect(made.status).toBe(200);
  await w.h.majhi.services.runs.idle();
  return (await w.h.cmd("tasks.get", { id: (made.body as Task).id })).body as Task;
}

describe("the agent names its task", () => {
  it("renames a branch nobody has published to the new name, and leaves the folder", async () => {
    const before = await started("add a retry to the upload");
    expect(before.repos[0]?.branch).toBe("feat/add-retry-upload");
    const tasks = w?.h.majhi.services.tasks;
    await tasks?.setStatusLines(before.id, { name: "Upload retry" });
    const after = (await w?.h.cmd("tasks.get", { id: before.id }))?.body as Task;
    expect(after.name).toBe("Upload retry");
    expect(after.repos[0]?.branch).toBe("feat/upload-retry");
    expect(after.folder).toBe(before.folder);
    expect(await git(w?.repo("api") ?? "", "branch", "--list", "feat/*")).toContain("feat/upload-retry");
  });

  it("keeps the name of a branch that was already pushed", async () => {
    const before = await started("add a retry to the upload");
    const branch = before.repos[0]?.branch ?? "";
    await git(w?.repo("api") ?? "", "push", "origin", branch);
    await w?.h.majhi.services.tasks.setStatusLines(before.id, { name: "Upload retry" });
    const after = (await w?.h.cmd("tasks.get", { id: before.id }))?.body as Task;
    expect(after.name).toBe("Upload retry");
    expect(after.repos[0]?.branch).toBe(branch);
  });
});
