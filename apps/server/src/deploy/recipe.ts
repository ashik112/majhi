import type {
  DeployEnvironment,
  DeployRecipe,
  DeployRunStep,
  InputBinding,
  LiveSource,
  RunNamePart,
  TagPart,
} from "@majhi/shared";

/**
 * What a recipe's runs need when they start, in plain functions. A recipe (`DeployEnvironment.recipe`) holds runs
 * with `bind`s; `bindRuns` fills each one from the facts of this deploy, and says which it could not fill. Nothing
 * here reads text for a decision: the pieces of a tag and of a run's title are typed lists.
 */

/** What is known when the runs of a deploy or a rollback start. */
export interface BindFacts {
  /** The commit being deployed. */
  commit?: string | undefined;
  /** The version the project's build makes for `commit`, when the recipe knows how the build names it. */
  built?: string | undefined;
  previous?: { version?: string | undefined; commit?: string | undefined } | undefined;
  /** The option of a `components` input to dispatch with. */
  components?: string | undefined;
}

/** The version the build makes for a commit, from the typed pieces of its tag. */
export function tagOf(parts: readonly TagPart[], commit: string): string {
  return parts.map((p) => (p.kind === "text" ? p.text : commit.slice(0, p.length))).join("");
}

function bindingValue(binding: InputBinding, facts: BindFacts): string | undefined {
  switch (binding) {
    case "commit":
      return facts.commit;
    case "built-version":
    case "next-version":
      return facts.built;
    case "previous-version":
      return facts.previous?.version;
    case "previous-commit":
      return facts.previous?.commit;
    case "components":
      return facts.components;
  }
}

/**
 * The runs with each `bind` the facts can fill replaced by a value in `inputs`. What they cannot fill stays bound and
 * is named in `missing` (`backend_version needs previous-version`): a run with a bind left is not started. Binding in
 * two steps works: fill what is known now, the rest when the run starts.
 */
export function bindRuns(
  runs: readonly DeployRunStep[],
  facts: BindFacts,
): { runs: DeployRunStep[]; missing: string[] } {
  const missing: string[] = [];
  const out = runs.map((step): DeployRunStep => {
    if (step.kind === "github-workflow") {
      const filled = fillBinds(step.bind, step.inputs, facts, missing);
      const { bind: _all, inputs: _old, ...rest } = step;
      return {
        ...rest,
        ...(Object.keys(filled.values).length === 0 ? {} : { inputs: filled.values }),
        ...(Object.keys(filled.left).length === 0 ? {} : { bind: filled.left }),
      };
    }
    if (step.kind === "gitlab-job") {
      const filled = fillBinds(step.bind, step.variables, facts, missing);
      const { bind: _all, variables: _old, ...rest } = step;
      return {
        ...rest,
        ...(Object.keys(filled.values).length === 0 ? {} : { variables: filled.values }),
        ...(Object.keys(filled.left).length === 0 ? {} : { bind: filled.left }),
      };
    }
    return step;
  });
  return { runs: out, missing };
}

/** The values a run's binds give, and the binds the facts cannot fill yet. */
function fillBinds(
  bind: Readonly<Record<string, InputBinding>> | undefined,
  given: Readonly<Record<string, string>> | undefined,
  facts: BindFacts,
  missing: string[],
): { values: Record<string, string>; left: Record<string, InputBinding> } {
  const values: Record<string, string> = { ...given };
  const left: Record<string, InputBinding> = {};
  for (const [name, binding] of Object.entries(bind ?? {})) {
    const value = bindingValue(binding, facts);
    if (value === undefined) {
      missing.push(`${name} needs ${binding}`);
      left[name] = binding;
    } else values[name] = value;
  }
  return { values, left };
}

/** The binds of a run, whatever kind of run it is. */
function bindOf(step: DeployRunStep): Readonly<Record<string, InputBinding>> | undefined {
  return step.kind === "github-workflow" || step.kind === "gitlab-job" ? step.bind : undefined;
}

