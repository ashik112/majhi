import type {
  DeployEnvironment,
  DeployRecipe,
  DeployRunStep,
  InputBinding,
  LiveSource,
  RecipeAsk,
  RunNamePart,
  TagPart,
} from "@majhi/shared";
import type { CiFiles, GitlabFile, YamlFile } from "../ci/read.ts";

/**
 * How a project deploys, read from its own CI files with a YAML parser. A GitHub workflow with `workflow_dispatch`
 * that deploys, releases or rolls back gives one environment per option of its target input; a GitLab job with an
 * `environment:` gives one environment. Each carries a recipe: the runs that deploy it and the runs that put it back.
 * Anything that cannot be filled with certainty is an `asks` entry of the recipe, never a guess.
 *
 * Words in names (deploy, rollback, target, version) are looked up in the tables below, as typed data.
 */

export interface DiscoverInput {
  files: CiFiles;
  /** The project's base branch. */
  base: string;
  /** The host of the project's remote: only that host's CI files can deploy it. */
  provider: "github" | "gitlab" | "bitbucket" | undefined;
  /** The remote the runs name. */
  remote: string;
  /** Folders of the repo's root, and the children of `apps`, `services` and `packages`: where a component lives. */
  folders: readonly string[];
}

export interface Discovered {
  environments: DeployEnvironment[];
  /** What was seen and left alone, one line each, for the log. */
  notes: string[];
}

const DEPLOY_WORDS = ["deploy", "release", "promote", "ship", "publish"];
const ROLLBACK_WORDS = ["rollback", "roll-back", "roll_back", "revert"];
const BUILD_WORDS = ["build", "image", "package", "docker"];
/** Input names that choose which environment a run is for. */
const TARGET_NAMES = ["target", "environment", "env", "client", "customer", "tenant", "site", "stage"];
/** Input names that hold the commit, branch or tag a run starts from. */
const REF_NAMES = ["source_ref", "ref", "sha", "commit", "git_ref", "revision", "source", "branch"];
/** Input names that choose which parts of the project to deploy. */
const COMPONENT_NAMES = ["components", "component", "parts", "services", "apps", "scope"];
/** Option names of a components input that mean every part. */
const ALL_WORDS = ["both", "all", "everything", "full"];
/** Environment names that are not production. */
const STAGING_WORDS = ["staging", "stage", "stg", "dev", "development", "qa", "test"];
const PARENT_FOLDERS = ["apps", "services", "packages"];

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

function includesWord(name: string, words: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return words.some((w) => lower.includes(w));
}

/** A name an environment may have: lowercase letters, digits and dashes, at most 40. Empty when nothing is left. */
export function envNameOf(raw: string): string {
  let out = "";
  for (const c of raw.toLowerCase()) {
    const ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    if (ok) out += c;
    else if (out !== "" && !out.endsWith("-")) out += "-";
  }
  out = out.slice(0, 40);
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}

/** Production, unless the name is a staging word or made of them (`staging`, `eu-dev`). */
function tierOf(env: string): DeployEnvironment["tier"] {
  return env.split("-").some((part) => STAGING_WORDS.includes(part)) ? "staging" : "production";
}

// ---------------------------------------------------------------------------
// GitHub workflows

interface InputSpec {
  name: string;
  options: string[];
  required: boolean;
  hasDefault: boolean;
  description: string | undefined;
}

type FlowKind = "build" | "release" | "rollback" | "other";

interface Flow {
  file: YamlFile;
  /** The file's name, as `workflow:` writes it. */
  base: string;
  kind: FlowKind;
  dispatch: boolean;
  inputs: InputSpec[];
  runName: RunNamePart[] | undefined;
}

function dispatchOf(data: unknown): { dispatch: boolean; inputs: InputSpec[] } {
  const on = rec(data).on;
  let spec: unknown;
  let dispatch = false;
  if (on === "workflow_dispatch") dispatch = true;
  else if (Array.isArray(on)) dispatch = on.includes("workflow_dispatch");
  else if ("workflow_dispatch" in rec(on)) {
    dispatch = true;
    spec = rec(on).workflow_dispatch;
  }
  const inputs: InputSpec[] = [];
  for (const [name, raw] of Object.entries(rec(rec(spec).inputs))) {
    const input = rec(raw);
    const options = Array.isArray(input.options)
      ? input.options.map(text).filter((o): o is string => o !== undefined)
      : [];
    inputs.push({
      name,
      options,
      required: input.required === true,
      hasDefault: input.default !== undefined && input.default !== null && input.default !== "",
      description: text(input.description),
    });
  }
  return { dispatch, inputs };
}

