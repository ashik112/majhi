import { type CommandName, commands, PRIVATE } from "@majhi/shared";
import type { z } from "zod";

/**
 * What a captain lane may read (SPEC 5.18): one workspace's rows only. Generic on purpose, so a new
 * command is covered without anyone listing it here:
 * - a filter for another workspace in a read's input is refused;
 * - an `org` filter the command takes (at the top or one level down, like usage's `filters.org`) is
 *   set to the lane's workspace, so totals and pages count only its rows;
 * - every row in the output that belongs to another workspace is dropped, wherever it sits, and so is
 *   every record key that names another workspace.
 * A row belongs to a workspace by its `org`, its memory or agent `scope`, the task, project, account or
 * agent it names, or its own `id` or `key` when that is a task, account, project, workspace or agent.
 * Rows that name none (a model, a day, a price) belong to every lane. Pure.
 */

/** majhi's registries, to tell which workspace a name belongs to. */
export interface ScopeWorld {
  /** Every workspace id, `private` included. */
  orgs: ReadonlySet<string>;
  /** A task's workspace, `private` for a task with no org; undefined for no such task. */
  task(id: string): string | undefined;
  project(id: string): string | undefined;
  account(id: string): string | undefined;
  /** An agent's workspace; undefined for a root agent or no such agent. */
  agent(id: string): string | undefined;
  /** Each client workspace's id and name, to spot one named in free text. Private is the owner's own. */
  names: ReadonlyMap<string, string>;
}

const TASK_ID = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The workspace a scope names: `org:acme`, `project:api`, a workspace id. Root and global are everyone's. */
function scopeWorkspace(scope: string, world: ScopeWorld): string | undefined {
  if (scope === "root" || scope === "global") return undefined;
  if (scope.startsWith("org:")) return scope.slice(4);
  if (scope.startsWith("project:")) return world.project(scope.slice(8));
  return world.orgs.has(scope) ? scope : undefined;
}

/**
 * The workspace a bare name belongs to, by every registry in turn. A prefixed name like
 * `account:claude-acme` or `project:api` is looked up by what follows the prefix.
 */
function nameWorkspace(name: string, world: ScopeWorld): string | undefined {
  if (TASK_ID.test(name)) return world.task(name);
  const direct =
    world.account(name) ?? world.project(name) ?? (world.orgs.has(name) ? name : world.agent(name));
  if (direct !== undefined) return direct;
  const colon = name.lastIndexOf(":");
  return colon > 0 && colon < name.length - 1 ? nameWorkspace(name.slice(colon + 1), world) : undefined;
}

/** The workspace a row belongs to, or undefined when it names none. Rows nested in it count too. */
export function rowWorkspace(row: Record<string, unknown>, world: ScopeWorld, depth = 0): string | undefined {
  const own = ownWorkspace(row, world);
  if (own !== undefined || depth >= 2) return own;
  // A row that wraps another, like a search hit around its fact or an agent's file around its frontmatter.
  for (const value of Object.values(row)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const inner = rowWorkspace(value as Record<string, unknown>, world, depth + 1);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** The workspace another client workspace's id or name in free text points at, if any but the lane's. */
function mentions(text: string, lane: string, world: ScopeWorld): string | undefined {
  // A task, project, account or agent of another workspace named in the text.
  for (const token of text.match(/[A-Za-z0-9][A-Za-z0-9_.:/-]*[A-Za-z0-9]/g) ?? []) {
    const of = nameWorkspace(token, world);
    if (of !== undefined && of !== lane) return of;
  }
  for (const [org, name] of world.names) {
    if (org === lane) continue;
    for (const word of new Set([org, name])) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, "i").test(text)) return org;
    }
  }
  return undefined;
}

/** A row with no workspace of its own that names another one in its text, like a history line. */
function textWorkspace(value: unknown, lane: string, world: ScopeWorld): string | undefined {
  if (typeof value === "string") return mentions(value, lane, world);
  if (typeof value !== "object" || value === null) return undefined;
  for (const v of Object.values(value)) {
    if (typeof v === "string") {
      const of = mentions(v, lane, world);
      if (of !== undefined) return of;
    }
  }
  return undefined;
}

function ownWorkspace(row: Record<string, unknown>, world: ScopeWorld): string | undefined {
  const org = str(row.org);
  if (org !== undefined) return org;
  const scope = str(row.scope);
  if (scope !== undefined) {
    const of = scopeWorkspace(scope, world);
    if (of !== undefined) return of;
  }
  const fm = row.frontmatter;
  if (typeof fm === "object" && fm !== null) {
    const agentScope = str((fm as { scope?: unknown }).scope);
    if (agentScope !== undefined) return scopeWorkspace(agentScope, world);
  }
  const task = str(row.task);
  if (task !== undefined && TASK_ID.test(task)) {
    const of = world.task(task);
    if (of !== undefined) return of;
  }
  const project = str(row.project);
  if (project !== undefined) {
    const of = world.project(project);
    if (of !== undefined) return of;
  }
  const account = str(row.account);
  if (account !== undefined) {
    const of = world.account(account);
    if (of !== undefined) return of;
  }
  for (const key of ["id", "key", "agent"] as const) {
    const name = str(row[key]);
    if (name === undefined) continue;
    const of = nameWorkspace(name, world);
    if (of !== undefined) return of;
  }
  return undefined;
}

