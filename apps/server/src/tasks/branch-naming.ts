import { BRANCH_TYPE_OF, BRANCH_TYPES, type BranchType, type TaskTyping } from "@majhi/shared";
import { git } from "../git/git.ts";

/**
 * The pattern used when the owner set none. It has no task id: majhi's ids mean nothing to a repo's
 * other people. `{id}` and `{ID}` work only in a pattern the owner wrote on a project.
 */
export const DEFAULT_BRANCH_PATTERN = "{type}/{slug}";

const MAX_SLUG = 40;

// ---------------------------------------------------------------------------
// Type: from an explicit choice, else from the title.

/** Words a title starts with, which say what kind of change it is. Checked first. */
const LEADING: readonly (readonly [BranchType, RegExp])[] = [
  ["fix", /^(fix|fixes|fixed|resolve|patch|repair|hotfix)\b/],
  [
    "chore",
    /^(bump|update|upgrade|downgrade|pin|cleanup|clean|remove|delete|drop|ignore|deps|rotate|renew)\b/,
  ],
  ["docs", /^document\b/],
  ["refactor", /^(refactor|move|rename|extract|restructure|simplify|split|inline|dedupe)\b/],
  ["test", /^(test|cover)\b/],
  ["perf", /^(optimi[sz]e|speed)\b/],
];

/** Words anywhere in a title, in the order a clash is settled. */
const ANYWHERE: readonly (readonly [BranchType, RegExp])[] = [
  ["fix", /\b(fix|fixes|bug|bugs|broken|fails?|failing|failure|error|errors|crash|crashes|regression)\b/],
  ["chore", /\b(bump|update|upgrade|is out|deps?|dependenc(?:y|ies)|ignore|cleanup|clean up)\b/],
  ["docs", /\b(docs?|readme|documentation)\b/],
  ["refactor", /\b(refactor|move|rename)\b/],
  ["test", /\b(tests?)\b/],
  ["perf", /\b(perf|slow|slower|faster|speed up)\b/],
  ["ci", /\b(ci|pipeline)\b/],
  ["build", /\b(dockerfile|build)\b/],
];

/** Verbs that open a new feature: no keyword later in the title turns it into a fix ("add retry when upload fails"). */
const FEATURE_VERB = /^(add|implement|create|support|introduce|allow|enable)\b/;

/** Words repos use for a type, canonical first. */
const ALIASES: Record<BranchType, readonly string[]> = {
  feat: ["feat", "feature", "features"],
  fix: ["fix", "bugfix", "hotfix", "bug"],
  chore: ["chore", "chores"],
  docs: ["docs", "doc"],
  refactor: ["refactor", "refactoring"],
  test: ["test", "tests"],
  perf: ["perf"],
  ci: ["ci"],
  build: ["build"],
};

/** The type a branch or title prefix names (`feature` is `feat`), or undefined. */
export function typeOfWord(word: string): BranchType | undefined {
  const w = word.toLowerCase();
  return BRANCH_TYPES.find((t) => ALIASES[t].includes(w));
}

/** The type a title says (a `type(scope):` prefix, its first word, a keyword), or undefined when it says nothing. */
export function branchTypeSignal(title: string): BranchType | undefined {
  const text = title.trim().toLowerCase();
  const prefixed = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(text);
  const named = prefixed?.[1] === undefined ? undefined : typeOfWord(prefixed[1]);
  if (named !== undefined) return named;
  if (FEATURE_VERB.test(text)) return "feat";
  for (const [type, re] of LEADING) if (re.test(text)) return type;
  for (const [type, re] of ANYWHERE) if (re.test(text)) return type;
  return undefined;
}

/** The type a title suggests: what it says, else `feat`. For a task with a type, `taskBranchType` follows that instead. */
export function inferBranchType(title: string): BranchType {
  return branchTypeSignal(title) ?? "feat";
}

/** The branch type of a task: its task type's when it has one (the one source), else read from the title. */
export function taskBranchType(task: { title: string; typing?: TaskTyping | undefined }): BranchType {
  return task.typing === undefined ? inferBranchType(task.title) : BRANCH_TYPE_OF[task.typing.type];
}

/** The type a task branch starts with (`fix/acm-1-x`, `feature/acm-1-x`), or undefined for `task/...` and others. */
export function typeOfBranch(branch: string): BranchType | undefined {
  const slash = branch.indexOf("/");
  return slash <= 0 ? undefined : typeOfWord(branch.slice(0, slash));
}

// ---------------------------------------------------------------------------
// Slug and name

/** "fix(api): login" is "login"; "Note: x" stays. */
export function stripTypePrefix(title: string): string {
  const m = /^([a-z]+)(?:\([^)]*\))?!?:\s*/i.exec(title.trim());
  return m?.[1] !== undefined && typeOfWord(m[1]) !== undefined ? title.trim().slice(m[0].length) : title;
}

