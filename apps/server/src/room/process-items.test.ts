import { join } from "node:path";
import { type ProcessInfo, processItemId, type Task, type TaskId } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { tempDir } from "../testing/fixtures.ts";
import { RoomService } from "./service.ts";

const TASK = "ACM-1" as TaskId;

let dir: string;
let dispose: () => Promise<void>;
let store: Store;

beforeEach(async () => {
  ({ dir, cleanup: dispose } = await tempDir());
  store = new Store(join(dir, "majhi.db"));
  store.tasks.insert({
    id: TASK,
    title: "Task",
    brief: "brief",
    kind: "code",
    status: "running",
    folder: join(dir, "tasks", TASK),
    repos: [],
    team: ["acme-lead"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-10-22T09:00:00.000Z",
    updatedAt: "2026-10-22T09:00:00.000Z",
  } as Task);
});
afterEach(async () => {
  store.close();
  await dispose();
});

const run = (patch: Partial<ProcessInfo> = {}): ProcessInfo => ({
  id: "p1",
  task: TASK,
  agent: "acme-lead",
  name: "dev server",
  command: "pnpm dev",
  cwd: "/tasks/ACM-1",
  wait: false,
  status: "running",
  startedAt: "2026-10-22T10:00:00.000Z",
  tail: [],
  ...patch,
});

/** The process items of the task, as the room shows them. */
const processItems = () => store.room.page(TASK, 50).items.filter((i) => i.type === "process");

describe("a process in the room", () => {
  it("stays one item per run, takes its exit and end time, and survives a restart", () => {
    const first = new RoomService(store);
    first.setProcesses(TASK, [run()]);
    first.setProcesses(TASK, [run({ tail: ["ready"], port: 5173 })]);
    first.setProcesses(TASK, [run({ tail: ["ready", "bye"], port: 5173 })]);
    expect(processItems()).toHaveLength(1);

    // The same run ends with an exit code and a time.
    const ended = run({
      status: "exited",
      exitCode: 1,
      endedAt: "2026-10-22T10:03:00.000Z",
      tail: ["ready", "bye"],
      port: 5173,
    });
    first.setProcesses(TASK, [ended]);
    // A late report of the run as still running never reopens it.
    first.setProcesses(TASK, [run({ port: 5173 })]);
    const [item] = processItems();
    expect(item?.id).toBe(processItemId(run()));
    expect(item?.type === "process" && item.process).toMatchObject({
      status: "exited",
      exitCode: 1,
      endedAt: "2026-10-22T10:03:00.000Z",
    });

    // After a restart the same end is reported again: still one item, and its handled mark stays.
    first.handleProcessEnd(TASK, ended);
    const second = new RoomService(store);
    second.setProcesses(TASK, [ended]);
    expect(processItems()).toHaveLength(1);
    expect(second.processHandled(TASK, ended)).toBe(true);

    // A restart of the command is another run: its own item.
    second.setProcesses(TASK, [run({ startedAt: "2026-10-22T10:05:00.000Z" })]);
    expect(processItems()).toHaveLength(2);

    // A run still recorded as running when majhi starts ended with the last server: it gets its end time.
    const third = new RoomService(store);
    const now = new Date("2026-10-22T11:00:00.000Z");
    expect(third.closeOrphanedProcesses(now)).toBe(1);
    expect(third.closeOrphanedProcesses(now)).toBe(0);
    const stopped = processItems().find(
      (i) => i.type === "process" && i.process.startedAt.endsWith("10:05:00.000Z"),
    );
    expect(stopped?.type === "process" && stopped.process).toMatchObject({
      status: "stopped",
      stoppedBy: "task",
      endedAt: now.toISOString(),
    });
    expect(processItems()).toHaveLength(2);
  });
});