/** The workspaces a read's input asks about: its own fields, and the lists of names it carries. */
function inputWorkspaces(input: Record<string, unknown>, world: ScopeWorld): string[] {
  const out: string[] = [];
  const add = (w: string | undefined) => {
    if (w !== undefined) out.push(w);
  };
  add(rowWorkspace(input, world));
  for (const value of Object.values(input)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string") add(scopeWorkspace(v, world) ?? nameWorkspace(v, world));
        else if (typeof v === "object" && v !== null) add(rowWorkspace(v as Record<string, unknown>, world));
      }
    } else if (typeof value === "object" && value !== null) {
      add(rowWorkspace(value as Record<string, unknown>, world));
    }
  }
  return out;
}

/** Why a lane may not make this read: it asks about another workspace. */
export function readRefusal(
  lane: string,
  input: Record<string, unknown>,
  world: ScopeWorld,
  name: (org: string) => string,
): string | undefined {
  const other = inputWorkspaces(input, world).find((w) => w !== lane);
  if (other === undefined) return undefined;
  return `Refused: this lane works in ${name(lane)} only and cannot read ${name(other)}. Each workspace has its own lane.`;
}

/** The fields named `org` a command's input takes: `org` itself, or `org` inside one object field. */
function orgFields(command: CommandName): string[][] {
  const schema = commands[command].input as z.ZodType;
  const shape = shapeOf(schema);
  if (shape === undefined) return [];
  const out: string[][] = [];
  for (const [key, field] of Object.entries(shape)) {
    if (key === "org") out.push(["org"]);
    const inner = shapeOf(field);
    if (inner !== undefined && "org" in inner) out.push([key, "org"]);
  }
  return out;
}

/** An object schema's fields, through defaults and optionals. */
function shapeOf(schema: unknown): Record<string, unknown> | undefined {
  let s = schema as { shape?: unknown; unwrap?: () => unknown; def?: { innerType?: unknown } } | undefined;
  for (let i = 0; i < 5 && s !== undefined; i++) {
    if (typeof s.shape === "object" && s.shape !== null) return s.shape as Record<string, unknown>;
    const next = s.def?.innerType ?? (typeof s.unwrap === "function" ? s.unwrap() : undefined);
    s = next as typeof s;
  }
  return undefined;
}

/**
 * The input with every `org` filter the command takes set to the lane's workspace, when it is a
 * client workspace and the result still parses. Private tasks have no org to filter by: for Private
 * the output is narrowed instead.
 */
export function forceOrg(
  command: CommandName,
  input: Record<string, unknown>,
  lane: string,
): Record<string, unknown> {
  if (lane === PRIVATE) return input;
  let next: Record<string, unknown> = input;
  for (const path of orgFields(command)) {
    if (path.length === 1) next = { ...next, org: lane };
    else {
      const [key] = path as [string];
      const inner = next[key];
      next = { ...next, [key]: { ...(typeof inner === "object" && inner !== null ? inner : {}), org: lane } };
    }
  }
  if (next === input) return input;
  return commands[command].input.safeParse(next).success ? next : input;
}

/**
 * The output with every row and record key of another workspace taken out, at any depth. A top-level
 * row of another workspace is refused instead: `refused` says why.
 */
export function narrow(
  value: unknown,
  lane: string,
  world: ScopeWorld,
  name: (org: string) => string,
): { value: unknown; refused?: string } {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const own = rowWorkspace(value as Record<string, unknown>, world);
    if (own !== undefined && own !== lane) {
      return {
        value: undefined,
        refused: `Refused: that belongs to ${name(own)}, and this lane works in ${name(lane)} only.`,
      };
    }
  }
  return { value: prune(value, lane, world) };
}

function prune(value: unknown, lane: string, world: ScopeWorld): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const of = rowWorkspace(item as Record<string, unknown>, world) ?? textWorkspace(item, lane, world);
        if (of !== undefined && of !== lane) return [];
      }
      // A list of names, like the agents or workspaces a filter offers.
      if (typeof item === "string") {
        const of = scopeWorkspace(item, world) ?? nameWorkspace(item, world) ?? mentions(item, lane, world);
        if (of !== undefined && of !== lane) return [];
      }
      return [prune(item, lane, world)];
    });
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      // A record keyed by workspace, like settings' per-workspace entries: only the lane's own.
      if (world.orgs.has(key) && key !== lane) continue;
      // A field that names another workspace's task, project, account or agent, like a chat id.
      if (typeof v === "string") {
        const of = nameWorkspace(v, world);
        if (of !== undefined && of !== lane) continue;
      }
      out[key] = prune(v, lane, world);
    }
    return out;
  }
  return value;
}
