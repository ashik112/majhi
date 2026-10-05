import type { MemoryExtractOutput, MemorySettings, RoomItem, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { ChatMemory } from "./chats.ts";
import { Extraction } from "./extraction.ts";
import type { Candidate } from "./housekeeper.ts";
import { chatRecallScopes, writableScopes } from "./scopes.ts";

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

describe("chat memory scopes", () => {
  it("offers an org chat only its own org's scopes, and a root chat any org or project", async () => {
    const projectOrgs = new Map([
      ["acme-api", "acme"],
      ["globex-web", "globex"],
    ]);
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
        scopesFor: async (t: { org?: string }) => writableScopes(t, projectOrgs, ["acme", "globex"]),
        curateCandidates: async (t: { org?: string; projects: string[] }, c: Candidate[]) => {
          seen.push({ org: t.org, projects: t.projects, candidates: c });
          return {} as MemoryExtractOutput;
        },
      } as never,
      memory: { changed: () => undefined } as never,
      registry: async () => ({
        orgs: [{ id: "acme" }, { id: "globex" }],
        projects: [...projectOrgs].map(([id, org]) => ({ id, org })),
      }),
    } as never);
    const items = [] as RoomItem[];
    await extraction.fromChat(chat("C-1"), items, ["acme-api"], () => undefined);
    await extraction.fromChat(chat("C-2", { org: undefined }), items, ["acme-api"], () => undefined);
    expect(prompts[0]).toContain("project:acme-api");
    expect(prompts[0]).toContain("org:acme");
    expect(prompts[0]).not.toContain("org:globex");
    expect(prompts[0]).not.toContain("project:globex-web");
    expect(prompts[1]).toContain("project:acme-api");
    expect(prompts[1]).toContain("org:globex");
    expect(seen[1]).toMatchObject({ org: undefined, projects: ["acme-api"] });
    // An older reply's facts are lessons the agent inferred, not the owner's words.
    expect(seen[0]?.candidates).toEqual([
      { text: "Staging is called Northwind", scope: "org:globex", kind: "lesson", source: "agent" },
    ]);
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
      "org:acme",
      "project:globex-web",
      "org:globex",
    ]);
  });
});

describe("chat titles", () => {
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
