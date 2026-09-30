import { join } from "node:path";
import type { ConfigService } from "../config/service.ts";
import type { Store } from "../store/index.ts";
import { openMemoryDb } from "./db.ts";
import type { Embedder } from "./embedder.ts";
import type { AgentScope } from "./mcp.ts";
import { agentScopes, type ProjectOrgs, recallScopes } from "./scopes.ts";
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
  ) {}

  private async projectOrgs(): Promise<ProjectOrgs> {
    const { projects } = await this.config.sections();
    return new Map(Object.entries(projects).map(([id, p]) => [id, p.org]));
  }

  /** For TASK.md: global, the org, and the projects of the task's repos. */
  async recall(task: string) {
    const t = this.store.tasks.get(task);
    return t === undefined ? undefined : recallScopes(t, await this.projectOrgs());
  }

  /** For agents: global, the org and every project of the org. */
  async agent(task: string): Promise<AgentScope | undefined> {
    const t = this.store.tasks.get(task);
    if (t === undefined) return undefined;
    return { org: t.org, scopes: agentScopes(t, await this.projectOrgs()) };
  }
}