/** The pieces of a `run-name` made of fixed text and `inputs.<name>`. Undefined when it holds any other expression. */
export function runNameParts(raw: unknown): RunNamePart[] | undefined {
  const source = text(raw);
  if (source === undefined) return undefined;
  const parts: RunNamePart[] = [];
  let rest = source;
  while (rest !== "") {
    const open = rest.indexOf("${{");
    if (open < 0) {
      parts.push({ kind: "text", text: rest });
      break;
    }
    if (open > 0) parts.push({ kind: "text", text: rest.slice(0, open) });
    const close = rest.indexOf("}}", open);
    if (close < 0) return undefined;
    const name = inputOf(rest.slice(open + 3, close).trim());
    if (name === undefined) return undefined;
    parts.push({ kind: "input", name });
    rest = rest.slice(close + 2);
  }
  return parts.length === 0 ? undefined : parts;
}

/** `inputs.target` or `github.event.inputs.target` -> `target`. */
function inputOf(expression: string): string | undefined {
  for (const prefix of ["inputs.", "github.event.inputs."]) {
    if (expression.startsWith(prefix)) {
      const name = expression.slice(prefix.length);
      return name !== "" && !name.includes(".") && !name.includes(" ") ? name : undefined;
    }
  }
  return undefined;
}

function flowOf(file: YamlFile): Flow {
  const data = file.located.data;
  const base = file.path.split("/").at(-1) ?? file.path;
  const { dispatch, inputs } = dispatchOf(data);
  const name = text(rec(data).name) ?? "";
  const label = `${base} ${name}`;
  const hasTarget = inputs.some((i) => TARGET_NAMES.includes(i.name) && i.options.length > 0);
  let kind: FlowKind = "other";
  if (includesWord(label, ROLLBACK_WORDS)) kind = "rollback";
  else if (includesWord(label, DEPLOY_WORDS)) kind = "release";
  else if (includesWord(label, BUILD_WORDS)) kind = "build";
  else if (hasTarget) kind = "release";
  return { file, base, kind, dispatch, inputs, runName: runNameParts(rec(data)["run-name"]) };
}

// The tag a build gives an image, when it is a function of the commit alone.

const SHA_EXPRESSIONS = ["github.sha", "github.event.pull_request.head.sha"];

/** `sha-${{ github.sha }}` -> text and the commit. Undefined when it holds any other expression. */
function tagPartsOf(template: string): TagPart[] | undefined {
  const parts: TagPart[] = [];
  let rest = template.trim();
  while (rest !== "") {
    const open = rest.indexOf("${{");
    if (open < 0) {
      parts.push({ kind: "text", text: rest });
      break;
    }
    if (open > 0) parts.push({ kind: "text", text: rest.slice(0, open) });
    const close = rest.indexOf("}}", open);
    if (close < 0) return undefined;
    if (!SHA_EXPRESSIONS.includes(rest.slice(open + 3, close).trim())) return undefined;
    parts.push({ kind: "commit", length: 40 });
    rest = rest.slice(close + 2);
  }
  return parts.length === 0 ? undefined : parts;
}

/** The tag after the last `:` that is outside a `${{ }}`: `ghcr.io/acme/shop:${{ github.sha }}` -> `${{ github.sha }}`. */
function tagOfReference(line: string): string | undefined {
  let depth = 0;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line.startsWith("${{", i)) depth++;
    else if (line.startsWith("}}", i)) depth = Math.max(0, depth - 1);
    else if (line[i] === ":" && depth === 0) colon = i;
  }
  return colon < 0 ? undefined : line.slice(colon + 1).trim();
}

