import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "@majhi/shared";
import { parse } from "yaml";
import { AGENTS_DIR_NAME } from "../config/service.ts";
import { errorCode } from "../errors.ts";
import { fileSignature } from "../fs.ts";
import { parseAgentFile, serializeAgent } from "./file.ts";

export type StoredAgent =
  | { ok: true; id: string; file: string; agent: Agent; legacySkills: string[] }
  | { ok: false; id: string; file: string; errors: string[]; account: string | undefined };

/** Reads and writes `<majhi home>/agents/<id>.md`. No warnings and no history here. */
export class AgentStore {
  readonly dir: string;
  /**
   * Each file as last parsed, with the signature it had. Every caller lists the agents, so without
   * this a health check read and parsed every file a dozen times. A hand edit changes the
   * signature and is read at once. Entries of files no longer listed are dropped.
   */
  private readonly parsed = new Map<string, { signature: string; stored: StoredAgent }>();

  constructor(majhiHome: string) {
    this.dir = join(majhiHome, AGENTS_DIR_NAME);
  }

  path(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  /** Every `.md` file, sorted by name. Invalid files come back with their errors. */
  async list(): Promise<StoredAgent[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return [];
      throw err;
    }
    const files = names.filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort();
    for (const name of this.parsed.keys()) if (!files.includes(name)) this.parsed.delete(name);
    return Promise.all(files.map((name) => this.readFile(name)));
  }

  async get(id: string): Promise<StoredAgent | undefined> {
    try {
      return await this.readFile(`${id}.md`);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Ids of the agents whose frontmatter names `account`, valid or not. */
  async usersOf(account: string): Promise<string[]> {
    const all = await this.list();
    return all.filter((a) => (a.ok ? a.agent.frontmatter.account : a.account) === account).map((a) => a.id);
  }

  async write(agent: Agent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.path(agent.frontmatter.id);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, serializeAgent(agent));
    await rename(temp, file);
  }

  remove(id: string): Promise<void> {
    return rm(this.path(id), { force: true });
  }

  /** A copy, so a caller that changes what it got cannot change what the next one gets. */
  private async readFile(name: string): Promise<StoredAgent> {
    const path = join(this.dir, name);
    const signature = await fileSignature(path);
    const known = this.parsed.get(name);
    if (known?.signature === signature) return structuredClone(known.stored);
    const text = await readFile(path, "utf8");
    const id = name.replace(/\.md$/, "");
    const parsed = parseAgentFile(name, text);
    const stored: StoredAgent = parsed.ok
      ? { ok: true, id, file: name, agent: parsed.agent, legacySkills: parsed.legacySkills }
      : { ok: false, id, file: name, errors: parsed.errors, account: rawAccount(text) };
    this.parsed.set(name, { signature, stored: structuredClone(stored) });
    return stored;
  }
}

/** The `account` value of a file that failed validation, when the frontmatter still parses. */
function rawAccount(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match?.[1] === undefined) return undefined;
  try {
    const value: unknown = parse(match[1]);
    if (
      typeof value === "object" &&
      value !== null &&
      "account" in value &&
      typeof value.account === "string"
    ) {
      return value.account;
    }
  } catch {
    // Broken YAML: the file is already listed as invalid.
  }
  return undefined;
}
