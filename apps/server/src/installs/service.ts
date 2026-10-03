import { randomUUID } from "node:crypto";
import type {
  CommandMeta,
  McpInstallInput,
  McpInstallResult,
  McpPreview,
  McpSearchResult,
  RoomItem,
  SkillInstallInput,
  SkillInstallResult,
  Task,
} from "@majhi/shared";
import { redactText } from "../admin/policy.ts";
import type { AdminService } from "../admin/service.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import { type InstallRequest, isRepoPage, type McpRef, parseInstallRequest } from "./parse.ts";

/** The parts of the other services this one uses, so a test can stand in for any of them. */
export interface InstallRequestDeps {
  tasks: { get(id: string): Task };
  room: Pick<RoomService, "post">;
  runs: Pick<RunManager, "postOwner">;
  admin: Pick<AdminService, "offer">;
  mcp: {
    search(query: string, limit: number): Promise<McpSearchResult[]>;
    install(input: McpInstallInput, meta: CommandMeta): Promise<McpInstallResult>;
  };
  skills: { install(input: SkillInstallInput, meta: CommandMeta): Promise<SkillInstallResult> };
  /** The agent's scope: an org id or `root`. Undefined when there is no such agent. */
  scopeOf(agent: string): Promise<string | undefined>;
}

/** How many registry matches a vague name lists. */
const CANDIDATES = 5;

const OWNER: CommandMeta["actor"] = { kind: "owner" };

/**
 * Install by message (Phase 6): the owner writes "@agent install this skill <link>" or "@agent add
 * this MCP server <name or link>" in a room. majhi reads it, looks up what it names and puts one card
 * in the room: what it is, where it comes from and which agent gets it. Approving installs it and
 * turns it on for that agent, nothing else. The message itself is not sent to the agent; the card is
 * the answer, and the agent hears the result when the owner decides.
 */
export class InstallRequests {
  constructor(private readonly deps: InstallRequestDeps) {}

  /**
   * Handles `text` when it is an install request. Returns the owner's item, or undefined when the
   * message is something else and should go to the agent as usual.
   */
  async offer(input: {
    task: string;
    text: string;
    agent?: string | undefined;
  }): Promise<RoomItem | undefined> {
    const request = parseInstallRequest(input.text);
    if (request === undefined) return undefined;
    const task = this.deps.tasks.get(input.task);
    if (task.status === "done") return undefined;
    const agent = this.target(task, input.text, input.agent);
    if (agent === undefined) return undefined;
    const scope = await this.deps.scopeOf(agent);
    if (scope === undefined) throw new UserError(`There is no agent @${agent}, or its file has errors.`, 404);
    // The message shows in the room at once. It is not delivered: the card answers it.
    const item = this.deps.runs.postOwner(task.id, agent, {
      text: input.text,
      attachments: [],
      mode: "interrupt",
    });
    try {
      await this.card(task, agent, scope, request);
    } catch (err) {
      this.say(task.id, "warn", `Could not set up the install: ${errorMessage(err)}`);
    }
    return item;
  }