/** A docker/metadata-action tag line: `type=sha`, `type=sha,format=long,prefix=v`, `type=raw,value=...`. */
function tagOfMetadata(line: string): TagPart[] | undefined {
  const fields = new Map<string, string>();
  for (const piece of line.split(",")) {
    const eq = piece.indexOf("=");
    if (eq > 0) fields.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const type = fields.get("type");
  if (type === "sha") {
    const prefix = fields.get("prefix") ?? "sha-";
    const length = fields.get("format") === "long" ? 40 : 7;
    return [...(prefix === "" ? [] : [{ kind: "text" as const, text: prefix }]), { kind: "commit", length }];
  }
  if (type === "raw") {
    const value = fields.get("value");
    return value === undefined ? undefined : tagPartsOf(value);
  }
  return undefined;
}

function buildTag(flow: Flow): TagPart[] | undefined {
  const lines: string[] = [];
  for (const job of Object.values(rec(rec(flow.file.located.data).jobs))) {
    for (const step of Array.isArray(rec(job).steps) ? (rec(job).steps as unknown[]) : []) {
      const withs = rec(rec(step).with);
      for (const key of ["tags", "tag"]) {
        const value = text(withs[key]);
        if (value !== undefined) lines.push(...value.split("\n"));
      }
    }
  }
  const found: TagPart[][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const parts = line.startsWith("type=")
      ? tagOfMetadata(line)
      : (() => {
          const tag = tagOfReference(line);
          return tag === undefined ? undefined : tagPartsOf(tag);
        })();
    if (parts !== undefined && parts.some((p) => p.kind === "commit")) found.push(parts);
  }
  // Several tags for one image: the first that is a function of the commit.
  return found[0];
}

// The runs of a recipe.

interface Roles {
  target: string | undefined;
  refs: string[];
  versions: string[];
  components: InputSpec | undefined;
}

function rolesOf(flow: Flow): Roles {
  const names = flow.inputs.map((i) => i.name);
  return {
    target: flow.inputs.find((i) => TARGET_NAMES.includes(i.name) && i.options.length > 0)?.name,
    refs: names.filter((n) => REF_NAMES.includes(n)),
    versions: names.filter(
      (n) =>
        n === "version" || n === "tag" || n === "image_tag" || n.endsWith("_version") || n.endsWith("_tag"),
    ),
    components: flow.inputs.find((i) => COMPONENT_NAMES.includes(i.name) && i.options.length > 0),
  };
}

interface Built {
  step: DeployRunStep;
  asks: RecipeAsk[];
}

/**
 * One dispatch of a workflow for an environment. `mode` says what the bound inputs mean: a deploy puts the
 * commit and the version just built; a rollback puts the version and commit the environment ran before.
 */
function dispatchStep(
  flow: Flow,
  remote: string,
  fixed: Record<string, string>,
  mode: "deploy" | "rollback",
): Built {
  const inputs: Record<string, string> = { ...fixed };
  const bind: Record<string, InputBinding> = {};
  const asks: RecipeAsk[] = [];
  const own = rolesOf(flow);
  const [version] = own.versions;
  for (const spec of flow.inputs) {
    if (spec.name in fixed) continue;
    if (own.refs.includes(spec.name)) bind[spec.name] = mode === "deploy" ? "commit" : "previous-commit";
    else if (own.versions.length === 1 && spec.name === version) {
      bind[spec.name] = mode === "deploy" ? "built-version" : "previous-version";
    } else if (spec.name === own.components?.name) bind[spec.name] = "components";
    else if (spec.required && !spec.hasDefault) {
      asks.push({
        key: `input:${spec.name}`,
        question: `${flow.base} needs ${spec.name}${spec.description === undefined ? "" : ` (${spec.description})`}. What value?`,
        options: spec.options.slice(0, 8),
      });
    }
  }
  const step: DeployRunStep = {
    kind: "github-workflow",
    remote,
    workflow: flow.base,
    ref: "base",
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    ...(Object.keys(bind).length === 0 ? {} : { bind }),
  };
  return { step, asks };
}

function lineOfTarget(flow: Flow, target: string | undefined): number | undefined {
  const at = flow.file.located;
  return (
    (target === undefined ? undefined : at.lineOf(["on", "workflow_dispatch", "inputs", target])) ??
    at.lineOf(["on", "workflow_dispatch"]) ??
    at.lineOf(["on"])
  );
}

function githubEnvironments(input: DiscoverInput, notes: string[]): DeployEnvironment[] {
  const flows = input.files.workflows.map(flowOf);
  const release =
    flows.find((f) => f.kind === "release" && f.dispatch && f.inputs.length > 0) ??
    flows.find((f) => f.kind === "release" && f.dispatch);
  if (release === undefined) return [];
  const rollback = flows.find((f) => f.kind === "rollback" && f.dispatch);
  const build = flows.find((f) => f.kind === "build");
  const roles = rolesOf(release);
  const tag = build === undefined ? undefined : buildTag(build);
  const targets =
    roles.target === undefined ? [] : (release.inputs.find((i) => i.name === roles.target)?.options ?? []);
  const options = targets.length > 0 ? targets : [undefined];
  const out: DeployEnvironment[] = [];

  for (const option of options) {
    const env = envNameOf(option ?? "production");
    if (env === "") {
      notes.push(`${release.file.path}: the target ${option ?? ""} is not a name majhi can use`);
      continue;
    }
    const fixed = roles.target === undefined || option === undefined ? {} : { [roles.target]: option };
    const asks: RecipeAsk[] = [];

    // Deploy: the build for the commit, when there is one to run, then the release.
    const deploy: DeployRunStep[] = [];
    if (build !== undefined && build.dispatch && roles.versions.length > 0) {
      const built = dispatchStep(build, input.remote, {}, "deploy");
      deploy.push(built.step);
      asks.push(...built.asks);
    } else if (build !== undefined && roles.versions.length > 0 && tag !== undefined) {
      notes.push(`${build.file.path} runs on push, so ${release.file.path} deploys what it already built`);
    }
    const released = dispatchStep(release, input.remote, fixed, "deploy");
    deploy.push(released.step);
    asks.push(...released.asks);
    if (roles.versions.length > 0 && tag === undefined) {
      asks.push({
        key: "input:build-version",
        question: `${build?.base ?? "The build"} does not name its version by the commit alone. What version should ${release.base} deploy for ${env}?`,
        options: [],
      });
    }

    // Rollback: the rollback workflow with the version before, else the release itself with it.
    const backer = rollback ?? release;
    const backRoles = rolesOf(backer);
    const backFixed =
      backRoles.target === undefined || option === undefined ? {} : { [backRoles.target]: option };
    const back = dispatchStep(backer, input.remote, backFixed, "rollback");
    if (backer === rollback) asks.push(...back.asks.filter((a) => !asks.some((x) => x.key === a.key)));

    // Components: which parts a change deploys.
    const components = componentsOf(release, input.folders);
    if (components === "asks") {
      const spec = roles.components;
      asks.push({
        key: "components",
        question: `Which part of ${env} does this change deploy?`,
        options: spec?.options.slice(0, 8) ?? [],
      });
    }

    const live = liveOf(release, roles, input.remote, option);
    const recipe: DeployRecipe = {
      from: { file: release.file.path, ...optionalLine(lineOfTarget(release, roles.target)) },
      deploy: deploy as DeployRecipe["deploy"],
      rollback: { runs: [back.step], at: "deployed" },
      ...(tag === undefined ? {} : { build: tag }),
      ...(live === undefined ? {} : { live }),
      ...(components === undefined || components === "asks" ? {} : { components }),
      asks: dedupeAsks(asks),
    };
    out.push({ env, tier: tierOf(env), recipe });
  }
  return out;
}

const optionalLine = (line: number | undefined): { line?: number } => (line === undefined ? {} : { line });

function dedupeAsks(asks: RecipeAsk[]): RecipeAsk[] {
  const seen = new Set<string>();
  return asks.filter((a) => !seen.has(a.key) && seen.add(a.key));
}

/** The folder of each part of a `components` input, or `asks` when some part has none. Undefined: no such input. */
function componentsOf(
  release: Flow,
  folders: readonly string[],
): NonNullable<DeployRecipe["components"]> | "asks" | undefined {
  const spec = rolesOf(release).components;
  if (spec === undefined) return undefined;
  const all = spec.options.find((o) => ALL_WORDS.includes(o.toLowerCase()));
  if (all === undefined) return "asks";
  const parts: { option: string; folder: string }[] = [];
  for (const option of spec.options) {
    if (option === all) continue;
    const folder = folderOf(option, folders);
    if (folder === undefined) return "asks";
    parts.push({ option, folder });
  }
  return parts.length === 0 ? "asks" : { all, parts };
}

function folderOf(option: string, folders: readonly string[]): string | undefined {
  const name = option.toLowerCase();
  if (folders.includes(name)) return name;
  for (const parent of PARENT_FOLDERS) if (folders.includes(`${parent}/${name}`)) return `${parent}/${name}`;
  return undefined;
}

function liveOf(
  release: Flow,
  roles: Roles,
  remote: string,
  option: string | undefined,
): LiveSource | undefined {
  const parts = release.runName;
  const [version] = roles.versions;
  if (parts === undefined || version === undefined) return undefined;
  const named = new Set(parts.flatMap((p) => (p.kind === "input" ? [p.name] : [])));
  if (!named.has(version)) return undefined;
  if (roles.target !== undefined && !named.has(roles.target)) return undefined;
  const commit = roles.refs.find((r) => named.has(r));
  return {
    kind: "run-name",
    remote,
    workflow: release.base,
    parts,
    match: roles.target === undefined || option === undefined ? {} : { [roles.target]: option },
    version,
    ...(commit === undefined ? {} : { commit }),
  };
}

// ---------------------------------------------------------------------------
// GitLab jobs

const GITLAB_KEYWORDS = new Set([
  "stages",
  "variables",
  "default",
  "include",
  "workflow",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "pages",
]);

/** The branches a job is limited to by `only:` or by `rules: - if: $CI_COMMIT_BRANCH == "x"`. */
function jobBranches(job: Record<string, unknown>): string[] {
  const out: string[] = [];
  const only = job.only;
  const refs = Array.isArray(only)
    ? only
    : Array.isArray(rec(only).refs)
      ? (rec(only).refs as unknown[])
      : [];
  for (const r of refs) if (typeof r === "string") out.push(r);
  for (const rule of Array.isArray(job.rules) ? job.rules : []) {
    const condition = text(rec(rule).if);
    if (condition === undefined) continue;
    const sides = condition.split("==").map((s) => s.trim());
    const [left, right] = sides;
    if (sides.length !== 2 || left === undefined || right === undefined) continue;
    if (left !== "$CI_COMMIT_BRANCH" && left !== "$CI_COMMIT_REF_NAME") continue;
    const quote = right[0];
    if ((quote === '"' || quote === "'") && right.endsWith(quote) && right.length > 2)
      out.push(right.slice(1, -1));
  }
  return out;
}

function isManual(job: Record<string, unknown>): boolean {
  if (job.when === "manual") return true;
  return (Array.isArray(job.rules) ? job.rules : []).some((r) => rec(r).when === "manual");
}

function gitlabEnvironments(input: DiscoverInput): DeployEnvironment[] {
  const out: DeployEnvironment[] = [];
  for (const file of input.files.gitlab as GitlabFile[]) {
    for (const [name, raw] of Object.entries(rec(file.located.data))) {
      if (GITLAB_KEYWORDS.has(name) || name.startsWith(".")) continue;
      const job = rec(raw);
      if (job.script === undefined && job.trigger === undefined) continue;
      const environment = job.environment;
      const envName = typeof environment === "string" ? environment : text(rec(environment).name);
      if (envName === undefined || envName.includes("$") || rec(environment).action === "stop") continue;
      const env = envNameOf(envName);
      if (env === "") continue;
      const line = file.located.lineOf([name]);
      const from = { file: file.path, ...optionalLine(line) };
      const live: LiveSource = { kind: "gitlab-environment", remote: input.remote, name: envName };
      if (isManual(job)) {
        const runs: DeployRunStep[] = [{ kind: "gitlab-job", remote: input.remote, job: name }];
        out.push({
          env,
          tier: tierOf(env),
          recipe: {
            from,
            deploy: runs as DeployRecipe["deploy"],
            rollback: { runs: runs as DeployRecipe["deploy"], at: "previous" },
            live,
            asks: [],
          },
        });
        continue;
      }
      const [branch] = jobBranches(job);
      if (branch === undefined) continue;
      const runs: DeployRunStep[] =
        branch === input.base
          ? [{ kind: "gitlab-pipeline", remote: input.remote, ref: "base" }]
          : [{ kind: "gitlab-merge", remote: input.remote, branch }];
      out.push({
        env,
        tier: tierOf(env),
        ...(branch === input.base ? {} : { branch }),
        recipe: { from, deploy: runs as DeployRecipe["deploy"], live, asks: [] },
      });
    }
  }
  return out;
}

/** The environments the project's CI deploys, each with its recipe. Each environment is listed once, the first wins. */
export function discoverEnvironments(input: DiscoverInput): Discovered {
  const notes: string[] = [];
  const found: DeployEnvironment[] = [];
  if (input.provider === "github") found.push(...githubEnvironments(input, notes));
  else if (input.provider === "gitlab") found.push(...gitlabEnvironments(input));
  const seen = new Set<string>();
  const environments = found.filter((e) => !seen.has(e.env) && seen.add(e.env));
  return { environments, notes };
}
