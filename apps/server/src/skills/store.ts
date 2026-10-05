import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_NAME, type SkillRule, type SkillSource, skillStateFor } from "@majhi/shared";
import { z } from "zod";
import { errorCode, UserError } from "../errors.ts";
import { copyFolder, describeFolder } from "./files.ts";
import { readSkillMeta } from "./frontmatter.ts";

/** The store folder inside majhi's home, and the lock next to the skills (the CLI's `skills-lock.json` style). */
export const SKILLS_DIR_NAME = "skills";
export const SKILLS_LOCK_NAME = "skills-lock.json";

const LockEntrySchema = z.object({
  source: z.string(),
  sourceType: z.string(),
  ref: z.string().optional(),
  commit: z.string().optional(),
  computedHash: z.string(),
  installedAt: z.string(),
  /** On for every agent unless it is in `optOut`. Entries from before this field read as off. */
  defaultOn: z.boolean().optional(),
  /** Agents that turned a default-on skill off. */
  optOut: z.array(z.string()).optional(),
  /** Agents the owner turned the skill on for in bulk, without touching their files. */
  optIn: z.array(z.string()).optional(),
  /** Workspace rules (an agent's `scope`): they cover agents created later too. */
  orgs: z.record(z.string(), z.enum(["on", "off"])).optional(),
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

const LockSchema = z.object({ version: z.literal(1), skills: z.record(z.string(), LockEntrySchema) });

function ruleOf(entry: LockEntry): SkillRule {
  return {
    defaultOn: entry.defaultOn ?? false,
    optOut: entry.optOut ?? [],
    optIn: entry.optIn ?? [],
    orgs: entry.orgs ?? {},
  };
}

/** One installed skill as the store reads it back from its folder and the lock. */
export interface StoredSkill {
  name: string;
  description: string;
  files: { path: string; size: number }[];
  source: string;
  sourceType: string;
  ref?: string | undefined;
  commit?: string | undefined;
  hash: string;
  installedAt: string;
  /** One rule for every agent, including agents created later: on unless the agent is in `optOut`. */
  defaultOn: boolean;
  optOut: string[];
  optIn: string[];
  orgs: Record<string, "on" | "off">;
}

/**
 * Installed skills: `<majhi home>/skills/<name>/` and `skills-lock.json` beside them, which records
 * where each came from, at which ref and commit, its content hash and when. Writes go one at a time,
 * and the lock is replaced whole, so a crash leaves the old one.
 */
export class SkillStore {
  readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    majhiHome: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = join(majhiHome, SKILLS_DIR_NAME);
  }

  /** Where a skill's files are. The name is checked, so it cannot point elsewhere. */
  pathOf(name: string): string {
    if (!SKILL_NAME.test(name)) throw new UserError(`"${name}" is not a skill name.`);
    return join(this.dir, name);
  }

  async names(): Promise<string[]> {
    return Object.keys((await this.readLock()).skills).sort();
  }

  async list(): Promise<StoredSkill[]> {
    const lock = await this.readLock();
    const out: StoredSkill[] = [];
    for (const name of Object.keys(lock.skills).sort()) {
      const skill = await this.describe(name, lock.skills[name]);
      if (skill !== undefined) out.push(skill);
    }
    return out;
  }

  async get(name: string): Promise<StoredSkill | undefined> {
    const lock = await this.readLock();
    return this.describe(name, lock.skills[name]);
  }

  /**
   * Puts the skill folder `from` in the store under `name`, replacing an installed one, and records
   * its source. The folder is checked again here: SKILL.md, the name, containment and size.
   */
  put(name: string, from: string, source: SkillSource): Promise<StoredSkill> {
    return this.serial(async () => {
      const meta = await readSkillMeta(from);
      if (meta.name !== name) throw new UserError(`SKILL.md names the skill "${meta.name}", not "${name}".`);
      await mkdir(this.dir, { recursive: true });
      const staged = join(this.dir, `.new-${randomBytes(6).toString("hex")}`);
      try {
        await copyFolder(from, staged);
        const { hash } = await describeFolder(staged);
        const target = this.pathOf(name);
        await rm(target, { recursive: true, force: true });
        await rename(staged, target);
        const lock = await this.readLock();
        const previous = lock.skills[name];
        lock.skills[name] = {
          // A new skill is on for every agent; replacing one keeps what the owner chose for it.
          defaultOn: previous === undefined ? true : (previous.defaultOn ?? false),
          ...(previous?.optOut === undefined ? {} : { optOut: previous.optOut }),
          ...(previous?.optIn === undefined ? {} : { optIn: previous.optIn }),
          ...(previous?.orgs === undefined ? {} : { orgs: previous.orgs }),
          source: source.source,
          sourceType: source.sourceType,
          ...(source.ref === undefined ? {} : { ref: source.ref }),
          ...(source.commit === undefined ? {} : { commit: source.commit }),
          computedHash: hash,
          installedAt: this.now().toISOString(),
        };
        await this.writeLock(lock);
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
      const stored = await this.get(name);
      if (stored === undefined) throw new UserError(`Skill ${name} could not be installed.`);
      return stored;
    });
  }

  /** Turns the all-agents rule on or off. Turning it on clears the opt-outs: every agent gets the skill. */
  setDefault(name: string, on: boolean): Promise<void> {
    // One rule for everyone: the per-workspace and bulk choices give way to it.
    return this.change(name, (entry) => {
      const { orgs: _orgs, optIn: _optIn, ...rest } = entry;
      return { ...rest, defaultOn: on, ...(on ? { optOut: [] } : {}) };
    });
  }

  /** Records that one agent turned a default-on skill off (`out`) or back on. */
  setOptOut(name: string, agent: string, out: boolean): Promise<void> {
    return this.change(name, (entry) => {
      const rest = (entry.optOut ?? []).filter((a) => a !== agent);
      return { ...entry, optOut: out ? [...rest, agent].sort() : rest };
    });
  }

  /** The skills an agent has, by the rules (see `skillStateFor`). */
  async effectiveFor(agent: { id: string; scope: string }): Promise<string[]> {
    const lock = await this.readLock();
    return Object.entries(lock.skills)
      .filter(([, entry]) => skillStateFor(ruleOf(entry), agent).on)
      .map(([name]) => name);
  }

  /** Edits several entries and writes the lock once. An unknown name is an error before anything is written. */
  changeMany(names: readonly string[], edit: (entry: LockEntry, name: string) => LockEntry): Promise<void> {
    return this.serial(async () => {
      const lock = await this.readLock();
      for (const name of names) {
        if (lock.skills[name] === undefined) throw new UserError(`There is no installed skill ${name}.`, 404);
      }
      for (const name of names) {
        const entry = lock.skills[name];
        if (entry !== undefined) lock.skills[name] = edit(entry, name);
      }
      await this.writeLock(lock);
    });
  }

  private change(name: string, edit: (entry: LockEntry) => LockEntry): Promise<void> {
    return this.serial(async () => {
      const lock = await this.readLock();
      const entry = lock.skills[name];
      if (entry === undefined) throw new UserError(`There is no installed skill ${name}.`, 404);
      lock.skills[name] = edit(entry);
      await this.writeLock(lock);
    });
  }

  /** Deletes a skill's folder and its lock entry. Returns false when it was not installed. */
  remove(name: string): Promise<boolean> {
    return this.serial(async () => {
      const lock = await this.readLock();
      const path = this.pathOf(name);
      const had = lock.skills[name] !== undefined;
      delete lock.skills[name];
      await rm(path, { recursive: true, force: true });
      if (had) await this.writeLock(lock);
      return had;
    });
  }

  private async describe(name: string, entry: LockEntry | undefined): Promise<StoredSkill | undefined> {
    if (entry === undefined || !SKILL_NAME.test(name)) return undefined;
    try {
      const path = this.pathOf(name);
      const [meta, folder] = await Promise.all([readSkillMeta(path), describeFolder(path)]);
      return {
        name,
        description: meta.description,
        files: folder.files,
        source: entry.source,
        sourceType: entry.sourceType,
        ref: entry.ref,
        commit: entry.commit,
        hash: folder.hash,
        installedAt: entry.installedAt,
        defaultOn: entry.defaultOn ?? false,
        optOut: entry.optOut ?? [],
        optIn: entry.optIn ?? [],
        orgs: entry.orgs ?? {},
      };
    } catch {
      // A folder that went missing or broke by hand: the lock entry stays, the skill is not listed.
      return undefined;
    }
  }

  private async readLock(): Promise<z.infer<typeof LockSchema>> {
    try {
      return LockSchema.parse(JSON.parse(await readFile(join(this.dir, SKILLS_LOCK_NAME), "utf8")));
    } catch (err) {
      if (errorCode(err) === "ENOENT") return { version: 1, skills: {} };
      throw new UserError(`The skills lock (${SKILLS_LOCK_NAME}) is not readable. Fix or delete it.`);
    }
  }

  private async writeLock(lock: z.infer<typeof LockSchema>): Promise<void> {
    const tmp = join(this.dir, `.lock-${randomBytes(4).toString("hex")}`);
    await writeFile(tmp, `${JSON.stringify(lock, null, 2)}\n`);
    await rename(tmp, join(this.dir, SKILLS_LOCK_NAME));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
