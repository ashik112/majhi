import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CONNECTION_LISTS,
  type CommandMeta,
  type ConnectionConfig,
  ConnectionConfigSchema,
  type ConnectionCreateInput,
  type ConnectionEntry,
  type ConnectionEntryInput,
  type ConnectionListKey,
  type ConnectionSetFileInput,
  type ConnectionSetSecretInput,
  type ConnectionTestResult,
  type ConnectionType,
  type ConnectionUpdateInput,
  type ConnectionValueView,
  type ConnectionView,
  connectionProblems,
  connectionType,
  type FieldKind,
  formatIssue,
  type OrgConfig,
  suggestConnectionId,
  TOOL_CATALOG,
} from "@majhi/shared";
import type { AgentStore, StoredAgent } from "../agents/store.ts";
import type { ConfigSections } from "../config/sections.ts";
import type { ConfigService } from "../config/service.ts";
import { removeConnectionEntry, writeConnection } from "../config/write.ts";
import { errorCode, formatIssues, UserError } from "../errors.ts";
import type { SecretService } from "../secrets/service.ts";
import type { SecretStore } from "../secrets/store.ts";
import { assertConnectionFile, type UploadStore } from "../uploads/store.ts";

/** Under the majhi home: one folder of files per connection. Never in the config history. */
export const CONNECTIONS_DIR_NAME = "connections";

/** `~/.majhi/connections/<id>/`: the files of one connection, readable by the owner only. */
export function connectionDir(majhiHome: string, id: string): string {
  return join(majhiHome, CONNECTIONS_DIR_NAME, id);
}

/** The name a file field, or a file entry of a list, is kept under in the connection's folder. */
export function connectionFileName(field: string, list?: ConnectionListKey): string {
  return list === undefined ? field : `${list}-${field}`;
}

const SECRET = "secret:";
const FILE = "file:";

/** majhi's own MCP servers: a connection's MCP server takes its id as its name. */
const RESERVED_IDS: ReadonlySet<string> = new Set(TOOL_CATALOG.map((t) => t.name));

export interface ConnectionDeps {
  config: ConfigService;
  secrets: SecretStore;
  secretService: SecretService;
  uploads: UploadStore;
  agents: AgentStore;
  majhiHome: string;
}

interface Found {
  org: string;
  entry: OrgConfig;
  connection: ConnectionConfig;
}

/**
 * The connections on disk (SPEC 5.14): definitions under their org in majhi.yaml, secret values in
 * secrets.age, files in ~/.majhi/connections/<id>/. Each change is one config commit. A view never
 * carries a secret's value, only whether one is set.
 */
export class ConnectionService {
  /** The last Test of each connection since majhi started. */
  private readonly tests = new Map<string, ConnectionTestResult>();

  constructor(private readonly deps: ConnectionDeps) {}

  list(org?: string): Promise<ConnectionView[]> {
    return this.views((o) => org === undefined || o === org);
  }

  async get(id: string): Promise<ConnectionView> {
    const [view] = await this.views(() => true, id);
    if (view === undefined) throw new UserError(`There is no connection ${id}.`, 404);
    return view;
  }

  /** The stored connection and its org. */
  async find(id: string): Promise<{ org: string; connection: ConnectionConfig } | undefined> {
    const found = findConnection(await this.deps.config.sections(), id);
    return found === undefined ? undefined : { org: found.org, connection: found.connection };
  }

  /** True when the connection points at a secret: a run or a Test sends it where the connection says. */
  async holdsSecret(id: string): Promise<boolean> {
    const found = await this.find(id);
    return found !== undefined && storedValues(found.connection).some((v) => v.startsWith(SECRET));
  }

  /** The folder of a connection's files. */
  dir(id: string): string {
    return connectionDir(this.deps.majhiHome, id);
  }

  recordTest(id: string, result: ConnectionTestResult): void {
    this.tests.set(id, result);
  }

