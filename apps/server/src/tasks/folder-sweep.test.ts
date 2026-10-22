import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { tempDir } from "../testing/fixtures.ts";
import { TaskFolderSweep } from "./folder-sweep.ts";

let dir: string;
let dispose: () => Promise<void>;
let store: Store;

beforeEach(async () => {
  ({ dir, cleanup: dispose } = await tempDir());
  store = new Store(join(dir, "majhi.db"));
});
afterEach(async () => {
  store.close();
  await dispose();
});

async function seed(id: string, status: Task["status"], kind: Task["kind"]): Promise<string> {
  const folder = join(dir, "tasks", id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "TASK.md"), "brief\n");
  store.tasks.insert({
    id,
    title: `Task ${id}`,
    brief: "brief",
    kind,
    org: "acme",
    status,
    folder,
    repos: [],
    team: ["builder"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as Task);
  return folder;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("the worktree budget", () => {
  it("never removes the folder of a task that is not done, a captain lane included", async () => {
    const lane = await seed("ACM-1", "paused", "chat");
    const review = await seed("ACM-2", "review", "code");
    const ready = await seed("ACM-3", "ready", "code");
    const finished = await seed("ACM-4", "done", "code");
    const sweep = new TaskFolderSweep({ store, tasksDir: async () => join(dir, "tasks") });

    const report = await sweep.budget(0);

    expect(report.removed).toEqual(["ACM-4"]);
    expect(await exists(finished)).toBe(false);
    expect(await Promise.all([lane, review, ready].map(exists))).toEqual([true, true, true]);
  });
});
