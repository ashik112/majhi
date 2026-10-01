import { join } from "node:path";
import type { ConfigService } from "../config/service.ts";
import type { Store } from "../store/index.ts";
import { type MentionableProject, mentionedProjects } from "./chat-projects.ts";
import { openMemoryDb } from "./db.ts";
import type { Embedder } from "./embedder.ts";
import type { AgentScope } from "./mcp.ts";
import { agentScopes, chatRecallScopes, type ProjectOrgs, recallScopes } from "./scopes.ts";
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";
import { TransformersEmbedder } from "./transformers.ts";

/** `<majhi home>/memory/memory.db`, the model cache `<majhi home>/cache/models`. */
export function createMemory(majhiHome: string, embedder?: Embedder): MemoryService {
  return new MemoryService({
    store: new MemoryStore(openMemoryDb(join(majhiHome, "memory", "memory.db"))),
    embedder: embedder ?? new TransformersEmbedder({ cacheDir: join(majhiHome, "cache", "models") }),
  });
}

/** Which scopes a task's memory covers, from its org and the projects registered now. */
export class TaskScopes {
  constructor(
    private readonly store: Store,
    private readonly config: ConfigService,
    /** The registered projects with their paths, to see which ones a chat names. */
    private readonly projects: () => Promise<MentionableProject[]> = async () => [],
  ) {}

  /** The registered projects a chat names or reads, by what the owner wrote and the agent opened. */
  async mentioned(task: string): Promise<string[]> {
    const t = this.store.tasks.get(task);
    if (t === undefined) return [];
    const all = await this.projects();
    // A chat with an org agent never names another org's project; a root chat may name any.
    const mine = t.org === undefined ? all : all.filter((p) => p.org === t.org);
    return mentionedProjects(t, this.store.room.page(task, 400).items, mine);
  }

  private async projectOrgs(): Promise<ProjectOrgs> {
    const { projects } = await this.config.sections();
    return new Map(Object.entries(projects).map(([id, p]) => [id, p.org]));
  }

  /** For TASK.md: global, the org, and the projects of the task's repos (a chat: the ones it names or reads). */
  async recall(task: string) {
    const t = this.store.tasks.get(task);
    if (t === undefined) return undefined;
    const orgs = await this.projectOrgs();
    if (t.kind !== "chat") return recallScopes(t, orgs);
    return chatRecallScopes(t, orgs, await this.mentioned(task));
  }

  /** For agents: global, the org and every project of the org. */
  async agent(task: string): Promise<AgentScope | undefined> {
    const t = this.store.tasks.get(task);
    if (t === undefined) return undefined;
    return { org: t.org, scopes: agentScopes(t, await this.projectOrgs()) };
  }
}
