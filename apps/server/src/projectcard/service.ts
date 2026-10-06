import { createHash } from "node:crypto";
import type { ProjectCard, ReadinessItem } from "@majhi/shared";
import { UserError } from "../errors.ts";
import { folderName, fsRepoFiles, type RepoFiles } from "./files.ts";
import { readiness, gaps as readinessGaps } from "./readiness.ts";
import type { CardRepo } from "./repo.ts";
import { isCardRelevant, type ScanFacts, scanRepo } from "./scanner.ts";

/** How often base tips are looked at. */
export const CARD_WATCH_MS = 60_000;
/** A base tip must stand this long before the card is refreshed: a burst of merges refreshes once. */
export const CARD_DEBOUNCE_MS = 2 * 60_000;
/** The model rewrites the paragraph by itself at most this often a day. The Refresh button is not counted. */
export const MODEL_PASSES_PER_DAY = 8;

export interface CardProject {
  id: string;
  org: string;
  path: string;
  base: string | undefined;
  exists: boolean;
}

export interface CardDeps {
  repo: CardRepo;
  projects: () => Promise<CardProject[]>;
  git: {
    tip: (path: string, branch: string) => Promise<string | undefined>;
    /** Files changed between two commits; undefined when git cannot say. */
    changed: (path: string, from: string, to: string) => Promise<string[] | undefined>;
    remotes: (path: string) => Promise<{ name: string; url: string }[]>;
  };
  /** One short model pass: the "what it is" paragraph from the scanned facts. Undefined when none ran. */
  summarize?: ((project: CardProject, facts: ScanFacts) => Promise<string | undefined>) | undefined;
  /** Readiness gaps found (the first time, or new ones). The findings store takes them as findings. */
  onGaps?: ((project: CardProject, gaps: ReadinessItem[]) => void) | undefined;
  /** The owner switched an outcome rule of the Projects playbook off (`proj-cards`, `proj-readiness`). */
  ruleOff?: ((org: string, rule: string) => boolean) | undefined;
  /** The card was written. */
  onCard?: ((project: CardProject, card: ProjectCard) => void) | undefined;
  /** A base tip has stood long enough to count as moved (once per tip): the wiki looks at how far behind it is. */
  onBaseMoved?: ((project: CardProject, tip: string) => void) | undefined;
  files?: (path: string) => RepoFiles;
  now?: () => Date;
  log?: (message: string) => void;
  debounceMs?: number;
}

/** A remote URL without the user and password part, so a token in it never reaches a card. */
export function plainUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

function hashOf(facts: ScanFacts): string {
  const { stack, commands, structure, conventions, ci, deploy, readme } = facts;
  return createHash("sha1")
    .update(JSON.stringify({ stack, commands, structure, conventions, ci, deploy, readme }))
    .digest("hex");
}

/**
 * The project knowledge cards. A scan reads files with code only; the model writes one paragraph
 * when the facts changed. Cards refresh when the base branch tip has moved and stood for a while,
 * and only rescan when a relevant file changed (manifests, lockfiles, CI, docs).
 */
export class ProjectCards {
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Map<string, Promise<ProjectCard>>();
  /** A base tip seen, and when it was first seen. */
  private readonly pending = new Map<string, { tip: string; since: number }>();
  private readonly polishing = new Set<Promise<void>>();
  private modelDay = "";
  private modelUsed = 0;

  constructor(private readonly deps: CardDeps) {}