/** Every input name a recipe's runs bind to the given source, over its deploy and rollback runs. */
export function bindsOf(runs: readonly DeployRunStep[], binding: InputBinding): string[] {
  const names: string[] = [];
  for (const step of runs) {
    for (const [name, b] of Object.entries(bindOf(step) ?? {})) if (b === binding) names.push(name);
  }
  return names;
}

/** Whether a run builds the version majhi picks: it binds an input to `next-version`. */
export function isBuild(step: DeployRunStep): boolean {
  return Object.values(bindOf(step) ?? {}).includes("next-version");
}

/**
 * The runs of a deploy with no build and no version sent: for the parts of a project that deploy no image (a front
 * end).
 */
export function withoutVersion(runs: readonly DeployRunStep[]): DeployRunStep[] {
  return runs
    .filter((step) => !isBuild(step))
    .map((step) => {
      const bind = bindOf(step);
      if (bind === undefined) return step;
      const kept = Object.fromEntries(
        Object.entries(bind).filter(([, b]) => b !== "built-version" && b !== "previous-version"),
      );
      if (step.kind === "github-workflow") {
        const { bind: _b, ...rest } = step;
        return Object.keys(kept).length === 0 ? rest : { ...rest, bind: kept };
      }
      if (step.kind === "gitlab-job") {
        const { bind: _b, ...rest } = step;
        return Object.keys(kept).length === 0 ? rest : { ...rest, bind: kept };
      }
      return step;
    });
}

