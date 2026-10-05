import { join } from "node:path";
import type { RoomItem, RoomServerMessage, Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/index.ts";
import { tempDir } from "../testing/fixtures.ts";
import { RoomService } from "./service.ts";

let dispose: () => Promise<void>;
let store: Store;
let room: RoomService;

beforeEach(async () => {
  const made = await tempDir();
  dispose = made.cleanup;
  store = new Store(join(made.dir, "majhi.db"));
  room = new RoomService(store);
  store.tasks.insert({
    id: "ACM-1",
    title: "Task",
    brief: "brief",
    kind: "code",
    org: "acme",
    status: "running",
    folder: join(made.dir, "tasks", "ACM-1"),
    repos: [],
    team: ["builder"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  } as Task);
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await dispose();
});

function textOf(item: RoomItem | undefined): string {
  return item !== undefined && (item.type === "agent" || item.type === "thought") ? item.text : "";
}

/** Streams `chunks` pieces of `size` characters, one per 50 ms beat, the way an agent's reply arrives. */
function streamReply(chunks: number, size: number, onChunk?: (n: number) => void): string {
  let text = "";
  for (let i = 0; i < chunks; i++) {
    text += String.fromCharCode(97 + (i % 26)).repeat(size);
    room.post("ACM-1", "builder:1:reply", { type: "agent", agent: "builder", text }, { defer: true });
    vi.advanceTimersByTime(50);
    onChunk?.(i);
  }
  return text;
}

describe("a streamed reply", () => {
  it("sends bytes linear in its length, and stores it about once a second", () => {
    const frames: RoomServerMessage[] = [];
    room.subscribe("ACM-1", (m) => frames.push(m));
    const upserts = vi.spyOn(store.room, "upsert");
    const text = streamReply(500, 100);
    room.flush("ACM-1");
    expect(text.length).toBe(50_000);
    const bytes = frames.reduce((n, m) => n + JSON.stringify(m).length, 0);
    // Whole text once as deltas, plus the whole item once at the end, plus a little framing.
    expect(bytes).toBeLessThan(text.length * 2 + 500 * 90);
    // 25 s of streaming: about one write a second, not one per 50 ms.
    expect(upserts.mock.calls.length).toBeLessThan(35);
    expect(store.room.get("ACM-1", "builder:1:reply")).toMatchObject({ text });
  });

  it("gives a client that connects mid-message the whole text so far, and the rest follows", () => {
    const early: RoomServerMessage[] = [];
    room.subscribe("ACM-1", (m) => early.push(m));
    let seen = "";
    let snapshotText = "";
    const late: RoomServerMessage[] = [];
    const task = store.tasks.get("ACM-1") as Task;
    streamReply(300, 100, (n) => {
      if (n !== 149) return;
      room.subscribe("ACM-1", (m) => late.push(m));
      const first = room.snapshot(task).items.find((i) => i.id === "builder:1:reply");
      seen = textOf(first);
      snapshotText = seen;
    });
    room.flush("ACM-1");
    expect(snapshotText.length).toBe(15_000);
    for (const m of late) {
      if (m.type === "delta" && m.offset === seen.length) seen += m.append;
      else if (m.type === "item") seen = textOf(m.item);
    }
    expect(seen.length).toBe(30_000);
    expect(seen).toBe(textOf(store.room.get("ACM-1", "builder:1:reply")));
  });
});