  start(): void {
    const tick = (): void => void this.tick().catch((err: unknown) => this.log(`cards: ${String(err)}`));
    tick();
    this.timer = setInterval(tick, CARD_WATCH_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  get(project: string): ProjectCard | undefined {
    return this.deps.repo.get(project)?.card;
  }

  list(project?: string): ProjectCard[] {
    const all = this.deps.repo.all().map((r) => r.card);
    return project === undefined ? all : all.filter((c) => c.project === project);
  }

  /** The owner's Refresh (or the captain's): reads the files now and rewrites the card. */
  refresh(id: string): Promise<ProjectCard> {
    return this.run(id, { auto: false });
  }

  /** The projects a merge could have changed the card of: looked at once the tip has stood. */
  onMerged(project: string): void {
    this.pending.delete(project);
    const t = setTimeout(
      () => void this.tick().catch((err: unknown) => this.log(`cards: ${String(err)}`)),
      (this.deps.debounceMs ?? CARD_DEBOUNCE_MS) + 1_000,
    );
    t.unref();
  }

  /** A project was registered: its card is written now, without waiting for a tick. */
  onRegistered(id: string): void {
    void this.run(id, { auto: true }).catch((err: unknown) => this.log(`cards: ${id}: ${String(err)}`));
  }

  forget(project: string): void {
    this.pending.delete(project);
    this.deps.repo.remove(project);
  }

  /** Every minute: a card for each project without one, and a refresh for a base tip that moved and stood. */
  async tick(): Promise<void> {
    const now = this.now().getTime();
    const wait = this.deps.debounceMs ?? CARD_DEBOUNCE_MS;
    for (const p of await this.deps.projects()) {
      if (!p.exists || p.base === undefined) continue;
      const tip = await this.deps.git.tip(p.path, p.base);
      if (tip === undefined) continue;
      const have = this.deps.repo.get(p.id)?.card;
      if (have === undefined) {
        await this.run(p.id, { auto: true }).catch((err: unknown) =>
          this.log(`cards: ${p.id}: ${String(err)}`),
        );
        continue;
      }
      if (have.commit === tip) {
        this.pending.delete(p.id);
        continue;
      }
      const seen = this.pending.get(p.id);
      if (seen?.tip !== tip) {
        this.pending.set(p.id, { tip, since: now });
        continue;
      }
      if (now - seen.since < wait) continue;
      this.pending.delete(p.id);
      this.deps.onBaseMoved?.(p, tip);
      // "Refresh a project card when its base branch moves" is off: the card stays as it is until Refresh.
      if (this.deps.ruleOff?.(p.org, "proj-cards") === true) continue;
      await this.settle(p, have, tip).catch((err: unknown) => this.log(`cards: ${p.id}: ${String(err)}`));
    }
  }

  /** The tip moved: rescan when a relevant file changed, otherwise only move the stamp. */
  private async settle(p: CardProject, have: ProjectCard, tip: string): Promise<void> {
    const changed =
      have.commit === undefined ? undefined : await this.deps.git.changed(p.path, have.commit, tip);
    if (changed !== undefined && !changed.some(isCardRelevant)) {
      const stored = this.deps.repo.get(p.id);
      if (stored !== undefined) {
        this.deps.repo.put(
          { ...have, commit: tip, refreshedAt: this.now().toISOString() },
          stored.factsHash,
          this.now().toISOString(),
        );
      }
      return;
    }
    await this.run(p.id, { auto: true });
  }

  private run(id: string, opts: { auto: boolean }): Promise<ProjectCard> {
    const running = this.inflight.get(id);
    if (running !== undefined) return running;
    const job = this.build(id, opts).finally(() => this.inflight.delete(id));
    this.inflight.set(id, job);
    return job;
  }

  private async build(id: string, opts: { auto: boolean }): Promise<ProjectCard> {
    const project = (await this.deps.projects()).find((p) => p.id === id);
    if (project === undefined) throw new UserError(`There is no project ${id}.`, 404);
    if (!project.exists) throw new UserError(`The checkout of ${id} is missing.`, 409);
    const files = (this.deps.files ?? fsRepoFiles)(project.path);
    const facts = await scanRepo(files, { id, folder: folderName(project.path) });
    const tip = project.base === undefined ? undefined : await this.deps.git.tip(project.path, project.base);
    const before = this.deps.repo.get(id);
    const factsHash = hashOf(facts);
    const changed = before?.factsHash !== factsHash;

    let whatItIs = before?.card.whatItIs ?? "";
    let by: ProjectCard["whatItIsBy"] = before?.card.whatItIsBy ?? "none";
    const wantModel =
      (changed || by === "none" || whatItIs === "") &&
      this.deps.summarize !== undefined &&
      this.modelAllowed(opts.auto);
    // The button waits for the paragraph. A by-itself run writes the card first and polishes it after,
    // so registering a project or a merge never waits on a model session.
    if (wantModel && !opts.auto) {
      const text = await this.summarize(project, facts);
      if (text !== undefined) {
        whatItIs = text;
        by = "model";
      }
    }
    if (by !== "model") {
      whatItIs = facts.readme;
      by = facts.readme === "" ? "none" : "readme";
    }

    const card: ProjectCard = {
      project: id,
      org: project.org,
      ...(tip === undefined ? {} : { commit: tip }),
      ...(project.base === undefined ? {} : { base: project.base }),
      refreshedAt: this.now().toISOString(),
      whatItIs,
      whatItIsBy: by,
      stack: facts.stack,
      commands: facts.commands,
      structure: facts.structure,
      conventions: facts.conventions,
      ci: {
        ...(facts.ci.provider === undefined ? {} : { provider: facts.ci.provider }),
        workflows: facts.ci.workflows,
      },
      deploy: facts.deploy,
      remotes: (await this.deps.git.remotes(project.path)).map((r) => ({
        name: r.name,
        url: plainUrl(r.url),
      })),
      aliases: facts.aliases,
      readiness: readiness(facts, project.base),
    };
    this.deps.repo.put(card, factsHash, card.refreshedAt);

    const missing = readinessGaps(card.readiness);
    const known = new Set(before === undefined ? [] : readinessGaps(before.card.readiness).map((g) => g.id));
    const fresh = missing.filter((g) => !known.has(g.id));
    if (fresh.length > 0 && this.deps.ruleOff?.(project.org, "proj-readiness") !== true) {
      this.deps.onGaps?.(project, fresh);
    }
    this.deps.onCard?.(project, card);
    if (wantModel && opts.auto) this.polish(project, facts, factsHash);
    return card;
  }

  private async summarize(project: CardProject, facts: ScanFacts): Promise<string | undefined> {
    try {
      const text = (await this.deps.summarize?.(project, facts))?.trim();
      return text === undefined || text === "" ? undefined : text;
    } catch (err) {
      this.log(`cards: ${project.id}: the summary was not written: ${String(err)}`);
      return undefined;
    }
  }

  /** Rewrites the paragraph of a card already written, unless the facts moved on meanwhile. */
  private polish(project: CardProject, facts: ScanFacts, factsHash: string): void {
    const job = (async () => {
      const text = await this.summarize(project, facts);
      const current = this.deps.repo.get(project.id);
      if (text === undefined || current === undefined || current.factsHash !== factsHash) return;
      const card: ProjectCard = { ...current.card, whatItIs: text, whatItIsBy: "model" };
      this.deps.repo.put(card, factsHash, this.now().toISOString());
      this.deps.onCard?.(project, card);
    })().finally(() => this.polishing.delete(job));
    this.polishing.add(job);
  }

  /** Resolves when the by-itself paragraph passes have ended. */
  async idle(): Promise<void> {
    while (this.polishing.size > 0) await Promise.all([...this.polishing]);
  }

  /** The Refresh button always may run the model; the by-itself runs share a small daily allowance. */
  private modelAllowed(auto: boolean): boolean {
    if (!auto) return true;
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.modelDay) {
      this.modelDay = day;
      this.modelUsed = 0;
    }
    if (this.modelUsed >= MODEL_PASSES_PER_DAY) return false;
    this.modelUsed += 1;
    return true;
  }

  /** One line per project of a workspace, for the captain's digest: stack, readiness, last refresh. */
  digestLines(org: string): string[] {
    return this.list()
      .filter((c) => c.org === org)
      .sort((a, b) => a.project.localeCompare(b.project))
      .map((c) => digestLine(c));
  }

  /** The card as the Project section of TASK.md: short, facts an agent starts from. */
  compact(project: string): string | undefined {
    const card = this.get(project);
    return card === undefined ? undefined : compactCard(card);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}

/** `acme-api: TypeScript, pnpm, Fastify; ready 4/5 (no CI); read 2026-10-04 at a1b2c3d`. */
export function digestLine(card: ProjectCard): string {
  const missing = card.readiness.items.filter((i) => !i.ok).map((i) => i.label.toLowerCase());
  const stack = card.stack.slice(0, 3).join(", ") || "stack unknown";
  const gaps = missing.length === 0 ? "" : ` (missing: ${missing.slice(0, 3).join(", ")})`;
  const at = `read ${card.refreshedAt.slice(0, 10)}${card.commit === undefined ? "" : ` at ${card.commit.slice(0, 7)}`}`;
  return `${card.project}: ${stack}; ready ${card.readiness.score}/5${gaps}; ${at}`;
}

const COMMAND_ORDER = ["install", "run", "build", "test", "lint", "typecheck", "format"] as const;

export function compactCard(card: ProjectCard, maxChars = 900): string {
  const lines: string[] = [];
  if (card.whatItIs !== "") lines.push(card.whatItIs);
  if (card.stack.length > 0) lines.push(`Stack: ${card.stack.slice(0, 8).join(", ")}.`);
  const cmds = COMMAND_ORDER.flatMap((k) =>
    card.commands[k] === undefined ? [] : [`${k} \`${card.commands[k]}\``],
  );
  if (cmds.length > 0) lines.push(`Commands: ${cmds.join("; ")}.`);
  if (card.structure.length > 0) {
    lines.push(
      `Layout: ${card.structure
        .slice(0, 8)
        .map((s) => s.path)
        .join(" ")}`,
    );
  }
  if (card.ci.provider !== undefined) lines.push(`CI: ${card.ci.provider}.`);
  const missing = card.readiness.items
    .filter((i) => !i.ok && i.id !== "base")
    .map((i) => i.label.toLowerCase());
  lines.push(
    `Readiness ${card.readiness.score}/5${missing.length === 0 ? "" : `, missing: ${missing.join(", ")}`}.`,
  );
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 4).trimEnd()} ...` : text;
}