  async create(input: ConnectionCreateInput, command: string, meta: CommandMeta): Promise<ConnectionView> {
    // An id is also the name of the connection's MCP server, so it never takes one of majhi's own.
    if (input.id !== undefined && RESERVED_IDS.has(input.id)) {
      throw new UserError(`${input.id} is the name of one of majhi's own tools. Pick another id.`);
    }
    const id =
      input.id ??
      suggestConnectionId(input.name, new Set([...allIds(await this.sections()), ...RESERVED_IDS]));
    await this.deps.config.change({ command, meta, summary: `added connection ${id}` }, async () => {
      const sections = await this.sections();
      const entry = sections.orgs[input.org];
      if (entry === undefined) throw new UserError(`Org "${input.org}" does not exist.`, 404);
      const owner = findConnection(sections, id);
      if (owner !== undefined) {
        throw new UserError(
          `There is already a connection ${id}, in ${owner.org}. A connection id is unique across orgs.`,
          409,
        );
      }
      const connection: ConnectionConfig = { type: input.type, name: input.name };
      if (input.description) connection.description = input.description;
      const fields = textFields(input.type, input.fields ?? {}, {});
      if (Object.keys(fields).length > 0) connection.fields = fields;
      for (const key of CONNECTION_LISTS) {
        const given = input[key];
        if (given === undefined) continue;
        const { entries } = nextEntries(input.type, key, given, {});
        if (Object.keys(entries).length > 0) connection[key] = entries;
      }
      await writeConnection(this.deps.config.file, input.org, entry, id, checked(connection));
    });
    return this.get(id);
  }

  /** Changes what the input names. A list given replaces the old one; what it drops is deleted. */
  async update(input: ConnectionUpdateInput, command: string, meta: CommandMeta): Promise<ConnectionView> {
    const released: string[] = [];
    await this.deps.config.change({ command, meta, summary: `edited connection ${input.id}` }, async () => {
      const found = await this.require(input.id);
      const next: ConnectionConfig = { ...found.connection };
      if (input.name !== undefined) next.name = input.name;
      if (input.description === "") delete next.description;
      else if (input.description !== undefined) next.description = input.description;
      if (input.fields !== undefined) {
        const fields = textFields(next.type, input.fields, next.fields ?? {});
        if (Object.keys(fields).length > 0) next.fields = fields;
        else delete next.fields;
      }
      for (const key of CONNECTION_LISTS) {
        const given = input[key];
        if (given === undefined) continue;
        const { entries, dropped } = nextEntries(next.type, key, given, next[key] ?? {});
        released.push(...dropped);
        if (Object.keys(entries).length > 0) next[key] = entries;
        else delete next[key];
      }
      await writeConnection(this.deps.config.file, found.org, found.entry, input.id, checked(next));
    });
    await this.release(input.id, released);
    return this.get(input.id);
  }

  /**
   * Removes the connection from majhi.yaml and from the agents that list it, then deletes its files
   * and the secrets nothing else names.
   */
  async remove(id: string, command: string, meta: CommandMeta): Promise<{ removed: string }> {
    let released: string[] = [];
    await this.deps.config.change({ command, meta, summary: `removed connection ${id}` }, async () => {
      const found = await this.require(id);
      released = storedValues(found.connection);
      await removeConnectionEntry(this.deps.config.file, found.org, id);
      for (const stored of await this.deps.agents.list()) {
        if (!stored.ok || !stored.agent.frontmatter.connections.includes(id)) continue;
        const frontmatter = stored.agent.frontmatter;
        await this.deps.agents.write({
          ...stored.agent,
          frontmatter: { ...frontmatter, connections: frontmatter.connections.filter((c) => c !== id) },
        });
      }
    });
    await this.release(id, released);
    await rm(this.dir(id), { recursive: true, force: true });
    this.tests.delete(id);
    return { removed: id };
  }