/**
 * Lowercase ASCII words joined by dashes, at most 40 characters, cut between words. Links, mentions
 * and a leading `type(scope):` are dropped. Every other word stays: a title is prose.
 */
export function slugify(text: string): string {
  return stripTypePrefix(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?<![\w@/.-])@[\w-]+/g, " ")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `slugify`, cut at {@link MAX_SLUG} characters between words (a first word longer than that is cut). */
export function shortSlug(title: string): string {
  const slug = slugify(title);
  if (slug.length <= MAX_SLUG) return slug;
  let out = "";
  for (const word of slug.split("-")) {
    const next = out === "" ? word : `${out}-${word}`;
    if (next.length > MAX_SLUG) break;
    out = next;
  }
  return out === "" ? slug.slice(0, MAX_SLUG).replace(/-+$/, "") : endOnWord(out);
}

const DANGLING = new Set(["a", "an", "the", "of", "to", "on", "in", "at", "by", "for", "and", "or", "with", "when", "is", "are", "if", "as"]);

/** Drops words that cannot end a name ("when", "the"), keeping at least one word. */
function endOnWord(slug: string): string {
  const words = slug.split("-");
  while (words.length > 1 && DANGLING.has(words[words.length - 1] ?? "")) words.pop();
  return words.join("-");
}

/** Whether a rendered branch is one git accepts and a run can write: a folder, then a name. */
function usable(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    name.includes("/") &&
    !name.includes("//") &&
    !name.includes("..") &&
    !/[/.]$/.test(name) &&
    !name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  );
}

export interface BranchRequest {
  id: string;
  title: string;
  type: BranchType;
  /** `{type}/{slug}` by default. */
  pattern?: string | undefined;
  /** Words the repo uses for each type, when its branches show it (`feature` for `feat`). */
  typeWords?: Partial<Record<BranchType, string>> | undefined;
}

/** `feat/add-login`. A pattern that renders to something git would refuse falls back to the default. */
export function branchName(req: BranchRequest): string {
  const render = (pattern: string): string =>
    pattern
      .replace(/\{type\}/g, req.typeWords?.[req.type] ?? req.type)
      .replace(/\{id\}/g, req.id.toLowerCase())
      .replace(/\{ID\}/g, req.id.toUpperCase())
      .replace(/\{slug\}/g, shortSlug(req.title) || "task")
      .replace(/[-_.]+$/, "")
      .replace(/\/[-_.]+/g, "/");
  const own = render(req.pattern ?? DEFAULT_BRANCH_PATTERN);
  return usable(own) ? own : render(DEFAULT_BRANCH_PATTERN);
}

/**
 * One suffix for every repo: `names` (one wanted name per repo) all get `-2`, `-3` ... together until
 * each is free in its own repo, so a task has the same branch name wherever that is possible.
 */
export async function freeBranchesTogether(
  names: readonly string[],
  taken: (index: number, branch: string) => Promise<boolean>,
): Promise<string[]> {
  for (let n = 1; n < 100; n++) {
    const next = names.map((name) => (n === 1 ? name : `${name}-${n}`));
    const used = await Promise.all(next.map((name, i) => taken(i, name)));
    if (!used.some(Boolean)) return next;
  }
  throw new Error(`Could not find a free branch name from ${names[0] ?? ""}.`);
}

// ---------------------------------------------------------------------------
// What a repo's own history shows

/** How a repo names its branches: with a type word per type, with the issue key first, or not at all. */
export type BranchStyle =
  | { kind: "default" }
  | { kind: "typed"; words: Partial<Record<BranchType, string>> }
  /** Issue keys first (`ABC-123/fix`): majhi has no such key, so it uses the repo's type words, if any. */
  | { kind: "key"; words: Partial<Record<BranchType, string>> };

/** Branches that say nothing about how people name their own. */
const SKIPPED =
  /^(HEAD|main|master|develop|dev|development|staging|production|prod|trunk|task\/.*|release\/.*|releases\/.*|dependabot\/.*|renovate\/.*|gh-pages)$/;

/** Fewer branches than this show no convention. */
const MIN_SIGNAL = 3;

/** The most common way the given branch names (short names, no remote) show, else the default. */
export function detectBranchStyle(names: readonly string[]): BranchStyle {
  const seen = names.filter((n) => !SKIPPED.test(n));
  const counts = new Map<BranchType, Map<string, number>>();
  let typed = 0;
  let keyed = 0;
  for (const name of seen) {
    const first = name.split("/")[0] ?? "";
    const type = name.includes("/") ? typeOfWord(first) : undefined;
    if (type !== undefined) {
      typed++;
      const words = counts.get(type) ?? new Map<string, number>();
      words.set(first.toLowerCase(), (words.get(first.toLowerCase()) ?? 0) + 1);
      counts.set(type, words);
      continue;
    }
    const key = /^([A-Za-z][A-Za-z0-9]*-\d+)(?:[/_-]|$)/.exec(name)?.[1];
    if (key !== undefined && name.length > key.length) {
      keyed++;
    }
  }
  const words: Partial<Record<BranchType, string>> = {};
  for (const [type, seenWords] of counts) {
    const [top] = [...seenWords].sort((a, b) => b[1] - a[1]);
    if (top !== undefined) words[type] = top[0];
  }
  if (keyed >= MIN_SIGNAL && keyed > typed) return { kind: "key", words };
  if (typed < MIN_SIGNAL) return { kind: "default" };
  // A repo that writes `feature/` and never `feat/` also means `feature/` for a type it has no branch of.
  return { kind: "typed", words };
}

