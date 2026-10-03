import { randomBytes } from "node:crypto";
import {
  type CommandMeta,
  type ConnectionCreateInput,
  type ConnectionView,
  type McpAgentInput,
  type McpInstallInput,
  type McpInstallResult,
  type McpNeed,
  type McpPreview,
  type McpSearchResult,
  suggestConnectionId,
  TOOL_CATALOG,
} from "@majhi/shared";
import { auditActor, auditDetail } from "../audit.ts";
import type { ConnectionService } from "../connections/service.ts";
import type { ConnectionTester } from "../connections/tester.ts";
import { UserError } from "../errors.ts";
import type { AuditRow } from "../store/runs.ts";
import { actorName } from "../tasks/cards.ts";
import { type Draft, type DraftEntry, fromCommand, fromRegistry, fromSnippet, fromUrl } from "./draft.ts";
import type { McpRegistry } from "./registry.ts";

/** A preview stays valid this long, and is used once. */
export const MCP_PREVIEW_TTL_MS = 30 * 60_000;

/** The parts of the agent service MCP servers use: the agent files' `connections` lists. */
export interface McpAgents {
  /** Each agent's id, scope (an org id or `root`) and the connections its file lists. */
  connectionLists(): Promise<{ id: string; scope: string; connections: string[] }[]>;
  /** Replaces the `connections` list in the agent's file. */
  setConnections(agent: string, list: string[], command: string, meta: CommandMeta): Promise<void>;
}

export interface McpServiceDeps {
  connections: Pick<ConnectionService, "create" | "get" | "find" | "list">;
  tester: Pick<ConnectionTester, "test">;
  registry: Pick<McpRegistry, "search" | "get">;
  agents: McpAgents;
  /** The ids of the orgs. */
  orgs: () => Promise<string[]>;
  audit: (row: AuditRow) => void;
  now?: () => Date;
}

interface Pending {
  draft: Draft;
  org: string;
  id: string;
  name: string;
  description: string;
  by: string;
  expiresAt: number;
}

/** The names agents cannot use as a connection id: majhi's own MCP servers. */
const RESERVED_IDS: ReadonlySet<string> = new Set(TOOL_CATALOG.map((t) => t.name));

/**
 * MCP servers: found in the registry or described by the owner, shown in a preview, then created as
 * an `mcp` connection and tested. The connection is the only record: enabling a server for an agent
 * adds it to the agent file's `connections` list, and Phase 10's gate and run injection do the rest.
 * Nothing is enabled by installing.
 */