/** The version a set of dispatched inputs put live: the first input the runs bound to a version. */
export function versionPutLive(
  steps: readonly DeployRunStep[],
  sent: readonly (Record<string, string> | undefined)[],
): string | undefined {
  for (const [i, step] of steps.entries()) {
    for (const [name, binding] of Object.entries(bindOf(step) ?? {})) {
      if (binding !== "built-version" && binding !== "previous-version" && binding !== "next-version")
        continue;
      const value = sent[i]?.[name];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * The folders of the repo an environment deploys from: those of the parts its recipe chooses between, else the folders
 * the recipe says its job works in. Undefined when the recipe says nothing about which part of the project it is.
 */
export function scopeOf(recipe: DeployRecipe | undefined): string[] | undefined {
  if (recipe === undefined) return undefined;
  if (recipe.scope !== undefined) return recipe.scope;
  return recipe.components === undefined ? undefined : recipe.components.parts.map((p) => p.folder);
}

/** The folders whose children are the parts of a project. */
const PART_PARENTS = ["apps", "services", "packages"];

/** The part a path is in (`apps/voice-service` for `apps/voice-service/main.go`), when it is in one. */
export function partOf(path: string): string | undefined {
  const [parent, child] = path.split("/");
  return parent !== undefined && child !== undefined && PART_PARENTS.includes(parent) && child !== ""
    ? `${parent}/${child}`
    : undefined;
}

/** Whether a changed path is in one of the folders. */
export function underFolders(path: string, folders: readonly string[]): boolean {
  return folders.some((f) => path === f || path.startsWith(`${f}/`));
}

/** What a run sends: a workflow's inputs, a job's variables. */
export function sentOf(run: DeployRunStep): Record<string, string> | undefined {
  return run.kind === "github-workflow" ? run.inputs : run.kind === "gitlab-job" ? run.variables : undefined;
}

/** The version a deploy sent, wherever it was sent: any input the recipe binds to the version a build made. */
export function versionSent(
  recipe: DeployRecipe,
  sent: readonly (Record<string, string> | undefined)[],
): string | undefined {
  const names = [...bindsOf(recipe.deploy, "built-version"), ...bindsOf(recipe.deploy, "next-version")];
  for (const inputs of [...sent].reverse()) {
    for (const name of names) {
      const value = inputs?.[name];
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

/** The option of the recipe's parts input that a deploy sent, read back from what its runs sent. */
export function deployedComponents(
  recipe: DeployRecipe,
  sent: readonly (Record<string, string> | undefined)[],
): string | undefined {
  for (const name of bindsOf(recipe.deploy, "components")) {
    for (const inputs of sent) if (inputs?.[name] !== undefined) return inputs[name];
  }
  return undefined;
}

/** Whether the part is one that deploys no image: it has no version, so it goes back by commit. */
export function isVersionless(recipe: DeployRecipe, option: string | undefined): boolean {
  return option !== undefined && (recipe.components?.versionless ?? []).includes(option);
}

/**
 * The inputs a run's title holds, read back through the pieces of the workflow's `run-name`. A title that does
 * not fit the pieces, or two inputs with no text between them (where the split would be a guess), read as nothing.
 */
export function inputsFromTitle(
  parts: readonly RunNamePart[],
  title: string,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let at = 0;
  for (const [i, part] of parts.entries()) {
    if (part.kind === "text") {
      if (!title.startsWith(part.text, at)) return undefined;
      at += part.text.length;
      continue;
    }
    const next = parts[i + 1];
    let value: string;
    if (next === undefined) {
      value = title.slice(at);
      at = title.length;
    } else if (next.kind === "text" && next.text !== "") {
      const end = title.indexOf(next.text, at);
      if (end < 0) return undefined;
      value = title.slice(at, end);
      at = end;
    } else {
      return undefined;
    }
    // What the title says for an empty input is not a value.
    if (value !== part.fallback) out[part.name] = value;
  }
  return at === title.length ? out : undefined;
}

/** Whether a run's title is one of this environment's: every input the recipe pins has that value. */
export function titleIsFor(live: Extract<LiveSource, { kind: "run-name" }>, title: string) {
  const got = inputsFromTitle(live.parts, title);
  if (got === undefined) return undefined;
  for (const [name, value] of Object.entries(live.match)) if (got[name] !== value) return undefined;
  const version = got[live.version];
  if (version === undefined || version === "") return undefined;
  const commit = live.commit === undefined ? undefined : got[live.commit];
  return { version, ...(commit === undefined || commit === "" ? {} : { commit }) };
}

/**
 * The option of a `components` input for a change: the part whose folder holds every changed path, the `all` option
 * when the paths span parts or fall outside them. `undefined` when the recipe has no folders to go by.
 */
export function componentsFor(
  components: NonNullable<DeployRecipe["components"]>,
  changedPaths: readonly string[],
): { option: string; why: string } | undefined {
  if (components.parts.length === 0 || changedPaths.length === 0) return undefined;
  const touched = new Set<string>();
  let outside = false;
  for (const path of changedPaths) {
    const part = components.parts.find((p) => path === p.folder || path.startsWith(`${p.folder}/`));
    if (part === undefined) outside = true;
    else touched.add(part.option);
  }
  const [only] = [...touched];
  if (touched.size === 1 && !outside && only !== undefined) {
    return { option: only, why: `only ${only} files changed` };
  }
  return {
    option: components.all,
    why: outside
      ? `some changed files are outside ${components.parts.map((p) => p.folder).join(" and ")}`
      : `changes in ${[...touched].join(" and ")}`,
  };
}

/** The recipe's runs that matter to a deploy, as one line for the case room: "GitHub workflow release.yml". */
export function recipeSource(env: DeployEnvironment): string | undefined {
  const from = env.recipe?.from;
  return from === undefined ? undefined : `${from.file}${from.line === undefined ? "" : `:${from.line}`}`;
}

/** The commit a version names, when the build tags images by the whole commit with a fixed prefix. */
export function commitOfVersion(recipe: DeployRecipe, version: string): string | undefined {
  const parts = recipe.build;
  if (parts === undefined) return undefined;
  const sha = parts.at(-1);
  if (sha?.kind !== "commit" || sha.length !== 40) return undefined;
  const prefix = parts
    .slice(0, -1)
    .map((p) => (p.kind === "text" ? p.text : undefined))
    .join("");
  if (parts.slice(0, -1).some((p) => p.kind !== "text") || !version.startsWith(prefix)) return undefined;
  const rest = version.slice(prefix.length);
  return rest.length === 40 ? rest : undefined;
}

/** A version tag read by its characters: the text before its three numbers, the numbers, and the text after them. */
export interface TagParts {
  prefix: string;
  numbers: [number, number, number];
  suffix: string;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/**
 * `globex-1.2.3` is `globex-`, 1, 2, 3 and nothing after. The numbers are the last three runs of digits that are
 * joined by single dots; anything else in the tag is kept as it is. Undefined when the tag has no such three numbers
 * (a commit, `1.4`, `latest`).
 */
export function parseTag(tag: string): TagParts | undefined {
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < tag.length; i++) {
    if (!isDigit(tag[i])) continue;
    const start = i;
    while (isDigit(tag[i + 1])) i++;
    runs.push({ start, end: i + 1 });
  }
  for (let at = runs.length - 3; at >= 0; at--) {
    const [x, y, z] = [runs[at], runs[at + 1], runs[at + 2]];
    if (x === undefined || y === undefined || z === undefined) continue;
    if (tag[x.end] !== "." || y.start !== x.end + 1 || tag[y.end] !== "." || z.start !== y.end + 1) continue;
    return {
      prefix: tag.slice(0, x.start),
      numbers: [
        Number(tag.slice(x.start, x.end)),
        Number(tag.slice(y.start, y.end)),
        Number(tag.slice(z.start, z.end)),
      ],
      suffix: tag.slice(z.end),
    };
  }
  return undefined;
}

function newer(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

/**
 * The next patch after the highest version of the same shape: the tag keeps its prefix and suffix, so `globex-1.2.3`
 * is followed by `globex-1.2.4`. The shape is the one of `like` (what the target runs now) when it has one; else the
 * shape of the highest version known. Undefined when no known version has the shape.
 */
export function nextPatch(
  versions: readonly (string | undefined)[],
  like?: string | undefined,
): { version: string; after: string } | undefined {
  const shape = like === undefined ? undefined : parseTag(like);
  let best: { parts: TagParts; text: string } | undefined;
  for (const text of versions) {
    const parts = text === undefined ? undefined : parseTag(text);
    if (text === undefined || parts === undefined) continue;
    if (shape !== undefined && (parts.prefix !== shape.prefix || parts.suffix !== shape.suffix)) continue;
    if (best === undefined || newer(parts.numbers, best.parts.numbers)) best = { parts, text };
  }
  if (best === undefined) return undefined;
  const [major, minor, patch] = best.parts.numbers;
  return {
    version: `${best.parts.prefix}${major}.${minor}.${patch + 1}${best.parts.suffix}`,
    after: best.text,
  };
}

/**
 * The tags of the running containers whose image is the build's: `docker ps --format '{{.Image}}'` lines, matched by the
 * image name (the whole name, or its last part when the workflow only names it by an expression).
 */
export function tagsOfRunning(
  running: NonNullable<DeployRecipe["running"]>,
  lines: readonly string[],
): string[] {
  const tags = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const noDigest = line.split("@")[0] ?? line;
    const slash = noDigest.lastIndexOf("/");
    const colon = noDigest.lastIndexOf(":");
    if (colon <= slash) continue;
    const repo = noDigest.slice(0, colon);
    const last = repo.split("/").at(-1);
    if (running.whole ? repo === running.repo : last === running.repo) tags.add(noDigest.slice(colon + 1));
  }
  return [...tags];
}

/** The lowercase letters and digits of a text, as words. */
export function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  let word = "";
  for (const c of text.toLowerCase()) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) word += c;
    else if (word !== "") {
      words.add(word);
      word = "";
    }
  }
  if (word !== "") words.add(word);
  return words;
}
