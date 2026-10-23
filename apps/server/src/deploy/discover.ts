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
import {
  commandsOf,
  confirmationsRead,
  expandVariables,
  foldersTouched,
  type JobEntry,
  type JobVariable,
  jobEntries,
  jobVariables,
  optionsAccepted,
  resolveJob,
  scriptFiles,
  scriptLines,
  settingsFor,
  sourcedPaths,
} from "./gitlab-jobs.ts";

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
  /** A file of the repo at the same commit as the CI files, as text. Reads the settings a job's script sources. */
  read?: ((rel: string) => Promise<string | undefined>) | undefined;
}

export interface Discovered {
  environments: DeployEnvironment[];
  /** What was seen and left alone, one line each, for the log. */
  notes: string[];
}

const DEPLOY_WORDS = ["deploy", "release", "promote", "ship", "publish"];
const ROLLBACK_WORDS = ["rollback", "roll-back", "roll_back", "revert"];
const BUILD_WORDS = ["build", "image", "package", "docker"];
/**
 * Words of a workflow that say it does another job on a target, even when it also says deploy: it runs a data backfill,
 * a migration, a prune, a bootstrap, a check. Such a workflow is never the way a project deploys. Matched by the start of
 * a word of its file name, name or run name (`migrat` is migrate, migration, migrations).
 */
const OTHER_JOB_WORDS = [
  "backfill",
  "migrat",
  "prune",
  "bootstrap",
  "rekey",
  "rehears",
  "verif",
  "status",
  "hygiene",
  "seed",
  "restor",
  "backup",
  "rotat",
  "cleanup",
  "report",
  "audit",
  "smoke",
  "health",
  "reindex",
  "maintenance",
  "prepar",
  "bump",
];
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

/** The words of a name: its runs of letters and digits, lowercase. */
export function wordsIn(name: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const c of name.toLowerCase()) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) word += c;
    else if (word !== "") {
      out.push(word);
      word = "";
    }
  }
  if (word !== "") out.push(word);
  return out;
}

