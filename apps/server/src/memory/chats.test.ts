import type { MemoryExtractOutput, MemorySettings, RoomItem, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { ChatMemory } from "./chats.ts";

const SETTINGS = { chat_idle_minutes: 30 } as MemorySettings;
const LATER = () => new Date(Date.now() + 60 * 60_000);

function chat(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: "Chat",
    brief: "Chat",
    kind: "chat",
    org: "acme",
    status: "running",
    folder: `/tasks/${id}`,
    repos: [],
    team: ["dev"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

let n = 0;
function owner(store: Store, task: string, text: string): void {
  store.room.upsert(task, `o${n++}`, { type: "owner", text, attachments: [], queued: false });
}
function agent(store: Store, task: string, text: string): void {
  store.room.upsert(task, `a${n++}`, { type: "agent", agent: "dev", text });
}

interface Read {
  task: string;
  texts: string[];
}

function setup(options: { fail?: boolean } = {}) {
  const store = new Store(":memory:");
  const reads: Read[] = [];
  const asked: string[] = [];
  const titles: Record<string, string> = {};
  let nextTitle = "Fixing the build pipeline";
  const make = (now = LATER) =>
    new ChatMemory({
      store,
      settings: async () => SETTINGS,
      extraction: {
        fromChat: async (
          task: Task,
          items: readonly RoomItem[],
          _p: readonly string[],
          onRead: () => void,
        ) => {
          if (options.fail) throw new Error("model down");
          onRead();
          reads.push({ task: task.id, texts: items.map((i) => ("text" in i ? (i.text ?? "") : "")) });
          return {} as MemoryExtractOutput;
        },
      },
      housekeeper: {
        ask: async (_task, prompt, parse) => {
          asked.push(prompt);
          const parsed = parse(JSON.stringify({ title: nextTitle, keep: false }));
          if (!parsed.ok) throw new Error(parsed.problem);
          return { value: parsed.value, agent: "boss" } as never;
        },
      },
      mentioned: async () => [],
      working: () => false,
      setTitle: (id, title) => {
        if (store.chats.get(id).titledBy === "owner") return false;
        titles[id] = title;
        const t = store.tasks.get(id);
        if (t) store.tasks.setText(id, title, t.brief, "2026-01-02T00:00:00.000Z");
        return true;
      },
      now,
    });
  return { store, reads, asked, titles, make, setNext: (t: string) => (nextTitle = t) };
}

describe("memory from chats", () => {
  it("reads a quiet chat once and only the messages since the last read", async () => {
    const s = setup();
    s.store.tasks.insert(chat("C-1"));
    owner(s.store, "C-1", "We deploy on Fridays only");
    agent(s.store, "C-1", "Noted.");
    const mem = s.make();
    await mem.sweep();
    await mem.sweep();
    expect(s.reads).toEqual([{ task: "C-1", texts: ["We deploy on Fridays only", "Noted."] }]);

    owner(s.store, "C-1", "Staging is called Northwind");
    agent(s.store, "C-1", "Got it.");
    await mem.sweep();
    expect(s.reads.map((r) => r.texts)).toEqual([
      ["We deploy on Fridays only", "Noted."],
      ["Staging is called Northwind", "Got it."],
    ]);
  });

  it("keeps the watermark when reading fails, so nothing is lost", async () => {
    const s = setup({ fail: true });
    s.store.tasks.insert(chat("C-1"));
    owner(s.store, "C-1", "remember the vault path");
    agent(s.store, "C-1", "ok");
    await s.make().sweep();
    expect(s.store.chats.get("C-1").extractedAt).toBeUndefined();
  });
});
