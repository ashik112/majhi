import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CommandMeta,
  SKILL_NAME,
  type Skill,
  type SkillInstallInput,
  type SkillInstallResult,
  type SkillPreview,
  type SkillRun,
  type SkillSearchResult,
  type SkillSetManyInput,
  type SkillSource,
  skillStateFor,
} from "@majhi/shared";
import { auditActor, auditDetail } from "../audit.ts";
import { UserError } from "../errors.ts";
import type { AuditRow } from "../store/runs.ts";
import { actorName } from "../tasks/cards.ts";
import type { SkillsCli, Stage } from "./cli.ts";
import { copyFolder, describeFolder, isInside } from "./files.ts";
import { readSkillMeta } from "./frontmatter.ts";
import type { SkillRegistry } from "./registry.ts";
import type { SkillStore, StoredSkill } from "./store.ts";
import { extractZip } from "./zip.ts";

/** A preview stays valid this long, and is used once. */
export const PREVIEW_TTL_MS = 30 * 60_000;

/** The parts of the agent service skills use. */
export interface SkillAgents {
  /** Each agent's id and workspace. Agents with a broken file are left out. */
  skillLists(): Promise<{ id: string; scope: string }[]>;
}

export interface SkillServiceDeps {
  store: SkillStore;
  cli: SkillsCli;
  registry: Pick<SkillRegistry, "search">;
  agents: SkillAgents;
  uploads: {
    describe(id: string): Promise<{ name: string; size: number }>;
    moveTo(id: string, to: string): Promise<void>;
  };
  audit: (row: AuditRow) => void;
  /** Folders a local source may come from: the workspace roots and the tasks folder. Never majhi's home. */
  roots: () => Promise<string[]>;
  hostHome: string;
  now?: () => Date;
  /** Per skill: when it was last used and how many uses are at or after `since`. */
  usage: (since: string) => Map<string, { lastUsedAt: string; uses: number }>;
  /** Each agent's newest run in a task: the skills it had and the ones it used. */
  runsOf: (task: string) => SkillRun[];
  /** Agents whose skills changed in the lock only: their open sessions restart so the next turn has the change. */
  changed?: (agents: string[]) => void;
}

interface Pending {
  stage: Stage;
  source: SkillSource;
  by: string;
  items: { name: string; dir: string; hash: string }[];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  kind: "install" | "update";
}

/**
 * Skills: install from a source after the owner has seen what it holds, turn them on per agent, and
 * keep the audit trail. Installing is two steps: the first call fetches into a stage and returns a
 * preview, the second, with the preview's id, moves exactly that into the store. A new skill is on for every agent
 * (`defaultOn`), and an agent opts out per skill.
 */