  /** Stores a secret value in secrets.age, or points the field at a secret already there. */
  async setSecret(
    input: ConnectionSetSecretInput,
    command: string,
    meta: CommandMeta,
  ): Promise<ConnectionView> {
    const released: string[] = [];
    const summary = `set ${input.field} of connection ${input.id}`;
    await this.deps.config.change({ command, meta, summary }, async () => {
      const found = await this.require(input.id);
      const target = targetOf(found.connection, input.field, input.list);
      if (target.kind !== "secret") throw new UserError(`${target.label} is a ${target.kind}, not a secret.`);
      let ref: string;
      let created: string | undefined;
      if (input.ref !== undefined) {
        const name = input.ref.slice(SECRET.length);
        if (!(await this.deps.secrets.has(name))) throw new UserError(`There is no secret ${name}.`, 404);
        ref = input.ref;
      } else if (input.value !== undefined) {
        const saved = await this.deps.secretService.save({
          value: input.value,
          label: `${input.id} ${input.field}`,
        });
        ref = saved.ref;
        created = saved.name;
      } else {
        throw new UserError("Give the value or a secret: reference.");
      }
      const next = withValue(found.connection, input.field, input.list, ref);
      try {
        await writeConnection(this.deps.config.file, found.org, found.entry, input.id, checked(next));
      } catch (err) {
        if (created !== undefined) await this.deps.secrets.delete(created);
        throw err;
      }
      if (target.current !== undefined && target.current !== ref) released.push(target.current);
    });
    await this.release(input.id, released);
    return this.get(input.id);
  }

  /** Moves an upload into the connection's folder, owner-only, as the value of a file field or entry. */
  async setFile(input: ConnectionSetFileInput, command: string, meta: CommandMeta): Promise<ConnectionView> {
    const summary = `set ${input.field} of connection ${input.id}`;
    await this.deps.config.change({ command, meta, summary }, async () => {
      const found = await this.require(input.id);
      const target = targetOf(found.connection, input.field, input.list);
      if (target.kind !== "file") throw new UserError(`${target.label} is a ${target.kind}, not a file.`);
      const upload = await this.deps.uploads.describe(input.upload);
      if (upload.org !== undefined && upload.org !== found.org) {
        throw new UserError("That file comes from a task of another org.", 409);
      }
      assertConnectionFile(upload.name, upload.size);
      const name = connectionFileName(input.field, input.list);
      await this.putFile(input.id, name, input.upload);
      const next = withValue(found.connection, input.field, input.list, `${FILE}${name}`);
      await writeConnection(this.deps.config.file, found.org, found.entry, input.id, checked(next));
    });
    return this.get(input.id);
  }

  /** Sets the exact write actions the org allows without asking the owner. */
  async setAllow(
    id: string,
    allow: readonly string[],
    command: string,
    meta: CommandMeta,
  ): Promise<ConnectionView> {
    const summary = `set what connection ${id} may change without asking`;
    await this.deps.config.change({ command, meta, summary }, async () => {
      const found = await this.require(id);
      const next: ConnectionConfig = { ...found.connection };
      const actions = [...new Set(allow.map((a) => a.trim()).filter((a) => a !== ""))];
      if (actions.length > 0) next.allow = actions;
      else delete next.allow;
      await writeConnection(this.deps.config.file, found.org, found.entry, id, checked(next));
    });
    return this.get(id);
  }

  private async sections(): Promise<ConfigSections> {
    const sections = await this.deps.config.sections();
    if (!sections.exists)
      throw new UserError("Pick workspace roots first: majhi.yaml does not exist yet.", 409);
    return sections;
  }

  private async require(id: string): Promise<Found> {
    const found = findConnection(await this.sections(), id);
    if (found === undefined) throw new UserError(`There is no connection ${id}.`, 404);
    return found;
  }

  private async views(org: (org: string) => boolean, only?: string): Promise<ConnectionView[]> {
    const sections = await this.deps.config.sections();
    // Without the key, or with a file that does not decrypt, no secret counts as set.
    const secretNames = new Set(await this.deps.secrets.names().catch(() => [] as string[]));
    const agents = await this.deps.agents.list();
    const out: ConnectionView[] = [];
    for (const [orgId, entry] of Object.entries(sections.orgs)) {
      if (!org(orgId)) continue;
      for (const [id, connection] of Object.entries(entry.connections ?? {})) {
        if (only !== undefined && id !== only) continue;
        const files = await this.files(id);
        out.push(viewOf(id, orgId, connection, { secretNames, files, agents, lastTest: this.tests.get(id) }));
      }
    }
    return out;
  }

  /** Names of the files in a connection's folder. */
  private async files(id: string): Promise<Set<string>> {
    try {
      return new Set((await readdir(this.dir(id))).filter((name) => !name.startsWith(".")));
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return new Set();
      throw err;
    }
  }

