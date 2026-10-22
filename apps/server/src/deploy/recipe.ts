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

function valueOf(binding: InputBinding, facts: BindFacts): string | undefined {
  switch (binding) {
    case "commit":
      return facts.commit;
    case "built-version":
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
    if (step.kind !== "github-workflow" || step.bind === undefined) return step;
    const inputs: Record<string, string> = { ...step.inputs };
    const left: Record<string, InputBinding> = {};
    for (const [name, binding] of Object.entries(step.bind)) {
      const value = valueOf(binding, facts);
      if (value === undefined) {
        missing.push(`${name} needs ${binding}`);
        left[name] = binding;
      } else inputs[name] = value;
    }
    const { bind: _all, inputs: _old, ...rest } = step;
    return {
      ...rest,
      ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
      ...(Object.keys(left).length === 0 ? {} : { bind: left }),
    };
  });
  return { runs: out, missing };
}

/** Every input name a recipe's runs bind to the given source, over its deploy and rollback runs. */
export function bindsOf(runs: readonly DeployRunStep[], binding: InputBinding): string[] {
  const names: string[] = [];
  for (const step of runs) {
    if (step.kind !== "github-workflow" || step.bind === undefined) continue;
    for (const [name, b] of Object.entries(step.bind)) if (b === binding) names.push(name);
  }
  return names;
}

/** The version a set of dispatched inputs put live: the first input the runs bound to a version. */
export function versionPutLive(
  steps: readonly DeployRunStep[],
  sent: readonly (Record<string, string> | undefined)[],
): string | undefined {
  for (const [i, step] of steps.entries()) {
    if (step.kind !== "github-workflow" || step.bind === undefined) continue;
    for (const [name, binding] of Object.entries(step.bind)) {
      if (binding !== "built-version" && binding !== "previous-version") continue;
      const value = sent[i]?.[name];
      if (value !== undefined) return value;
    }
  }
  return undefined;
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
    if (next === undefined) {
      out[part.name] = title.slice(at);
      at = title.length;
    } else if (next.kind === "text" && next.text !== "") {
      const end = title.indexOf(next.text, at);
      if (end < 0) return undefined;
      out[part.name] = title.slice(at, end);
      at = end;
    } else {
      return undefined;
    }
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