  /** The agent the message is for: the one asked, else the first @mentioned on the team, else the lead. */
  private target(task: Task, text: string, requested: string | undefined): string | undefined {
    if (requested !== undefined) {
      if (!task.team.includes(requested)) throw new UserError(`@${requested} is not on this task.`);
      return requested;
    }
    for (const m of text.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9-]*)/gi)) {
      const id = m[1]?.toLowerCase();
      if (id !== undefined && task.team.includes(id)) return id;
    }
    return task.team[0];
  }

  private async card(task: Task, agent: string, scope: string, request: InstallRequest): Promise<void> {
    // An org agent gets the server in its own org. A root agent has no org of its own, so what is
    // installed from its room goes to the task's org and is not turned on for the agent.
    const org = scope === "root" ? task.org : scope;
    const enable = scope === "root" ? undefined : agent;
    const meta: CommandMeta = { actor: OWNER, task: task.id };
    const reason = "The owner asked for this in the room.";
    const where = enable === undefined ? "" : ` and turn it on for @${agent}`;

    if (request.kind === "skill") {
      const source = request.source;
      const preview = await this.deps.skills.install(
        { source, ...(request.skill === undefined ? {} : { skill: request.skill }), org },
        meta,
      );
      if (preview.status !== "preview") throw new UserError("Nothing to confirm.");
      const names = preview.skills.map((s) => s.name).join(", ");
      this.deps.admin.offer({
        task: task.id,
        agent,
        command: "skills.install",
        input: { confirm: preview.previewId, ...(enable === undefined ? {} : { enable }) },
        summary: `install the skill ${names} from ${source}${where}`,
        details: {
          source: preview.source,
          skills: preview.skills.map((s) => ({
            name: s.name,
            description: s.description,
            files: s.files.length,
            ...(s.replaces === undefined ? {} : { replaces: s.replaces }),
          })),
          ...(enable === undefined ? {} : { turnOnFor: agent }),
        },
        reason,
      });
      return;
    }

    const found = await this.mcpInput(task.id, request.ref);
    if (found === undefined) return;
    const preview = await this.deps.mcp.install({ ...found, org }, meta);
    if (preview.status !== "preview") throw new UserError("Nothing to confirm.");
    const missing = preview.inputs.filter((i) => i.required && (i.value === undefined || i.value === ""));
    if (missing.length > 0) {
      this.say(
        task.id,
        "warn",
        `${preview.name} needs ${missing.map((i) => i.name).join(", ")} before it can be installed. Add it on the MCP servers page, where you can give those values.`,
      );
      return;
    }
    this.deps.admin.offer({
      task: task.id,
      agent,
      command: "mcp.install",
      input: { confirm: preview.previewId, ...(enable === undefined ? {} : { enable }) },
      summary: `install the MCP server ${preview.name} (${sourceOf(preview)})${where}`,
      details: mcpDetails(preview, enable),
      reason,
    });
  }

  /** The `mcp.install` input for what the owner named, or undefined when a note was posted instead. */
  private async mcpInput(task: string, ref: McpRef): Promise<McpInstallInput | undefined> {
    switch (ref.type) {
      case "registry":
        return { registry: ref.name };
      case "command":
        return { command: ref.command };
      case "json":
        return { json: ref.json };
      case "url":
        if (isRepoPage(ref.url)) {
          this.say(
            task,
            "warn",
            `${ref.url} is a repository page, not a server address. Give the registry name or the server's own URL.`,
          );
          return undefined;
        }
        return { url: ref.url };
      case "search": {
        const found = await this.deps.mcp.search(ref.query, CANDIDATES);
        const q = ref.query.toLowerCase();
        const exact = found.filter(
          (s) =>
            s.name.toLowerCase() === q ||
            s.title?.toLowerCase() === q ||
            s.name.toLowerCase().split("/").pop() === q,
        );
        const only = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined;
        if (only !== undefined) return { registry: only.install.registry };
        this.say(
          task,
          "info",
          found.length === 0
            ? `The MCP registry has nothing called ${ref.query}. Give a registry name, a server URL or a command.`
            : `Which one? ${found.map((s) => `${s.name} (${s.description.slice(0, 80)})`).join("; ")}. Say "add this MCP server <name>".`,
        );
        return undefined;
      }
    }
  }

  private say(task: string, level: "info" | "warn", text: string): void {
    this.deps.room.post(task, `info:${randomUUID()}`, { type: "system", level, text: redactText(text) });
  }
}

/** Where a server comes from, in a few words for the card's first line. */
function sourceOf(p: McpPreview): string {
  if (p.source.registry !== undefined)
    return `registry ${p.source.registry.name} ${p.source.registry.version}`;
  if (p.url !== undefined) return p.url;
  return p.command ?? p.source.kind;
}

/** What the card's Details fold shows: everything the owner should weigh, and no values of secrets. */
function mcpDetails(p: McpPreview, enable: string | undefined): unknown {
  return {
    name: p.name,
    id: p.id,
    org: p.org,
    source: p.source,
    transport: p.transport,
    ...(p.protocol === undefined ? {} : { protocol: p.protocol }),
    ...(p.url === undefined ? {} : { url: p.url }),
    ...(p.command === undefined ? {} : { command: p.command }),
    headers: p.headers.map((h) => ({ name: h.name, kind: h.kind, required: h.required })),
    env: p.env.map((e) => ({ name: e.name, kind: e.kind, required: e.required })),
    warnings: p.warnings,
    ...(enable === undefined ? {} : { turnOnFor: enable }),
  };
}