/** Whether a word of the name starts with one of the stems. */
function startsWithWord(name: string, stems: readonly string[]): boolean {
  return wordsIn(name).some((w) => stems.some((s) => w.startsWith(s)));
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
  /** The file's name, its name and its run name, as one text to read words from. */
  label: string;
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
    const expression = rest.slice(open + 3, close).trim();
    // `inputs.version || 'next version'`: the input, and what the title says when it is empty.
    const [left, right, more] = expression.split("||").map((side) => side.trim());
    const name = left === undefined ? undefined : inputOf(left);
    if (name === undefined || more !== undefined) return undefined;
    const fallback =
      right === undefined
        ? undefined
        : right.length >= 2 && right.startsWith("'") && right.endsWith("'")
          ? right.slice(1, -1)
          : null;
    if (fallback === null) return undefined;
    parts.push({ kind: "input", name, ...(fallback === undefined ? {} : { fallback }) });
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
  const label = `${base} ${name} ${text(rec(data)["run-name"]) ?? ""}`;
  // A workflow is a release only when its own words say deploy and none says it does something else. One that merely
  // takes a target is not: majhi never guesses that a workflow deploys.
  let kind: FlowKind = "other";
  if (includesWord(label, ROLLBACK_WORDS)) kind = "rollback";
  else if (startsWithWord(label, OTHER_JOB_WORDS)) kind = "other";
  else if (startsWithWord(label, DEPLOY_WORDS)) kind = "release";
  else if (includesWord(label, BUILD_WORDS)) kind = "build";
  return { file, label, base, kind, dispatch, inputs, runName: runNameParts(rec(data)["run-name"]) };
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

/** Words in a version input's description that say it sets the tag the build makes. */
const TAG_WORDS = ["tag", "x.y.z"];

/**
 * A build with a version input that sets the tag it makes (`version`, X.Y.Z, must not exist yet): majhi fills it with
 * the next patch itself, and reads the versions already built from the titles of the build's runs.
 */
function pickOf(flow: Flow, remote: string): DeployRecipe["pick"] {
  if (!flow.dispatch) return undefined;
  const spec = flow.inputs.find(
    (i) =>
      (i.name === "version" || i.name.endsWith("_version")) &&
      TAG_WORDS.some((w) => (i.description ?? "").toLowerCase().includes(w)),
  );
  if (spec === undefined) return undefined;
  const names = new Set(flow.runName?.flatMap((p) => (p.kind === "input" ? [p.name] : [])));
  const ref = rolesOf(flow).refs.find((r) => names.has(r));
  return {
    input: spec.name,
    ...(flow.runName !== undefined && names.has(spec.name)
      ? {
          runs: {
            remote,
            workflow: flow.base,
            parts: flow.runName,
            ...(ref === undefined ? {} : { ref }),
          },
        }
      : {}),
  };
}

/** An image reference without its tag: `ghcr.io/acme/shop:1.2.3` is `ghcr.io/acme/shop`, `host:5000/shop` is itself. */
function withoutTag(reference: string): string {
  let depth = 0;
  let colon = -1;
  let slash = -1;
  for (let i = 0; i < reference.length; i++) {
    if (reference.startsWith("${{", i)) depth++;
    else if (reference.startsWith("}}", i)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && reference[i] === ":") colon = i;
    else if (depth === 0 && reference[i] === "/") slash = i;
  }
  return colon > slash ? reference.slice(0, colon) : reference;
}

/** The image a build makes, from the `images:` and `tags:` of its steps and the image names in its environment. */
function imageOf(flow: Flow): DeployRecipe["running"] {
  const found: string[] = [];
  const add = (value: unknown, tagged: boolean) => {
    for (const raw of (text(value) ?? "").split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("type=")) continue;
      found.push(tagged ? withoutTag(line) : line);
    }
  };
  const environment = (value: unknown) => {
    for (const [name, v] of Object.entries(rec(value))) {
      const upper = name.toUpperCase();
      if (upper.includes("IMAGE") || upper.includes("REPOSITORY")) add(v, false);
    }
  };
  const data = rec(flow.file.located.data);
  environment(data.env);
  for (const job of Object.values(rec(data.jobs))) {
    environment(rec(job).env);
    for (const step of Array.isArray(rec(job).steps) ? (rec(job).steps as unknown[]) : []) {
      environment(rec(step).env);
      add(rec(rec(step).with).images, false);
      add(rec(rec(step).with).tags, true);
    }
  }
  for (const reference of found) {
    if (!reference.includes("${{")) return { repo: reference, whole: true };
    const last = reference.split("/").at(-1) ?? "";
    if (last !== "" && !last.includes("${{")) return { repo: last, whole: false };
  }
  return undefined;
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
  pickInput?: string,
): Built {
  const inputs: Record<string, string> = { ...fixed };
  const bind: Record<string, InputBinding> = {};
  const asks: RecipeAsk[] = [];
  const own = rolesOf(flow);
  const [version] = own.versions;
  for (const spec of flow.inputs) {
    if (spec.name in fixed) continue;
    if (spec.name === pickInput) bind[spec.name] = "next-version";
    else if (own.refs.includes(spec.name)) bind[spec.name] = mode === "deploy" ? "commit" : "previous-commit";
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

/**
 * What a build must be told that depends on the environment: an input that chooses between several options (which
 * registry, which artifact) and is none of the inputs a recipe fills itself. It is the environment's own name when that
 * is one of the options; any other case is a question, never the default (a default is for a person who looks).
 */
function chosenInputs(build: Flow, env: string): { fixed: Record<string, string>; asks: RecipeAsk[] } {
  const roles = rolesOf(build);
  const own = new Set([roles.target, roles.components?.name, ...roles.refs, ...roles.versions]);
  const fixed: Record<string, string> = {};
  const asks: RecipeAsk[] = [];
  for (const spec of build.inputs) {
    if (own.has(spec.name) || spec.options.length < 2) continue;
    const named = spec.options.find((o) => envNameOf(o) === env);
    if (named !== undefined) fixed[spec.name] = named;
    else {
      asks.push({
        key: `input:${spec.name}`,
        question: `${build.base} needs ${spec.name}${spec.description === undefined ? "" : ` (${spec.description})`} for ${env}. Which one?`,
        options: spec.options.slice(0, 8),
      });
    }
  }
  return { fixed, asks };
}

function lineOfTarget(flow: Flow, target: string | undefined): number | undefined {
  const at = flow.file.located;
  return (
    (target === undefined ? undefined : at.lineOf(["on", "workflow_dispatch", "inputs", target])) ??
    at.lineOf(["on", "workflow_dispatch"]) ??
    at.lineOf(["on"])
  );
}

/**
 * How close a release workflow's name is to "deploy" or "release": 0 when its file or its name is just that, 1 when one of
 * its words is, 2 for any other. Where several workflows could deploy a target, the closest one is the deploy.
 */
function closeness(flow: Flow): number {
  const stem = flow.base.endsWith(".yml")
    ? flow.base.slice(0, -4)
    : flow.base.endsWith(".yaml")
      ? flow.base.slice(0, -5)
      : flow.base;
  const name = text(rec(flow.file.located.data).name)?.trim().toLowerCase() ?? "";
  if ([stem.toLowerCase(), name].some((n) => n === "deploy" || n === "release")) return 0;
  return wordsIn(flow.label).some((w) => w === "deploy" || w === "release") ? 1 : 2;
}

/**
 * The environments the project's GitHub workflows deploy. A workflow counts only when its own words say it deploys and
 * none says it does another job (`flowOf`). One that takes a target counts for each target; one that takes none counts
 * only when it is the project's one release (it deploys the project, not a part of it). Where several workflows deploy
 * a target, the closest in name to deploy or release is the one; two equally close stay, both, and the environment
 * asks which one deploys it.
 */
function githubEnvironments(input: DiscoverInput, notes: string[]): DeployEnvironment[] {
  const flows = input.files.workflows.map(flowOf);
  const releases = flows.filter((f) => f.kind === "release" && f.dispatch);
  const found: { env: DeployEnvironment; rank: number }[] = [];
  for (const release of releases) {
    if (rolesOf(release).target === undefined && releases.length > 1) {
      notes.push(
        `${release.file.path}: one of ${releases.length} workflows that deploy, with no target to say what it deploys: left alone`,
      );
      continue;
    }
    for (const env of releaseEnvironments(release, flows, input, notes))
      found.push({ env, rank: closeness(release) });
  }
  return found
    .filter((f) => f.rank === Math.min(...found.filter((o) => o.env.env === f.env.env).map((o) => o.rank)))
    .map((f) => f.env);
}

function releaseEnvironments(
  release: Flow,
  flows: readonly Flow[],
  input: DiscoverInput,
  notes: string[],
): DeployEnvironment[] {
  const rollback = flows.find((f) => f.kind === "rollback" && f.dispatch);
  const builds = flows.filter((f) => f.kind === "build");
  const build =
    builds.find((f) => f.dispatch && rolesOf(f).versions.length > 0) ??
    builds.find((f) => f.dispatch) ??
    builds[0];
  const roles = rolesOf(release);
  const pick = build === undefined ? undefined : pickOf(build, input.remote);
  const running = build === undefined ? undefined : imageOf(build);
  // A build that takes its version as an input names its tag by that, not by the commit.
  const tag = build === undefined || pick !== undefined ? undefined : buildTag(build);
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
      const chosen = chosenInputs(build, env);
      const built = dispatchStep(build, input.remote, chosen.fixed, "deploy", pick?.input);
      deploy.push(built.step);
      asks.push(...chosen.asks, ...built.asks);
    } else if (build !== undefined && roles.versions.length > 0 && tag !== undefined) {
      notes.push(`${build.file.path} runs on push, so ${release.file.path} deploys what it already built`);
    }
    const released = dispatchStep(release, input.remote, fixed, "deploy");
    deploy.push(released.step);
    asks.push(...released.asks);
    if (roles.versions.length > 0 && tag === undefined && pick === undefined) {
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
    const history = historyOf(release, roles, input.remote, option);
    const recipe: DeployRecipe = {
      from: { file: release.file.path, ...optionalLine(lineOfTarget(release, roles.target)) },
      deploy: deploy as DeployRecipe["deploy"],
      rollback: { runs: [back.step], at: "deployed" },
      ...(tag === undefined ? {} : { build: tag }),
      ...(live === undefined ? {} : { live }),
      ...(history === undefined ? {} : { history }),
      ...(pick === undefined ? {} : { pick }),
      ...(running === undefined ? {} : { running }),
      ...(components === undefined || components === "asks" ? {} : { components }),
      asks: dedupeAsks(asks),
      answers: {},
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
  return componentsFrom(rolesOf(release).components, folders);
}

/**
 * The same for any input with options. `versionless` names the options that deploy no image (a front end): they are
 * kept on the recipe, so no version is built or sent for them.
 */
function componentsFrom(
  spec: InputSpec | undefined,
  folders: readonly string[],
  versionless: readonly string[] = [],
): NonNullable<DeployRecipe["components"]> | "asks" | undefined {
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
  if (parts.length === 0) return "asks";
  const none = parts.filter((p) => versionless.includes(p.option.toLowerCase())).map((p) => p.option);
  return { all, parts, ...(none.length === 0 ? {} : { versionless: none }) };
}

/** The names a part of a project goes by in a folder name: `backend` is `shop-backend`, `frontend` is `store-fe`. */
const PART_ALIASES: Record<string, readonly string[]> = {
  backend: ["backend", "back", "be", "api", "server"],
  frontend: ["frontend", "front", "fe", "web", "ui", "client", "spa"],
};

/**
 * The folder of a part: the folder named like it, else the one folder whose own name has the part among its words (or
 * one of the names the part goes by). Two folders that could be it are none: majhi does not choose.
 */
function folderOf(option: string, folders: readonly string[]): string | undefined {
  const name = option.toLowerCase();
  if (folders.includes(name)) return name;
  for (const parent of PARENT_FOLDERS) if (folders.includes(`${parent}/${name}`)) return `${parent}/${name}`;
  const names = PART_ALIASES[name] ?? [name];
  const under = folders.filter((f) => PARENT_FOLDERS.some((p) => f.startsWith(`${p}/`)) || !f.includes("/"));
  const named = under.filter((f) => {
    const own = wordsIn(f.split("/").at(-1) ?? f);
    return own.some((w) => names.includes(w));
  });
  return named.length === 1 ? named[0] : undefined;
}

/** How the release's run titles name this environment, when they do: the target input is in the title. */
function historyOf(
  release: Flow,
  roles: Roles,
  remote: string,
  option: string | undefined,
): DeployRecipe["history"] {
  const parts = release.runName;
  if (parts === undefined || roles.target === undefined || option === undefined) return undefined;
  if (!parts.some((p) => p.kind === "input" && p.name === roles.target)) return undefined;
  return { remote, workflow: release.base, parts, match: { [roles.target]: option } };
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

/** The variable names a job may declare, by what each one is for. */
const TARGET_VAR = "TARGET";
const VERSION_VARS = ["VERSION", "IMAGE_VERSION", "IMAGE_TAG"];
const COMPONENT_VARS = ["COMPONENTS", "COMPONENT"];
const REGISTRY_VARS = ["REGISTRY_TARGET", "REGISTRY"];
/** The variables whose value names an arm of a script's `case`: the target, the registry. */
const ARM_VARS = [TARGET_VAR, ...REGISTRY_VARS];
/** A manual job with one of these in its name reads a target's status: it is not a place to deploy. */
const STATUS_WORDS = ["status", "health", "smoke"];
/** `environment: action:` values of a job that does not deploy. */
const NOT_A_DEPLOY = ["stop", "verify", "access", "prepare"];
/** Options of a components input that deploy no image: no version goes with them. */
const VERSIONLESS_WORDS = ["frontend", "front", "web", "ui", "client", "static", "site"];
/** A setting whose name holds one of these is the image a build makes. */
const IMAGE_KEYS = ["IMAGE", "REPOSITORY"];
/** A setting with one of these names is the registry an image goes to. */
const REGISTRY_PREFIX_KEYS = ["registry", "registry_url", "registry_host"];
/** Folders that hold how a project deploys, not a part of it: a change to them is not a change to a part. */
const NOT_A_PART = ["deploy", "ci", "docs", "scripts", "tools", "docker", "infra", "ops", "config"];

interface GlJob {
  name: string;
  entry: JobEntry;
  /** The job with the jobs it extends merged in. */
  data: Record<string, unknown>;
  vars: Map<string, JobVariable>;
}

/** A manual job that builds the image of one registry. */
interface GlBuild {
  job: GlJob;
  /** The name of its version variable. */
  version: string;
  registry: string | undefined;
  /** The settings its script reads for its own registry: where the image goes. */
  settings: ReadonlyMap<string, string>;
}

const valuesOf = (vars: ReadonlyMap<string, JobVariable>): Map<string, string> =>
  new Map([...vars].map(([name, v]) => [name, v.value]));

/** The first variable of the job that is one of `names`. */
function firstVar(
  vars: ReadonlyMap<string, JobVariable>,
  names: readonly string[],
): { name: string; spec: JobVariable } | undefined {
  for (const name of names) {
    const spec = vars.get(name);
    if (spec !== undefined) return { name, spec };
  }
  return undefined;
}

function environmentOf(job: GlJob): { name: string } | undefined {
  const environment = job.data.environment;
  const raw = typeof environment === "string" ? environment : text(rec(environment).name);
  if (raw === undefined || NOT_A_DEPLOY.includes(text(rec(environment).action) ?? "")) return undefined;
  const name = expandVariables(raw, valuesOf(job.vars));
  return name.includes("$") ? undefined : { name };
}

/** What a job's script reads and sets: the lines it runs, the files it runs and sources, and their settings for the job's target. */
interface Reading {
  settings: Map<string, string>;
  lines: string[];
  /** The text of each script file and each file it sources. */
  texts: string[];
}

/** The directory of a path: `deploy/ci/a.sh` is `deploy/ci`. */
const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

/** The variables of a script that hold its own directory: `here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`. */
function ownDirectoryVars(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0 || !line.includes("dirname") || !line.includes("BASH_SOURCE")) continue;
    const name = line.slice(0, eq);
    if (
      [...name].every(
        (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_",
      )
    ) {
      out.push(name);
    }
  }
  return out;
}

async function readingOf(job: GlJob, input: DiscoverInput): Promise<Reading> {
  const out: Reading = { settings: new Map(), lines: scriptLines(job.data), texts: [] };
  const read = input.read;
  if (read === undefined) return out;
  const values = valuesOf(job.vars);
  const names = new Set(ARM_VARS.flatMap((n) => ((values.get(n) ?? "") === "" ? [] : [values.get(n) ?? ""])));
  const paths = sourcedPaths(out.lines, values);
  const own: string[] = [];
  for (const script of scriptFiles(out.lines)) {
    const body = await read(script);
    if (body === undefined) continue;
    out.texts.push(body);
    own.push(body);
    const inside = body.split("\n").map((l) => l.trim());
    out.lines.push(...inside);
    // `. "$here/lib.sh"` is a file beside the script.
    const withDir = new Map(values);
    for (const name of ownDirectoryVars(inside)) withDir.set(name, dirOf(script));
    paths.push(...sourcedPaths(inside, withDir));
  }
  for (const path of [...new Set(paths)]) {
    if (path.startsWith("/") || path.split("/").includes("..")) continue;
    const body = await read(path);
    if (body === undefined) continue;
    out.texts.push(body);
    own.push(body);
  }
  // A script says what it sets for one target in the arms of a `case`; only the arms of this job's target count.
  for (const body of own) for (const [key, value] of settingsFor(body, names)) out.settings.set(key, value);
  return out;
}

/** The image a build makes: the first setting or variable named for an image that holds a plain value. */
function imageValue(...sources: ReadonlyMap<string, string>[]): string | undefined {
  for (const source of sources) {
    for (const [key, value] of source) {
      if (value === "" || value.includes("$")) continue;
      if (
        includesWord(
          key.toLowerCase(),
          IMAGE_KEYS.map((k) => k.toLowerCase()),
        )
      )
        return value;
    }
  }
  return undefined;
}

const imageOfValue = (value: string | undefined): DeployRecipe["running"] =>
  value === undefined
    ? undefined
    : value.includes("/")
      ? { repo: value, whole: true }
      : { repo: value, whole: false };

/** Where a build puts its image: the registry its script sets for its own target. */
function registryPrefix(settings: ReadonlyMap<string, string>): string | undefined {
  for (const [key, value] of settings) {
    if (REGISTRY_PREFIX_KEYS.includes(key.toLowerCase()) && value !== "" && !value.includes("$"))
      return value;
  }
  return undefined;
}

/** The words of a variable's description that are options of a components input: an all-word or a folder of the repo. */
function optionsFromDescription(description: string | undefined, folders: readonly string[]): string[] {
  const out: string[] = [];
  for (const word of wordsIn(description ?? "")) {
    if (!out.includes(word) && (ALL_WORDS.includes(word) || folderOf(word, folders) !== undefined))
      out.push(word);
  }
  return out;
}

/** What a job's confirmation variables must be told so its own check passes: each gets the value of the variable it confirms. */
function confirmations(
  job: GlJob,
  lines: readonly string[],
): { values: Record<string, string>; unpaired: string[] } {
  const declared = new Set(job.vars.keys());
  const isConfirm = (name: string) => name.startsWith("CONFIRM");
  const pairs: [string, string][] = confirmationsRead(lines, declared, isConfirm);
  for (const name of declared) {
    const rest = name.startsWith("CONFIRM_") ? name.slice("CONFIRM_".length) : "";
    if (rest !== "" && declared.has(rest)) pairs.push([name, rest]);
  }
  const values: Record<string, string> = {};
  for (const [confirm, other] of pairs) {
    const value = job.vars.get(other)?.value;
    if (value !== undefined && value !== "") values[confirm] = value;
  }
  // A confirmation the job asks for and nothing says what it must equal cannot be filled: the deploy would be refused.
  return { values, unpaired: [...declared].filter((n) => isConfirm(n) && values[n] === undefined) };
}

/**
 * Why majhi cannot play a deploy job by itself, or undefined when it can: it asks for a confirmation that nothing says
 * the value of, or it needs a manual job (an artifact build of its own) played first. Such a job is a place the project
 * deploys, so it stays an environment, but it has no recipe: the captain never deploys it.
 */
function blockedBy(
  job: GlJob,
  entries: ReadonlyMap<string, JobEntry>,
  builds: readonly GlBuild[],
  confirm: { unpaired: string[] },
): string | undefined {
  if (confirm.unpaired.length > 0) {
    return `${job.name} asks for ${confirm.unpaired.join(", ")} and nothing says what it must equal`;
  }
  const needs = Array.isArray(job.data.needs) ? job.data.needs : [];
  for (const need of needs) {
    const name = typeof need === "string" ? need : text(rec(need).job);
    if (name === undefined || rec(need).optional === true || builds.some((b) => b.job.name === name))
      continue;
    if (entries.has(name) && isManual(resolveJob(name, entries))) {
      return `${job.name} needs ${name} played first, which majhi does not do`;
    }
  }
  return undefined;
}

/**
 * The folders a job deploys from, read from what it and the manual jobs it needs run (`cd apps/voice-service`), cache
 * and publish: the part of the project it is, when its variables do not say.
 */
function scopeOfJob(
  job: GlJob,
  entries: ReadonlyMap<string, JobEntry>,
  reading: Reading,
  folders: readonly string[],
): string[] {
  const words: string[] = [];
  const take = (data: Record<string, unknown>, lines: readonly string[]) => {
    for (const line of lines) for (const command of commandsOf(line)) words.push(...command);
    const files = rec(rec(data.cache).key).files;
    for (const item of Array.isArray(files) ? files : []) if (typeof item === "string") words.push(item);
    const paths = rec(data.artifacts).paths;
    for (const item of Array.isArray(paths) ? paths : []) if (typeof item === "string") words.push(item);
  };
  take(job.data, reading.lines);
  const needs = Array.isArray(job.data.needs) ? job.data.needs : [];
  for (const need of needs) {
    const name = typeof need === "string" ? need : text(rec(need).job);
    const data = name === undefined || !entries.has(name) ? undefined : resolveJob(name, entries);
    if (data !== undefined) take(data, scriptLines(data));
  }
  return foldersTouched(words, folders, NOT_A_PART);
}

/**
 * The recipe of a manual job that deploys with variables: a target, the parts, a version, a confirmation. The build
 * that makes the image of its registry goes first; a status job of the target goes last. Every question it cannot
 * answer is an `asks` entry.
 */
async function variablesRecipe(
  job: GlJob,
  jobs: {
    builds: readonly GlBuild[];
    statuses: ReadonlyMap<string, string>;
    entries: ReadonlyMap<string, JobEntry>;
  },
  input: DiscoverInput,
  notes: string[],
): Promise<{ env: string; recipe: DeployRecipe | undefined } | undefined> {
  const environment = environmentOf(job);
  const target = job.vars.get(TARGET_VAR)?.value;
  const envName = target !== undefined && target !== "" ? target : environment?.name;
  if (envName === undefined) return undefined;
  const env = envNameOf(envName);
  if (env === "") return undefined;
  const own = await readingOf(job, input);
  const asks: RecipeAsk[] = [];
  const confirm = confirmations(job, own.lines);
  const blocked = blockedBy(job, jobs.entries, jobs.builds, confirm);
  if (blocked !== undefined) {
    notes.push(`${blocked}: ${env} has no recipe`);
    return { env, recipe: undefined };
  }

  // The image: the build of the registry this target uses. The YAML says the registry, else the target's settings do,
  // else the image the target pulls says it (it starts with the registry the build pushes to).
  const versionVar = firstVar(job.vars, VERSION_VARS)?.name;
  const registryVar = firstVar(job.vars, REGISTRY_VARS);
  let registry = registryVar?.spec.value === "" ? undefined : registryVar?.spec.value;
  if (registry === undefined) {
    for (const key of REGISTRY_VARS) {
      const set = own.settings.get(key);
      if (set !== undefined && set !== "") {
        registry = set;
        break;
      }
    }
  }
  let build: GlBuild | undefined;
  let builds: DeployRunStep[] | undefined;
  let pick: DeployRecipe["pick"];
  if (versionVar !== undefined) {
    const candidates = jobs.builds;
    if (registry === undefined) {
      const image = imageValue(own.settings);
      const byImage =
        image === undefined
          ? []
          : candidates.filter((b) => {
              const prefix = registryPrefix(b.settings);
              return prefix !== undefined && image.startsWith(`${prefix}/`);
            });
      build = byImage.length === 1 ? byImage[0] : candidates.length === 1 ? candidates[0] : undefined;
    } else {
      build = candidates.find((b) => b.registry === registry);
    }
    if (build !== undefined) {
      pick = { input: build.version, ...(build.registry === undefined ? {} : { registry: build.registry }) };
    } else if (registry === undefined && candidates.length > 1) {
      builds = candidates.map((b) => buildStep(b, input.remote));
      pick = { input: versionVar };
      asks.push({
        key: "registry",
        question: `Which registry does ${env} use? majhi builds the image with the job of that registry first.`,
        options: candidates.map((b) => b.job.name).slice(0, 8),
      });
    } else {
      notes.push(`${job.name}: no build job makes the image of ${registry ?? "its registry"}`);
      asks.push({
        key: "input:build-version",
        question: `Which version should ${job.name} deploy for ${env}? majhi found no job that builds it.`,
        options: [],
      });
    }
  }

  // The parts of the project this job deploys: its options, as GitLab's typed variable says them, else the values its
  // script accepts for it, else the words of its description.
  const componentsVar = firstVar(job.vars, COMPONENT_VARS);
  let components: DeployRecipe["components"];
  if (componentsVar !== undefined) {
    const accepted = optionsAccepted(own.texts, componentsVar.name);
    const options =
      componentsVar.spec.options.length > 0
        ? componentsVar.spec.options
        : accepted.length > 0
          ? accepted
          : optionsFromDescription(componentsVar.spec.description, input.folders);
    const spec: InputSpec = {
      name: componentsVar.name,
      options,
      required: false,
      hasDefault: componentsVar.spec.value !== "",
      description: componentsVar.spec.description,
    };
    const found = componentsFrom(spec, input.folders, VERSIONLESS_WORDS);
    if (found === "asks") {
      asks.push({
        key: "components",
        question: `Which part of ${env} does this change deploy?`,
        options: options.slice(0, 8),
      });
    } else components = found;
  }

  const variables: Record<string, string> = {
    ...(target === undefined || target === "" ? {} : { [TARGET_VAR]: target }),
    ...confirm.values,
  };
  const bindDeploy: Record<string, InputBinding> = {
    ...(componentsVar === undefined ? {} : { [componentsVar.name]: "components" }),
    ...(versionVar === undefined ? {} : { [versionVar]: "built-version" }),
  };
  const bindBack: Record<string, InputBinding> = {
    ...(componentsVar === undefined ? {} : { [componentsVar.name]: "components" }),
    ...(versionVar === undefined ? {} : { [versionVar]: "previous-version" }),
  };
  const play = (bind: Record<string, InputBinding>): DeployRunStep => ({
    kind: "gitlab-job",
    remote: input.remote,
    job: job.name,
    ...(Object.keys(variables).length === 0 ? {} : { variables }),
    ...(Object.keys(bind).length === 0 ? {} : { bind }),
  });
  const statusJob = target === undefined ? undefined : jobs.statuses.get(target);
  const status: DeployRunStep[] =
    statusJob === undefined
      ? []
      : [
          {
            kind: "gitlab-job",
            remote: input.remote,
            job: statusJob,
            variables: { [TARGET_VAR]: target ?? "" },
          },
        ];

  // The image the containers of this target run, read from the host before a deploy replaces it: the target's own
  // setting first, else what its build makes.
  const running = imageOfValue(
    imageValue(own.settings, ...(build === undefined ? [] : [valuesOf(build.job.vars), build.settings])),
  );
  // The folders it deploys from, when its parts do not say.
  const scope = components === undefined ? scopeOfJob(job, jobs.entries, own, input.folders) : undefined;

  const line = job.entry.file.located.lineOf([job.name]);
  const recipe: DeployRecipe = {
    from: { file: job.entry.file.path, ...optionalLine(line) },
    deploy: [
      ...(build === undefined ? [] : [buildStep(build, input.remote)]),
      play(bindDeploy),
      ...status,
    ] as DeployRecipe["deploy"],
    // The same job again with the version before, in a pipeline of its own: the one the commit has ran it already.
    rollback: {
      runs: [{ ...play(bindBack), fresh: true }, ...status] as DeployRecipe["deploy"],
      at: "deployed",
    },
    live: { kind: "gitlab-environment", remote: input.remote, name: environment?.name ?? envName },
    ...(pick === undefined ? {} : { pick }),
    ...(running === undefined ? {} : { running }),
    ...(components === undefined ? {} : { components }),
    ...(scope === undefined || scope.length === 0 ? {} : { scope }),
    ...(builds === undefined ? {} : { builds }),
    asks,
    answers: {},
  };
  return { env, recipe };
}

/** The run that builds the image of a registry: it picks the version, so the deploy that follows has one to send. */
function buildStep(build: GlBuild, remote: string): DeployRunStep {
  return { kind: "gitlab-job", remote, job: build.job.name, bind: { [build.version]: "next-version" } };
}

async function gitlabEnvironments(input: DiscoverInput, notes: string[]): Promise<DeployEnvironment[]> {
  const entries = jobEntries(input.files.gitlab as GitlabFile[]);
  const jobs: GlJob[] = [];
  for (const [name, entry] of entries) {
    if (name.startsWith(".")) continue;
    const data = resolveJob(name, entries);
    if (data.script === undefined && data.trigger === undefined) continue;
    jobs.push({ name, entry, data, vars: jobVariables(data) });
  }

  // The jobs that are not a place to deploy: the builds of the registries and the status of each target.
  const statuses = new Map<string, string>();
  const builds: GlBuild[] = [];
  const support = new Set<string>();
  for (const job of jobs) {
    if (!isManual(job.data)) continue;
    const target = job.vars.get(TARGET_VAR)?.value;
    if (includesWord(job.name, STATUS_WORDS) && target !== undefined && target !== "") {
      statuses.set(target, job.name);
      support.add(job.name);
      continue;
    }
    const version = firstVar(job.vars, VERSION_VARS)?.name;
    const registry = firstVar(job.vars, REGISTRY_VARS)?.spec.value;
    if (
      job.data.environment === undefined &&
      version !== undefined &&
      (registry !== undefined || includesWord(job.name, BUILD_WORDS))
    ) {
      builds.push({
        job,
        version,
        registry: registry === "" ? undefined : registry,
        settings: (await readingOf(job, input)).settings,
      });
      support.add(job.name);
    }
  }

  const out: DeployEnvironment[] = [];
  for (const job of jobs) {
    if (support.has(job.name)) continue;
    const environment = environmentOf(job);
    if (environment === undefined) continue;
    const envName = environment.name;
    const env = envNameOf(envName);
    if (env === "") continue;
    const line = job.entry.file.located.lineOf([job.name]);
    const from = { file: job.entry.file.path, ...optionalLine(line) };
    const live: LiveSource = { kind: "gitlab-environment", remote: input.remote, name: envName };
    if (isManual(job.data)) {
      const withVariables = [TARGET_VAR, ...VERSION_VARS, ...COMPONENT_VARS].some((n) => job.vars.has(n));
      if (withVariables) {
        const made = await variablesRecipe(job, { builds, statuses, entries }, input, notes);
        if (made !== undefined) {
          out.push({
            env: made.env,
            tier: tierOf(made.env),
            ...(made.recipe === undefined ? {} : { recipe: made.recipe }),
          });
        }
        continue;
      }
      // A manual job with no variables of the kinds above: played as it is, unless it asks for something majhi cannot give.
      const reading = await readingOf(job, input);
      const blocked = blockedBy(job, entries, builds, confirmations(job, reading.lines));
      if (blocked !== undefined) {
        notes.push(`${blocked}: ${env} has no recipe`);
        out.push({ env, tier: tierOf(env) });
        continue;
      }
      const runs: DeployRunStep[] = [{ kind: "gitlab-job", remote: input.remote, job: job.name }];
      const scope = scopeOfJob(job, entries, reading, input.folders);
      out.push({
        env,
        tier: tierOf(env),
        recipe: {
          from,
          deploy: runs as DeployRecipe["deploy"],
          rollback: { runs: runs as DeployRecipe["deploy"], at: "previous" },
          live,
          ...(scope.length === 0 ? {} : { scope }),
          asks: [],
          answers: {},
        },
      });
      continue;
    }
    const [branch] = jobBranches(job.data);
    if (branch === undefined) continue;
    const runs: DeployRunStep[] =
      branch === input.base
        ? [{ kind: "gitlab-pipeline", remote: input.remote, ref: "base" }]
        : [{ kind: "gitlab-merge", remote: input.remote, branch }];
    out.push({
      env,
      tier: tierOf(env),
      ...(branch === input.base ? {} : { branch }),
      recipe: { from, deploy: runs as DeployRecipe["deploy"], live, asks: [], answers: {} },
    });
  }
  return out;
}

/** The environments the project's CI deploys, each with its recipe. Two files that equally deploy one environment are both listed. */
export async function discoverEnvironments(input: DiscoverInput): Promise<Discovered> {
  const notes: string[] = [];
  const found: DeployEnvironment[] = [];
  if (input.provider === "github") found.push(...githubEnvironments(input, notes));
  else if (input.provider === "gitlab") found.push(...(await gitlabEnvironments(input, notes)));
  const seen = new Set<string>();
  const environments = found.filter((e) => {
    const key = `${e.env}\0${e.recipe?.from.file ?? ""}`;
    return !seen.has(key) && seen.add(key);
  });
  return { environments, notes };
}