/** The type words the repo's style gives, when the owner set no pattern. Never an id: a key style adds none. */
export function styleOptions(style: BranchStyle): Pick<BranchRequest, "typeWords"> {
  return style.kind === "default" ? {} : { typeWords: style.words };
}

/** "conventional": recent commits follow `type(scope): summary`. "other": they clearly do not. */
export type CommitStyle = "conventional" | "other" | "unknown";

const CONVENTIONAL = new RegExp(
  `^(${BRANCH_TYPES.join("|")}|feature|bugfix|hotfix|style|revert)(\\([^)]+\\))?!?: \\S`,
  "i",
);

/** From commit subjects. Fewer than 5 say nothing; a repo is conventional when most of them follow it. */
export function detectCommitStyle(subjects: readonly string[]): CommitStyle {
  const real = subjects.filter((s) => s !== "" && !/^Merge /.test(s));
  if (real.length < 5) return "unknown";
  const hits = real.filter((s) => CONVENTIONAL.test(s)).length;
  return hits * 2 >= real.length ? "conventional" : "other";
}

export interface RepoStyle {
  branches: BranchStyle;
  commits: CommitStyle;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: RepoStyle }>();

/** For tests. */
export function forgetRepoStyles(): void {
  cache.clear();
}

/**
 * What a repo's recent branches and commits show, read once per ten minutes: two cheap git commands
 * over at most 300 refs and 40 commits. A repo git cannot read shows nothing.
 */
export async function readRepoStyle(repo: string, now: number = Date.now()): Promise<RepoStyle> {
  const hit = cache.get(repo);
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.value;
  const value = await read(repo);
  cache.set(repo, { at: now, value });
  return value;
}

async function read(repo: string): Promise<RepoStyle> {
  const lines = async (args: string[]): Promise<string[]> =>
    (await git(repo, args).catch(() => "")).split("\n").map((l) => l.trim());
  const refs = await lines([
    "for-each-ref",
    "--sort=-committerdate",
    "--count=300",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const names = new Set<string>();
  for (const ref of refs) {
    const name = ref.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1];
    if (name !== undefined && name !== "") names.add(name);
  }
  const subjects = await lines(["log", "-n", "40", "--no-merges", "--format=%s"]);
  return { branches: detectBranchStyle([...names]), commits: detectCommitStyle(subjects) };
}

/**
 * The subject of a commit or merge request for a task: `fix: login redirect` for a repo whose
 * commits follow Conventional Commits, else `Login redirect`. It never carries the task id.
 */
export function titleFor(req: { title: string; type: BranchType }, commits: CommitStyle): string {
  const bare = stripTypePrefix(req.title).trim();
  const first = bare.charAt(0);
  if (commits !== "conventional") return `${first.toUpperCase()}${bare.slice(1)}`.slice(0, 200);
  const lowered =
    bare.charAt(1) === bare.charAt(1).toUpperCase() && bare.charAt(1) !== bare.charAt(1).toLowerCase()
      ? bare
      : `${first.toLowerCase()}${bare.slice(1)}`;
  return `${req.type}: ${lowered}`.slice(0, 200);
}

/** The message of the merge or squash commit majhi makes. It names the branch, never the task id. */
export function mergeMessage(branch: string, into: string): string {
  return `${mergeSubject(branch)} into ${into}`;
}

/** What every such message starts with: how a push tells majhi's own merge commits from other local ones. */
export function mergeSubject(branch: string): string {
  return `Merge branch '${branch}'`;
}

/** Whether a branch name carries majhi's task id as a word of its own (`goa-11` in `fix/goa-11-x`, not in `goa-110`). */
export function carriesTaskId(branch: string, id: string): boolean {
  const name = branch.toLowerCase();
  const key = id.toLowerCase();
  for (let at = name.indexOf(key); at >= 0; at = name.indexOf(key, at + 1)) {
    const before = name.charAt(at - 1);
    const after = name.charAt(at + key.length);
    const wordBefore = at > 0 && (isDigit(before) || (before >= "a" && before <= "z"));
    if (!wordBefore && !(after !== "" && isDigit(after))) return true;
  }
  return false;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