  private async putFile(id: string, name: string, upload: string): Promise<void> {
    await ownerOnlyDir(join(this.deps.majhiHome, CONNECTIONS_DIR_NAME));
    const dir = this.dir(id);
    await ownerOnlyDir(dir);
    const temp = join(dir, `.${name}.${process.pid}.tmp`);
    try {
      await this.deps.uploads.moveTo(upload, temp);
      await chmod(temp, 0o600);
      await rename(temp, join(dir, name));
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Deletes what the connection let go of: a file, or a secret that nothing else names. */
  private async release(id: string, values: readonly string[]): Promise<void> {
    for (const value of values) {
      if (value.startsWith(SECRET)) {
        const name = value.slice(SECRET.length);
        if ((await this.deps.secretService.referencedBy(name)).length === 0)
          await this.deps.secrets.delete(name);
      } else if (value.startsWith(FILE)) {
        await rm(join(this.dir(id), value.slice(FILE.length)), { force: true });
      }
    }
  }
}

/** A folder only the owner can open. `mkdir` keeps the mode of one that exists, so set it either way. */
export async function ownerOnlyDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function findConnection(sections: ConfigSections, id: string): Found | undefined {
  for (const [org, entry] of Object.entries(sections.orgs)) {
    const connection = entry.connections?.[id];
    if (connection !== undefined) return { org, entry, connection };
  }
  return undefined;
}

function allIds(sections: ConfigSections): Set<string> {
  return new Set(Object.values(sections.orgs).flatMap((o) => Object.keys(o.connections ?? {})));
}

/** The connection as majhi.yaml may hold it, or the first reason it may not. */
function checked(connection: ConnectionConfig): ConnectionConfig {
  const parsed = ConnectionConfigSchema.safeParse(connection);
  if (parsed.success) return parsed.data;
  const issues = formatIssues(parsed.error);
  throw new UserError(issues[0] ?? "That connection cannot be saved.", 400, issues);
}

function setWith(kind: FieldKind): string {
  return kind === "secret" ? "connections.setSecret" : "connections.setFile";
}

/** The text fields after `given`: a value sets one, null clears it. */
function textFields(
  type: ConnectionType,
  given: Readonly<Record<string, string | null>>,
  current: Readonly<Record<string, string>>,
): Record<string, string> {
  const def = connectionType(type);
  const next = { ...current };
  for (const [key, value] of Object.entries(given)) {
    const field = def.fields.find((f) => f.key === key);
    if (field === undefined) throw new UserError(`A ${def.label} connection has no field ${key}.`);
    if (field.kind !== "text")
      throw new UserError(`${field.label} is a ${field.kind}. Set it with ${setWith(field.kind)}.`);
    if (value === null) {
      delete next[key];
      continue;
    }
    if (field.choices !== undefined && !field.choices.some((c) => c.value === value)) {
      throw new UserError(`${field.label} is one of ${field.choices.map((c) => c.value).join(", ")}.`);
    }
    const issue = formatIssue(field, value);
    if (issue !== undefined) throw new UserError(`${issue}.`);
    next[key] = value;
  }
  return next;
}

/**
 * The entries of a list after `given` replaced it. An entry that stays a secret or a file keeps
 * its stored value. `dropped` holds the stored values nothing points at anymore.
 */
function nextEntries(
  type: ConnectionType,
  key: ConnectionListKey,
  given: Readonly<Record<string, ConnectionEntryInput>>,
  current: Readonly<Record<string, ConnectionEntry>>,
): { entries: Record<string, ConnectionEntry>; dropped: string[] } {
  const def = connectionType(type);
  const list = def.lists.find((l) => l.key === key);
  if (list === undefined) throw new UserError(`A ${def.label} connection has no ${key}.`);
  const entries: Record<string, ConnectionEntry> = {};
  for (const [name, entry] of Object.entries(given)) {
    if (!list.kinds.includes(entry.kind)) throw new UserError(`${list.label} cannot hold a ${entry.kind}.`);
    if (entry.kind !== "text" && entry.value !== undefined) {
      throw new UserError(`${name} is a ${entry.kind}. Set it with ${setWith(entry.kind)}.`);
    }
    const old = current[name];
    if (entry.kind === "text") {
      entries[name] = entry.value === undefined ? { kind: "text" } : { kind: "text", value: entry.value };
    } else {
      entries[name] =
        old?.kind === entry.kind && old.value !== undefined
          ? { kind: entry.kind, value: old.value }
          : { kind: entry.kind };
    }
  }
  const dropped = Object.entries(current).flatMap(([name, old]) =>
    old.kind !== "text" && old.value !== undefined && entries[name]?.value !== old.value ? [old.value] : [],
  );
  return { entries, dropped };
}

/** The field or entry a setSecret or setFile names, with its kind and stored value. */
function targetOf(
  connection: ConnectionConfig,
  field: string,
  list: ConnectionListKey | undefined,
): { kind: FieldKind; label: string; current: string | undefined } {
  const def = connectionType(connection.type);
  if (list === undefined) {
    const declared = def.fields.find((f) => f.key === field);
    if (declared === undefined) throw new UserError(`A ${def.label} connection has no field ${field}.`, 404);
    return { kind: declared.kind, label: declared.label, current: connection.fields?.[field] };
  }
  const entry = connection[list]?.[field];
  if (entry === undefined)
    throw new UserError(`The connection has no ${field} in ${list}. Add it first.`, 404);
  return { kind: entry.kind, label: field, current: entry.value };
}

function withValue(
  connection: ConnectionConfig,
  field: string,
  list: ConnectionListKey | undefined,
  value: string,
): ConnectionConfig {
  if (list === undefined) return { ...connection, fields: { ...connection.fields, [field]: value } };
  const entries = connection[list] ?? {};
  const entry = entries[field];
  if (entry === undefined) return connection;
  return { ...connection, [list]: { ...entries, [field]: { kind: entry.kind, value } } };
}

/** Every secret and file reference the connection holds. */
function storedValues(connection: ConnectionConfig): string[] {
  const out: string[] = [];
  for (const field of connectionType(connection.type).fields) {
    const value = connection.fields?.[field.key];
    if (field.kind !== "text" && value !== undefined) out.push(value);
  }
  for (const key of CONNECTION_LISTS) {
    for (const entry of Object.values(connection[key] ?? {})) {
      if (entry.kind !== "text" && entry.value !== undefined) out.push(entry.value);
    }
  }
  return out;
}

function viewOf(
  id: string,
  org: string,
  connection: ConnectionConfig,
  known: {
    secretNames: ReadonlySet<string>;
    files: ReadonlySet<string>;
    agents: readonly StoredAgent[];
    lastTest: ConnectionTestResult | undefined;
  },
): ConnectionView {
  const stored = (kind: "secret" | "file", value: string) =>
    kind === "secret"
      ? value.startsWith(SECRET) && known.secretNames.has(value.slice(SECRET.length))
      : value.startsWith(FILE) && known.files.has(value.slice(FILE.length));
  const show = (kind: FieldKind, value: string | undefined): ConnectionValueView => {
    if (kind === "text") return value === undefined ? { kind, set: false } : { kind, set: true, value };
    return { kind, set: value !== undefined && stored(kind, value) };
  };
  const list = (key: ConnectionListKey) =>
    Object.fromEntries(
      Object.entries(connection[key] ?? {}).map(([name, e]) => [name, show(e.kind, e.value)]),
    );
  const view: ConnectionView = {
    id,
    org,
    type: connection.type,
    name: connection.name,
    description: connection.description ?? "",
    fields: Object.fromEntries(
      connectionType(connection.type).fields.map((f) => [f.key, show(f.kind, connection.fields?.[f.key])]),
    ),
    vars: list("vars"),
    headers: list("headers"),
    env: list("env"),
    allow: connection.allow ?? [],
    agents: known.agents.flatMap((a) =>
      a.ok && a.agent.frontmatter.scope === org && a.agent.frontmatter.connections.includes(id) ? [a.id] : [],
    ),
    problems: connectionProblems(connection, stored),
  };
  if (known.lastTest !== undefined) view.lastTest = known.lastTest;
  return view;
}