export class McpService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: McpServiceDeps) {}

  async search(query: string, limit: number): Promise<McpSearchResult[]> {
    const found = await this.deps.registry.search(query, limit);
    return found.map((s) => ({
      name: s.name,
      ...(s.title ? { title: s.title } : {}),
      description: s.description ?? "",
      version: s.version ?? "latest",
      publisher: s.name.includes("/") ? s.name.slice(0, s.name.indexOf("/")) : s.name,
      ...(s.repository?.url ? { repository: s.repository.url } : {}),
      ...(s.websiteUrl ? { websiteUrl: s.websiteUrl } : {}),
      transports: [
        ...new Set([
          ...(s.remotes ?? []).map((r) => r.type),
          ...(s.packages ?? []).map((p) => p.transport?.type ?? "stdio"),
        ]),
      ],
      packages: [...new Set((s.packages ?? []).map((p) => p.registryType))],
      install: { registry: s.name },
    }));
  }

  async install(input: McpInstallInput, meta: CommandMeta): Promise<McpInstallResult> {
    const by = actorName(meta.actor);
    this.prune();
    if (input.confirm !== undefined) return this.confirm(input.confirm, by, meta, input.enable);
    const draft = await this.draft(input);
    const org = await this.org(input.org);
    const taken = new Set([...(await this.deps.connections.list()).map((c) => c.id), ...RESERVED_IDS]);
    const name = input.name ?? draft.title;
    const id = input.id ?? suggestConnectionId(input.name ?? draft.idBase, taken);
    const description = input.description ?? draft.description;
    const previewId = `mcp_${randomBytes(9).toString("base64url")}`;
    const expiresAt = this.now().getTime() + MCP_PREVIEW_TTL_MS;
    this.pending.set(previewId, { draft, org, id, name, description, by, expiresAt });
    return preview(previewId, { draft, org, id, name, description, expiresAt });
  }

  async enable(input: McpAgentInput, command: string, meta: CommandMeta): Promise<ConnectionView> {
    const list = await this.agentList(input);
    if (list.includes(input.connection)) return this.deps.connections.get(input.connection);
    await this.deps.agents.setConnections(input.agent, [...list, input.connection], command, meta);
    this.log(
      meta,
      "mcp-enable",
      `Turn on ${input.connection} for @${input.agent}`,
      `${input.connection} for @${input.agent}`,
    );
    return this.deps.connections.get(input.connection);
  }

  async disable(input: McpAgentInput, command: string, meta: CommandMeta): Promise<ConnectionView> {
    const found = await this.deps.connections.find(input.connection);
    if (found === undefined) throw new UserError(`There is no connection ${input.connection}.`, 404);
    const agent = (await this.deps.agents.connectionLists()).find((a) => a.id === input.agent);
    if (agent === undefined)
      throw new UserError(`There is no agent @${input.agent}, or its file has errors.`, 404);
    if (agent.connections.includes(input.connection)) {
      await this.deps.agents.setConnections(
        input.agent,
        agent.connections.filter((c) => c !== input.connection),
        command,
        meta,
      );
      this.log(
        meta,
        "mcp-disable",
        `Turn off ${input.connection} for @${input.agent}`,
        `${input.connection} for @${input.agent}`,
      );
    }
    return this.deps.connections.get(input.connection);
  }

  private async draft(input: McpInstallInput): Promise<Draft> {
    if (input.registry !== undefined) {
      const server = await this.deps.registry.get(input.registry, input.version);
      return fromRegistry(server, { via: input.via, values: input.values });
    }
    if (input.url !== undefined) {
      return fromUrl({
        url: input.url,
        protocol: input.protocol,
        headers: input.headers,
        secrets: input.secrets,
      });
    }
    if (input.command !== undefined) {
      return fromCommand({ command: input.command, env: input.env, secrets: input.secrets });
    }
    return fromSnippet(input.json ?? "", { pick: input.pick, secrets: input.secrets });
  }

  private async org(wanted: string | undefined): Promise<string> {
    const orgs = await this.deps.orgs();
    if (wanted !== undefined) {
      if (!orgs.includes(wanted)) throw new UserError(`Org "${wanted}" does not exist.`, 404);
      return wanted;
    }
    const [only] = orgs;
    if (orgs.length !== 1 || only === undefined) {
      throw new UserError(`Say which org gets the server (org): ${orgs.join(", ") || "there are none yet"}.`);
    }
    return only;
  }

  private async confirm(
    previewId: string,
    by: string,
    meta: CommandMeta,
    enable: string | undefined,
  ): Promise<McpInstallResult> {
    const pending = this.pending.get(previewId);
    if (pending === undefined) {
      throw new UserError("That preview is gone. Look the server up again to see what it holds.", 404);
    }
    // An agent installs only what it previewed itself, never what someone else previewed.
    if (meta.actor.kind === "agent" && pending.by !== by) {
      throw new UserError("That preview belongs to someone else. Look the server up again.", 409);
    }
    const missing = pending.draft.inputs.filter(
      (i) => i.required && (i.value === undefined || i.value === ""),
    );
    if (missing.length > 0) {
      throw new UserError(
        `Fill in ${missing.map((i) => i.name).join(", ")} first: preview again with values.`,
        409,
      );
    }
    // Refused before anything is created, so a bad agent never leaves a half-done install.
    if (enable !== undefined) await this.eligible(enable, pending.org, pending.id);
    this.pending.delete(previewId);
    const { draft } = pending;
    const created = await this.deps.connections.create(createInput(pending), "mcp.install", meta);
    const origin = draft.source.registry
      ? `registry ${draft.source.registry.name}@${draft.source.registry.version}`
      : draft.transport === "remote"
        ? `${draft.url ?? ""}`
        : `${draft.command ?? ""}`;
    this.log(
      meta,
      "mcp-install",
      `Install ${pending.name}`,
      `${created.id} (${pending.org}), ${draft.transport} server from ${origin}`,
    );
    if (enable !== undefined)
      await this.enable({ connection: created.id, agent: enable }, "mcp.install", meta);
    const needs = needsOf(draft);
    // Test refuses while a secret is missing, so it waits for the owner to set it.
    const test = needs.length === 0 ? await this.deps.tester.test(created.id) : undefined;
    return {
      status: "installed",
      connection: await this.deps.connections.get(created.id),
      needs,
      ...(test === undefined ? {} : { test }),
    };
  }

  /** The agent file's list, after checking that the connection may be turned on for that agent. */
  private async agentList(input: McpAgentInput): Promise<string[]> {
    const found = await this.deps.connections.find(input.connection);
    if (found === undefined) throw new UserError(`There is no connection ${input.connection}.`, 404);
    if (found.connection.type !== "mcp") {
      throw new UserError(
        `${input.connection} is not an MCP server. Other connections are set up on the Connections page.`,
      );
    }
    return (await this.eligible(input.agent, found.org, input.connection)).connections;
  }

  /** The agent, when a server of `org` may be turned on for it: an agent of that org, not a root agent. */
  private async eligible(agentId: string, org: string, connection: string) {
    const agent = (await this.deps.agents.connectionLists()).find((a) => a.id === agentId);
    if (agent === undefined)
      throw new UserError(`There is no agent @${agentId}, or its file has errors.`, 404);
    if (agent.scope === "root") {
      throw new UserError(
        `@${agentId} is a root agent: it gets every connection of a task's org and attaches others with majhi-connections, so it has no switch per server.`,
      );
    }
    if (agent.scope !== org) {
      throw new UserError(
        `@${agentId} belongs to org ${agent.scope} and ${connection} to org ${org}. An agent only uses its own org's connections.`,
      );
    }
    return agent;
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(meta: CommandMeta, kind: string, title: string, detail: string): void {
    this.deps.audit({
      task: meta.task ?? "",
      ...auditActor(actorName(meta.actor)),
      kind,
      title,
      decision: "done",
      at: this.now().toISOString(),
      detail: auditDetail(detail),
    });
  }
}

