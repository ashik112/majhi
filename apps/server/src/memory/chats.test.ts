import type { MemoryExtractOutput, MemorySettings, RoomItem, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { mentionedProjects } from "./chat-projects.ts";
import { ChatMemory, RETITLE_AFTER } from "./chats.ts";
import { Extraction } from "./extraction.ts";
import type { Candidate } from "./housekeeper.ts";
import { chatRecallScopes } from "./scopes.ts";

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
          reads.push({ task: task.id, texts: items.map((i) => ("text" in i ? i.text : "")) });
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

  it("does not read a chat that is still active, or twice after a restart", async () => {
    const s = setup();
    s.store.tasks.insert(chat("C-1"));
    owner(s.store, "C-1", "hello there");
    agent(s.store, "C-1", "hi");
    await s.make(() => new Date()).sweep();
    expect(s.reads).toEqual([]);
    await s.make().sweep();
    // A new ChatMemory over the same database is a restart.
    await s.make().sweep();
    expect(s.reads).toHaveLength(1);
  });

  it("keeps the watermark when reading fails, so nothing is lost", async () => {
    const s = setup({ fail: true });
    s.store.tasks.insert(chat("C-1"));
    owner(s.store, "C-1", "remember the vault path");
    agent(s.store, "C-1", "ok");
    await s.make().sweep();
    expect(s.store.chats.get("C-1").extractedAt).toBeUndefined();
  });

  it("reads an older chat when the owner starts a new one with the same agent", async () => {
    const s = setup();
    s.store.tasks.insert(chat("C-1"));
    owner(s.store, "C-1", "first topic");
    agent(s.store, "C-1", "reply");
    s.store.tasks.insert(chat("C-2", { createdAt: "2026-01-02T00:00:00.000Z" }));
    const now = () => new Date();
    await s.make(now).sweep();
    expect(s.reads).toEqual([]);
    owner(s.store, "C-2", "second topic");
    await s.make(now).sweep();
    expect(s.reads.map((r) => r.task)).toEqual(["C-1"]);
  });
});

describe("chat memory scopes", () => {
  it("offers a chat only its own org's scopes, and a root chat only global", async () => {
    const prompts: string[] = [];
    const seen: { org: string | undefined; projects: readonly string[]; candidates: Candidate[] }[] = [];
    const extraction = new Extraction({
      housekeeper: {
        ask: async (_t: unknown, prompt: string, parse: (r: string) => never) => {
          prompts.push(prompt);
          const parsed = parse(
            JSON.stringify({ facts: [{ text: "Staging is called Northwind", scope: "org:globex" }] }),
          ) as { value: Candidate[] };
          return { value: parsed.value, agent: "boss" };
        },
      } as never,
      curator: {
        curateCandidates: async (t: { org?: string; projects: string[] }, c: Candidate[]) => {
          seen.push({ org: t.org, projects: t.projects, candidates: c });
          return {} as MemoryExtractOutput;
        },
      } as never,
      memory: { changed: () => undefined } as never,
    } as never);
    const items = [] as RoomItem[];
    await extraction.fromChat(chat("C-1"), items, ["acme-api"], () => undefined);
    await extraction.fromChat(chat("C-2", { org: undefined }), items, ["acme-api"], () => undefined);
    expect(prompts[0]).toContain("project:acme-api");
    expect(prompts[0]).toContain("org:acme");
    expect(prompts[0]).not.toContain("org:globex");
    expect(prompts[1]).not.toContain("project:acme-api");
    expect(seen[1]).toMatchObject({ org: undefined, projects: [] });
  });

  it("recalls project memory in a chat only for projects of its org, root chats for any", () => {
    const orgs = new Map([
      ["acme-api", "acme"],
      ["globex-web", "globex"],
    ]);
    const mentioned = ["acme-api", "globex-web"];
    expect(chatRecallScopes({ org: "acme", repos: [] }, orgs, mentioned)).toEqual([
      "global",
      "org:acme",
      "project:acme-api",
    ]);
    expect(chatRecallScopes({ org: undefined, repos: [] }, orgs, mentioned)).toEqual([
      "global",
      "project:acme-api",
      "project:globex-web",
    ]);
  });

  it("finds a project named by id, or read by path, but not a word inside another", () => {
    const projects = [
      { id: "acme-api", org: "acme", path: "/Users/owner/Work/acme-api" },
      { id: "web", org: "acme", path: "/Users/owner/Work/web" },
    ];
    const task = { kind: "chat" as const, brief: "Chat", readMounts: [] };
    const say = (text: string): RoomItem =>
      ({
        type: "owner",
        text,
        id: "x",
        task: "C-1",
        seq: 1,
        at: "t",
        attachments: [],
        queued: false,
      }) as RoomItem;
    expect(mentionedProjects(task, [say("how does acme-api handle retries?")], projects)).toEqual([
      "acme-api",
    ]);
    expect(mentionedProjects(task, [say("look at /Users/owner/Work/web/src")], projects)).toEqual(["web"]);
    expect(mentionedProjects(task, [say("a webhook and a web-hook")], projects)).toEqual([]);
    expect(mentionedProjects({ ...task, kind: "code" as never }, [say("acme-api")], projects)).toEqual([]);
  });
});