export class SkillService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: SkillServiceDeps) {}

  async search(query: string, limit: number): Promise<SkillSearchResult[]> {
    const [found, installed] = await Promise.all([
      this.deps.registry.search(query, limit),
      this.deps.store.names(),
    ]);
    return found.map((r) => ({ ...r, installed: installed.includes(r.install.skill ?? r.name) }));
  }

  async list(agent?: string): Promise<Skill[]> {
    const [stored, lists] = await Promise.all([this.deps.store.list(), this.deps.agents.skillLists()]);
    const now = (this.deps.now ?? (() => new Date()))();
    const usage = this.deps.usage(new Date(now.getTime() - USAGE_DAYS * 86_400_000).toISOString());
    const skills = stored.map((s) => toSkill(s, lists, usage.get(s.name)));
    return agent === undefined ? skills : skills.filter((s) => s.agents.includes(agent));
  }

  /** The skills each agent's latest run in the task had, and which it used. */
  async runs(task: string): Promise<SkillRun[]> {
    return this.deps.runsOf(task);
  }

  async get(name: string): Promise<Skill> {
    const skill = (await this.list()).find((s) => s.name === name);
    if (skill === undefined) throw new UserError(`There is no installed skill ${name}.`, 404);
    return skill;
  }

  async install(input: SkillInstallInput, meta: CommandMeta): Promise<SkillInstallResult> {
    const by = actorName(meta.actor);
    if (input.confirm !== undefined) {
      if (input.enable !== undefined) {
        const agent = input.enable;
        if (!(await this.deps.agents.skillLists()).some((l) => l.id === agent)) {
          throw new UserError(`There is no agent @${agent}, or its file has errors.`, 404);
        }
      }
      const done = await this.confirm(input.confirm, by, meta);
      if (done.status === "installed" && input.enable !== undefined) {
        for (const skill of done.skills) await this.enable(skill.name, input.enable, meta);
        return { status: "installed", skills: await this.listed(done.skills.map((s) => s.name)) };
      }
      return done;
    }
    const stage = await this.deps.cli.createStage();
    try {
      let source: SkillSource;
      let cliSource: string;
      if (input.upload !== undefined) {
        const upload = await this.deps.uploads.describe(input.upload);
        if (!upload.name.toLowerCase().endsWith(".zip"))
          throw new UserError("Upload a .zip of the skill folder.");
        const zip = join(stage.dir, "upload.zip");
        await this.deps.uploads.moveTo(input.upload, zip);
        await extractZip(await readFile(zip), stage.src);
        cliSource = stage.src;
        source = { source: `upload:${upload.name}`, sourceType: "upload" };
      } else {
        const given = (input.source ?? "").trim();
        if (isLocalPath(given)) {
          const path = await this.localFolder(given);
          await copyFolder(path, stage.src);
          cliSource = stage.src;
          source = { source: path, sourceType: "local" };
        } else {
          cliSource = given;
          source = { source: cleanSource(given), sourceType: "git" };
        }
      }
      return await this.stageAndPreview(stage, cliSource, source, {
        skill: input.skill,
        org: input.org,
        by,
        kind: "install",
      });
    } catch (err) {
      await stage.dispose();
      throw err;
    }
  }

  /** The installed skills of these names, with their agents as they are now. */
  private async listed(names: string[]): Promise<[Skill, ...Skill[]]> {
    return (await this.list()).filter((s) => names.includes(s.name)) as [Skill, ...Skill[]];
  }

  async update(
    input: { name: string; org?: string | undefined; confirm?: string | undefined },
    meta: CommandMeta,
  ): Promise<SkillInstallResult> {
    const by = actorName(meta.actor);
    if (input.confirm !== undefined) return this.confirm(input.confirm, by, meta);
    const current = await this.deps.store.get(input.name);
    if (current === undefined) throw new UserError(`There is no installed skill ${input.name}.`, 404);
    if (current.sourceType === "upload") {
      throw new UserError(
        `${input.name} came from an uploaded zip. Upload the newer zip to install it again.`,
      );
    }
    const stage = await this.deps.cli.createStage();
    try {
      let cliSource = current.source;
      if (current.sourceType === "local") {
        const path = await this.localFolder(current.source);
        await copyFolder(path, stage.src);
        cliSource = stage.src;
      }
      const source: SkillSource = {
        source: current.source,
        sourceType: current.sourceType,
        ...(current.ref === undefined ? {} : { ref: current.ref }),
      };
      const result = await this.stageAndPreview(stage, cliSource, source, {
        skill: current.name,
        org: input.org,
        by,
        kind: "update",
        only: current.name,
      });
      if (result.status === "preview" && result.skills[0]?.hash === current.hash) {
        this.drop(result.previewId);
        return { status: "unchanged", skills: [await this.get(current.name)] };
      }
      return result;
    } catch (err) {
      await stage.dispose();
      throw err;
    }
  }

  /** Turns the skill on for every agent, now and later. Agents that opted out are switched back on. */
  async enableAll(name: string, meta: CommandMeta): Promise<Skill> {
    await this.get(name);
    await this.deps.store.setDefault(name, true);
    this.deps.changed?.((await this.deps.agents.skillLists()).map((l) => l.id));
    this.log(meta, "skill-enable", `Enable ${name} for all agents`, `${name} for all agents`);
    return this.get(name);
  }

  /**
   * Several skills on or off for a target in one lock write. A workspace rule covers agents made
   * later; agents already there get an opt-out (off) or lose theirs (on), so the choice shows per agent.
   */
  async setMany(input: SkillSetManyInput, meta: CommandMeta): Promise<Skill[]> {
    const lists = await this.deps.agents.skillLists();
    const { target, on } = input;
    const names = [...new Set(input.skills)];
    const ids = (() => {
      if (target.kind === "all") return lists.map((l) => l.id);
      if (target.kind === "workspace") return lists.filter((l) => l.scope === target.org).map((l) => l.id);
      const unknown = target.agents.filter((a) => !lists.some((l) => l.id === a));
      if (unknown.length > 0)
        throw new UserError(`There is no agent @${unknown[0]}, or its file has errors.`, 404);
      return target.agents;
    })();
    const without = (list: readonly string[], drop: readonly string[]) =>
      list.filter((a) => !drop.includes(a));
    const union = (list: readonly string[], add: readonly string[]) => [...new Set([...list, ...add])].sort();
    await this.deps.store.changeMany(names, (entry, name) => {
      const optOut = entry.optOut ?? [];
      const optIn = entry.optIn ?? [];
      const { orgs: _orgs, optIn: _in, ...rest } = entry;
      const orgs = { ...entry.orgs };
      if (target.kind === "all") {
        // Everyone follows one rule again: the per-agent and per-workspace choices give way to it.
        return { ...rest, defaultOn: on, optOut: [] };
      }
      if (target.kind === "workspace") {
        orgs[target.org] = on ? "on" : "off";
        return {
          ...rest,
          optOut: on ? without(optOut, ids) : union(optOut, ids),
          optIn: without(optIn, ids),
          orgs,
        };
      }
      return {
        ...rest,
        orgs: entry.orgs ?? {},
        optOut: on ? without(optOut, ids) : union(optOut, ids),
        optIn: on ? union(optIn, ids) : without(optIn, ids),
      };
    });
    this.deps.changed?.(ids);
    const where =
      target.kind === "all"
        ? "all agents"
        : target.kind === "workspace"
          ? `workspace ${target.org}`
          : ids.join(", ");
    this.log(
      meta,
      on ? "skill-enable" : "skill-disable",
      `${on ? "Enable" : "Disable"} ${names.length} skill${names.length === 1 ? "" : "s"} for ${where}`,
      `${names.join(", ")} for ${where}`,
    );
    return this.listed(names);
  }

  /** On for one agent whatever the workspace or all-agents rule says. */
  async enable(name: string, agent: string, meta: CommandMeta): Promise<Skill> {
    const [skill] = await this.setMany(
      { skills: [name], target: { kind: "agents", agents: [agent] }, on: true },
      meta,
    );
    return skill as Skill;
  }

  /** Off for one agent whatever the workspace or all-agents rule says. */
  async disable(name: string, agent: string, meta: CommandMeta): Promise<Skill> {
    const [skill] = await this.setMany(
      { skills: [name], target: { kind: "agents", agents: [agent] }, on: false },
      meta,
    );
    return skill as Skill;
  }

  /** Deletes the skill, and with it every agent's rule about it. */
  async remove(name: string, meta: CommandMeta): Promise<{ removed: string }> {
    if (!SKILL_NAME.test(name)) throw new UserError(`"${name}" is not a skill name.`);
    if (!(await this.deps.store.remove(name)))
      throw new UserError(`There is no installed skill ${name}.`, 404);
    this.log(meta, "skill-remove", `Remove ${name}`, name);
    return { removed: name };
  }

  /** Drops previews and removes their folders, for shutdown and tests. */
  async close(): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.drop(id);
  }

  private async confirm(id: string, by: string, meta: CommandMeta): Promise<SkillInstallResult> {
    const pending = this.pending.get(id);
    if (pending === undefined || pending.expiresAt < this.now().getTime()) {
      if (pending !== undefined) await this.drop(id);
      throw new UserError("That preview is gone. Fetch the skill again to see what it holds.", 404);
    }
    // An agent installs only what it previewed itself, never what someone else previewed.
    if (meta.actor.kind === "agent" && pending.by !== by) {
      throw new UserError("That preview belongs to someone else. Fetch the skill again.", 409);
    }
    const names: string[] = [];
    try {
      for (const item of pending.items) {
        // What was previewed is what lands: the stage must not have changed since.
        if ((await describeFolder(item.dir)).hash !== item.hash) {
          throw new UserError(`${item.name} changed after the preview. Fetch it again.`, 409);
        }
      }
      for (const item of pending.items) {
        const before = await this.deps.store.get(item.name);
        const stored = await this.deps.store.put(item.name, item.dir, pending.source);
        names.push(stored.name);
        const verb = pending.kind === "update" ? "update" : "install";
        this.log(
          meta,
          `skill-${verb}`,
          `${pending.kind === "update" ? "Update" : "Install"} ${stored.name}`,
          `${stored.name} from ${pending.source.source}${pending.source.commit ? ` at ${pending.source.commit}` : ""}${
            before === undefined || pending.kind === "update" ? "" : `, replacing ${before.source}`
          }`,
        );
      }
    } finally {
      await this.drop(id);
    }
    const skills = await this.list();
    return {
      status: "installed",
      skills: skills.filter((s) => names.includes(s.name)) as [Skill, ...Skill[]],
    };
  }

  private async stageAndPreview(
    stage: Stage,
    cliSource: string,
    source: SkillSource,
    opts: {
      skill?: string | undefined;
      org?: string | undefined;
      by: string;
      kind: "install" | "update";
      only?: string;
    },
  ): Promise<SkillPreview> {
    const fetched = await this.deps.cli.add(stage, { source: cliSource, skill: opts.skill, org: opts.org });
    const items: Pending["items"] = [];
    const shown: SkillPreview["skills"] = [];
    let found: { source?: string; sourceType?: string; ref?: string; commit?: string } | undefined;
    for (const { dir, folder } of fetched.skills) {
      const meta = await readSkillMeta(dir);
      if (opts.only !== undefined && meta.name !== opts.only) continue;
      if (
        opts.skill !== undefined &&
        opts.only === undefined &&
        meta.name !== opts.skill &&
        folder !== opts.skill
      )
        continue;
      if (items.some((i) => i.name === meta.name))
        throw new UserError(`The source has two skills named ${meta.name}.`);
      const folderInfo = await describeFolder(dir);
      const replaces = await this.deps.store.get(meta.name);
      items.push({ name: meta.name, dir, hash: folderInfo.hash });
      shown.push({
        name: meta.name,
        description: meta.description,
        files: folderInfo.files,
        hash: folderInfo.hash,
        ...(replaces === undefined ? {} : { replaces: { source: replaces.source, hash: replaces.hash } }),
      });
      found ??= fetched.lock[folder] ?? fetched.lock[meta.name];
    }
    const first = shown[0];
    if (first === undefined) {
      throw new UserError(
        opts.skill === undefined
          ? "The source holds no skill."
          : `The source has no skill named ${opts.skill}.`,
      );
    }
    const recorded: SkillSource = {
      source: source.source,
      sourceType: source.sourceType === "git" ? (found?.sourceType ?? "git") : source.sourceType,
      ...((source.ref ?? found?.ref) ? { ref: (source.ref ?? found?.ref) as string } : {}),
      ...((source.commit ?? found?.commit) ? { commit: (source.commit ?? found?.commit) as string } : {}),
    };
    const previewId = randomBytes(12).toString("hex");
    const expiresAt = this.now().getTime() + PREVIEW_TTL_MS;
    const timer = setTimeout(() => void this.drop(previewId), PREVIEW_TTL_MS);
    timer.unref();
    this.pending.set(previewId, {
      stage,
      source: recorded,
      by: opts.by,
      items,
      expiresAt,
      timer,
      kind: opts.kind,
    });
    return {
      status: "preview",
      previewId,
      source: recorded,
      skills: shown as SkillPreview["skills"],
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private async drop(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    await pending.stage.dispose();
  }

  /** The folder behind a local source: inside a workspace root or the tasks folder, never majhi's own home. */
  private async localFolder(given: string): Promise<string> {
    const path =
      given === "~" || given.startsWith("~/") ? join(this.deps.hostHome, given.slice(1)) : resolve(given);
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new UserError(`There is no folder ${given}.`, 404);
    }
    const roots = await Promise.all((await this.deps.roots()).map((r) => realpath(r).catch(() => r)));
    if (!roots.some((root) => isInside(real, root))) {
      throw new UserError(
        "Skills can be installed from a folder inside a workspace root or the tasks folder.",
      );
    }
    return real;
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

/** The window of "uses in the last N days" on a skill. */
const USAGE_DAYS = 30;

function toSkill(
  s: StoredSkill,
  lists: { id: string; scope: string }[],
  used: { lastUsedAt: string; uses: number } | undefined,
): Skill {
  return {
    name: s.name,
    description: s.description,
    files: s.files,
    source: s.source,
    sourceType: s.sourceType,
    ...(s.ref === undefined ? {} : { ref: s.ref }),
    ...(s.commit === undefined ? {} : { commit: s.commit }),
    hash: s.hash,
    installedAt: s.installedAt,
    defaultOn: s.defaultOn,
    agents: lists.filter((l) => skillStateFor(s, l).on).map((l) => l.id),
    optOut: s.optOut,
    optIn: s.optIn,
    orgs: s.orgs,
    usage: used === undefined ? { uses30d: 0 } : { lastUsedAt: used.lastUsedAt, uses30d: used.uses },
  };
}

/** A path on the owner's machine rather than a repo shorthand or a URL. */
export function isLocalPath(source: string): boolean {
  return source === "~" || /^(\/|\.{1,2}\/|~\/)/.test(source) || /^[a-zA-Z]:[\\/]/.test(source);
}

/** The source as recorded and shown: no user name, password or query in a URL, which can hold a token. */
export function cleanSource(source: string): string {
  try {
    const url = new URL(source);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ssh:" ||
      url.protocol === "git:"
    ) {
      url.username = "";
      url.password = "";
      url.search = "";
      return url.toString();
    }
  } catch {
    // Not a URL: `owner/repo`, `owner/repo#ref` or `git@host:path`.
  }
  return source.replace(/\/\/[^/@\s]*@/, "//");
}