/** The headers or variables as a connection stores them: text with its value, a secret empty. */
function entryRecord(
  list: readonly DraftEntry[],
): Record<string, { kind: "secret" | "text"; value?: string }> {
  return Object.fromEntries(
    list.map((e) => [
      e.name,
      e.kind === "text" && e.value !== undefined ? { kind: e.kind, value: e.value } : { kind: e.kind },
    ]),
  );
}

function createInput(
  p: Pick<Pending, "draft" | "org" | "id" | "name" | "description">,
): ConnectionCreateInput {
  const { draft } = p;
  const fields: Record<string, string> = { transport: draft.transport };
  if (draft.transport === "remote") {
    fields.url = draft.url ?? "";
    if (draft.protocol === "sse") fields.protocol = "sse";
  } else {
    fields.command = draft.command ?? "";
  }
  return {
    org: p.org,
    id: p.id,
    type: "mcp",
    name: p.name,
    ...(p.description === "" ? {} : { description: p.description }),
    fields,
    ...(draft.transport === "remote"
      ? { headers: entryRecord(draft.headers) }
      : { env: entryRecord(draft.env) }),
  };
}

function needsOf(draft: Draft): McpNeed[] {
  const of = (list: "headers" | "env", entries: readonly DraftEntry[]): McpNeed[] =>
    entries
      .filter((e) => e.kind === "secret")
      .map((e) => ({
        list,
        name: e.name,
        required: e.required,
        ...(e.description ? { description: e.description } : {}),
      }));
  return draft.transport === "remote" ? of("headers", draft.headers) : of("env", draft.env);
}

function preview(
  previewId: string,
  p: Pick<Pending, "draft" | "org" | "id" | "name" | "description" | "expiresAt">,
): McpPreview {
  const { draft } = p;
  const shown = (e: DraftEntry) => ({
    name: e.name,
    kind: e.kind,
    required: e.required,
    ...(e.description ? { description: e.description } : {}),
    ...(e.value === undefined ? {} : { value: e.value }),
  });
  return {
    status: "preview",
    previewId,
    org: p.org,
    id: p.id,
    name: p.name,
    description: p.description,
    source: draft.source,
    transport: draft.transport,
    ...(draft.protocol === undefined ? {} : { protocol: draft.protocol }),
    ...(draft.url === undefined ? {} : { url: draft.url }),
    ...(draft.command === undefined ? {} : { command: draft.command }),
    headers: draft.headers.map(shown),
    env: draft.env.map(shown),
    inputs: draft.inputs,
    warnings: draft.warnings,
    expiresAt: new Date(p.expiresAt).toISOString(),
  };
}