describe("chat titles", () => {
  it("titles an untitled chat after the first agent reply, once", async () => {
    const s = setup();
    s.store.tasks.insert(chat("C-1", { title: "Why is the build red?" }));
    const mem = s.make();
    owner(s.store, "C-1", "Why is the build red?");
    await mem.afterTurn("C-1");
    expect(s.asked).toHaveLength(0);
    agent(s.store, "C-1", "The lint step fails.");
    await mem.afterTurn("C-1");
    await mem.afterTurn("C-1");
    expect(s.asked).toHaveLength(1);
    expect(s.store.tasks.get("C-1")?.title).toBe("Fixing the build pipeline");
    expect(s.store.chats.get("C-1").titledBy).toBe("auto");
  });

  it("checks again after more owner messages and may change the title", async () => {
    const s = setup();
    s.store.tasks.insert(chat("C-1", { title: "Why is the build red?" }));
    const mem = s.make();
    owner(s.store, "C-1", "Why is the build red?");
    agent(s.store, "C-1", "The lint step fails.");
    await mem.afterTurn("C-1");
    s.setNext("Planning the Friday release");
    for (let i = 0; i < RETITLE_AFTER - 1; i++) owner(s.store, "C-1", `more ${i}`);
    await mem.afterTurn("C-1");
    expect(s.asked).toHaveLength(1);
    owner(s.store, "C-1", "now about the release");
    await mem.afterTurn("C-1");
    expect(s.asked).toHaveLength(2);
    expect(s.store.tasks.get("C-1")?.title).toBe("Planning the Friday release");
  });

  it("never replaces a title the owner set", async () => {
    const s = setup();
    s.store.tasks.insert(chat("C-1", { title: "Why is the build red?" }));
    s.store.tasks.insert(chat("C-2", { title: "My own name" }));
    const mem = s.make();
    for (const id of ["C-1", "C-2"]) {
      owner(s.store, id, "Why is the build red?");
      agent(s.store, id, "The lint step fails.");
    }
    // C-1 was renamed by the owner; C-2 was titled before majhi kept track.
    s.store.chats.markOwnerTitled("C-1");
    await mem.afterTurn("C-1");
    await mem.afterTurn("C-2");
    expect(s.asked).toHaveLength(0);
    expect(s.store.tasks.get("C-1")?.title).toBe("Why is the build red?");
    expect(s.store.tasks.get("C-2")?.title).toBe("My own name");
    expect(s.store.chats.get("C-2").titledBy).toBe("owner");
  });

  it("does not set an auto title over an owner rename that lands while it is thinking", async () => {
    const s = setup();
    s.store.tasks.insert(chat("C-1", { title: "Why is the build red?" }));
    owner(s.store, "C-1", "Why is the build red?");
    agent(s.store, "C-1", "The lint step fails.");
    const racing = new ChatMemory({
      store: s.store,
      settings: async () => SETTINGS,
      extraction: { fromChat: async () => ({}) as MemoryExtractOutput },
      housekeeper: {
        ask: async (_t, _p, parse) => {
          s.store.tasks.setText("C-1", "Owner name", "Chat", "2026-01-03T00:00:00.000Z");
          s.store.chats.markOwnerTitled("C-1");
          const parsed = parse(JSON.stringify({ title: "Auto name" }));
          if (!parsed.ok) throw new Error("bad");
          return { value: parsed.value, agent: "boss" } as never;
        },
      },
      mentioned: async () => [],
      working: () => false,
      setTitle: (id, title) => {
        if (s.store.chats.get(id).titledBy === "owner") return false;
        s.store.tasks.setText(id, title, "Chat", "2026-01-04T00:00:00.000Z");
        return true;
      },
    });
    await racing.afterTurn("C-1");
    expect(s.store.tasks.get("C-1")?.title).toBe("Owner name");
    expect(s.store.chats.get("C-1").titledBy).toBe("owner");
  });
});
