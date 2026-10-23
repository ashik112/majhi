import {
  type DeployEnvironment,
  type DeployRecipe,
  type DeployRecord,
  type DeployReplaces,
  type DeployRunStep,
  deployIsActive,
  deployRunLine,
  deployRunStates,
} from "@majhi/shared";
import {
  bindRuns,
  bindsOf,
  componentsFor,
  isBuild,
  isVersionless,
  recipeSource,
  withoutVersion,
  wordsOf,
} from "../deploy/recipe.ts";
import type { DeployHint } from "../deploy/service.ts";
import { goesBackBy } from "../deploy/service.ts";
import { UserError } from "../errors.ts";
import { shortVersion } from "./record.ts";

/**
 * The captain's deploy of a case's fix (docs/briefs/instructions.md, docs/DECISIONS.md, "deploy from CI"). Nothing here is a
 * second way to deploy: the fix lands the way a task's work lands (the merge rule and its hand-off checks), and the
 * deploy is the deploy service's own, with the runs the project's CI says (its environment's recipe) or the runs it
 * already deployed with. What a case adds is how it finds the path, which environment the client is on, what it cannot
 * fill with certainty (one card, once), and that it waits for the answer.
 */

export interface CaseDeployPorts {
  /** The environments of a project. */
  environments(project: string): Promise<readonly DeployEnvironment[]>;
  /** Reads the project's CI files and saves the environments it deploys through. The names added. */
  discover(project: string): Promise<string[]>;
  /** Keeps what the owner answered about an environment's inputs, so its next deploy does not ask again. */
  remember(project: string, env: string, answers: Readonly<Record<string, string>>): Promise<void>;
  /** What an environment runs now: majhi's own last deploy, else what its CI or its host says. Absent where none knows. */
  current(
    project: string,
    env: string,
    opts?: { connection?: string | undefined; version?: string | undefined },
  ): Promise<DeployReplaces | undefined>;
  /** The ssh connections that could be the environment's host (the one the owner named, else by the environment's name). */
  hostChoices(project: string, env: string, connection?: string): Promise<{ id: string }[]>;
  /** The version the build is given when majhi picks it: the next patch after the highest it knows. */
  nextVersion(project: string, env: string): Promise<{ version: string; after: string } | undefined>;
  /** The files the case's branch changed against the project's base; undefined when git cannot say. */
  changedPaths(project: string, branch: string): Promise<string[] | undefined>;
  /** The newest live deploy of an environment, with the runs that made it. */
  latestLive(project: string, env: string): DeployRecord | undefined;
  /** Whether those runs can be put back for an earlier commit. */
  repeatable(runs: readonly DeployRunStep[]): boolean;
  /** Whether the project's remote is on a host the runs reach: the landed commit is pushed before it deploys. */
  onHost(project: string): Promise<boolean>;
  /** The hand-off checks of the case's head, run once per head. Not ok: why. */
  checks(task: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /**
   * Lands the task's branch in its base: the one merge, which refuses a head whose checks did not pass. With `push`
   * the base is pushed after it. Throws a `UserError` with the reason when git or the merge rule refuses.
   */
  land(task: string, project: string, push: boolean): Promise<void>;
  deploy(
    input: { project: string; env: string; runs: DeployRunStep[]; task: string },
    actor: "captain",
    hint?: DeployHint,
  ): Promise<{ record: DeployRecord; repeat: boolean }>;
  rollback(id: number, actor: "captain"): Promise<{ record: DeployRecord; repeat: boolean }>;
  record(id: number): DeployRecord | undefined;
  /** Whether the deploy service is putting the deploy's environment back now. */
  rollingBack(id: number): boolean;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Time between looks at the deploy, and the longest the captain's call waits for it. */
  pollMs: number;
  waitMs: number;
}

/** What a case does around each environment of a deploy: the case's own record of it. */
export interface DeployHooks {
  /** An environment is about to move. */
  started(path: OkPath): void;
  /** Its runs ended, live or not. */
  ended(path: OkPath, record: DeployRecord): Promise<void> | void;
  /** Its deploy threw before it ended. The error goes on to the caller. */
  threw(path: OkPath, err: unknown): void;
}

/** One question of the card a deploy asks: its id is what the captain answers with. `options` empty: a free answer. */
export interface DeployQuestion {
  id: string;
  question: string;
  options: string[];
}

/** The deploy a case may start: the environment, the runs, the version it replaces, and what majhi chose on its own. */
export type DeployPath =
  | {
      ok: true;
      env: DeployEnvironment;
      runs: DeployRunStep[];
      /** The version or commit the environment runs now, as the case keeps it. */
      previous: string;
      replaces?: DeployReplaces;
      /** The owner's answers about the environment's own inputs: kept once the deploy went live. */
      remember?: Record<string, string>;
      /** The registry whose image this deploy builds, when it does: a later target of the registry reuses the image. */
      builds?: string;
      /** What majhi decided and where it read the path from: lines for the case room. */
      notes: string[];
    }
  | { ok: false; why: string; ask?: DeployQuestion[] };

/** A deploy that may start. */
export type OkPath = Extract<DeployPath, { ok: true }>;

const NO_PATH = (project: string): string =>
  `${project} has no deploy majhi can repeat: its CI files show no deploy it can start, and no environment of it went live through a run the captain may start and put back. Ask the owner once with case_ask how to deploy it.`;

interface Candidate {
  env: DeployEnvironment;
  /** The runs of an environment that went live before, when it has no recipe. */
  runs?: DeployRunStep[];
  previous?: string;
}

export interface PrepareInput {
  task: string;
  project: string;
  branch: string;
  /** The environment the captain names. */
  env?: string | undefined;
  /** Answers the owner gave to a deploy card, by question id. */
  answers?: Readonly<Record<string, string>> | undefined;
  /** Words that name the client the case is for (the case's title, symptom and client): an environment named in them is the one. */
  about?: readonly string[] | undefined;
  /** Images an earlier target of this deploy built or is going to build: a target of the same registry does not build it again. */
  reuse?: readonly ReusedImage[] | undefined;
}

/** The image of a registry that an earlier target of the same deploy made, and the version it has once it is built. */
export interface ReusedImage {
  registry: string;
  version?: string | undefined;
}

/**
 * The answers meant for one environment of several: a question of a deploy to several environments has the environment
 * in front of its id (`globex:previous-version`). What has no environment in front applies to every one.
 */
export function answersFor(
  answers: Readonly<Record<string, string>> | undefined,
  env: string,
  all: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers ?? {})) {
    const owner = all.find((name) => key.startsWith(`${name}:`));
    if (owner === undefined) out[key] = value;
    else if (owner === env) out[key.slice(env.length + 1)] = value;
  }
  return out;
}

export class CaseDeployer {
  constructor(private readonly ports: CaseDeployPorts) {}

  /** The environments a case may deploy to: those with a recipe from the CI, and those that went live before. */
  private async candidates(project: string): Promise<Candidate[]> {
    const found: Candidate[] = [];
    for (const env of await this.ports.environments(project)) {
      if (env.recipe !== undefined) {
        found.push({ env });
        continue;
      }
      const live = this.ports.latestLive(project, env.env);
      if (live === undefined || live.runs.length === 0) continue;
      if (live.runs.some((r) => r.kind === "ssh") || !this.ports.repeatable(live.runs)) continue;
      found.push({ env, runs: live.runs, previous: live.commit });
    }
    return found;
  }

  /** The project's own deploy path. When it has no environment, its CI files are read first. */
  async path(
    project: string,
    pick: { env?: string | undefined; about?: readonly string[] | undefined } = {},
  ): Promise<
    { ok: true; candidate: Candidate; read: string[] } | { ok: false; why: string; ask?: DeployQuestion[] }
  > {
    const read: string[] = [];
    let found = await this.candidates(project);
    if (found.length === 0) {
      const added = await this.ports.discover(project).catch(() => []);
      if (added.length > 0) read.push(`Read how ${project} deploys from its CI files: ${added.join(", ")}.`);
      found = await this.candidates(project);
    }
    if (found.length === 0) return { ok: false, why: NO_PATH(project) };
    const production = found.filter((f) => f.env.tier === "production");
    const fit = production.length > 0 ? production : found;
    const named = pick.env === undefined ? undefined : fit.find((f) => f.env.env === pick.env);
    if (pick.env !== undefined && named === undefined) {
      return {
        ok: false,
        why: `${project} has no deploy path to ${pick.env}. Its environments: ${fit.map((f) => f.env.env).join(", ")}.`,
      };
    }
    if (named !== undefined) return { ok: true, candidate: named, read };
    const [only, ...more] = fit;
    if (only === undefined) return { ok: false, why: NO_PATH(project) };
    if (more.length === 0) return { ok: true, candidate: only, read };
    // Several environments: the one the client's own words name, else the owner is asked once which.
    const about = wordsOf((pick.about ?? []).join(" "));
    const matched = fit.filter((f) => about.has(f.env.env));
    const [one] = matched;
    if (matched.length === 1 && one !== undefined) {
      read.push(`${one.env.env} is the environment the case names.`);
      return { ok: true, candidate: one, read };
    }
    const names = fit.map((f) => f.env.env);
    if (names.length > 8) {
      return {
        ok: false,
        why: `${project} deploys to ${names.length} environments and none is named in the case. Name the one the client is on with env.`,
      };
    }
    return {
      ok: false,
      why: `${project} deploys to several environments (${names.join(", ")}) and none is named in the case. The owner is asked which, once.`,
      ask: [
        { id: "env", question: `Which environment is the fix for: ${names.join(", ")}?`, options: names },
      ],
    };
  }

  /**
   * The environments a fix goes to: every production environment the project has that majhi can deploy, the one the
   * case is about first (named by the captain, else the one whose name is a word of the case), then the others in the
   * project's order. Nothing asks which one: the fix goes to all.
   */
  async order(
    project: string,
    pick: { env?: string | undefined; about?: readonly string[] | undefined } = {},
  ): Promise<{ ok: true; envs: string[]; read: string[] } | { ok: false; why: string }> {
    const read: string[] = [];
    let found = await this.candidates(project);
    if (found.length === 0) {
      const added = await this.ports.discover(project).catch(() => []);
      if (added.length > 0) read.push(`Read how ${project} deploys from its CI files: ${added.join(", ")}.`);
      found = await this.candidates(project);
    }
    if (found.length === 0) return { ok: false, why: NO_PATH(project) };
    const production = found.filter((f) => f.env.tier === "production");
    const fit = (production.length > 0 ? production : found).map((f) => f.env.env);
    if (pick.env !== undefined && !fit.includes(pick.env)) {
      return {
        ok: false,
        why: `${project} has no deploy path to ${pick.env}. Its environments: ${fit.join(", ")}.`,
      };
    }
    const about = wordsOf((pick.about ?? []).join(" "));
    const matched = fit.filter((name) => about.has(name));
    const first = pick.env ?? (matched.length === 1 ? matched[0] : undefined);
    if (first !== undefined && fit.length > 1 && pick.env === undefined) {
      read.push(`${first} is the environment the case names: it goes first.`);
    }
    return {
      ok: true,
      envs: first === undefined ? fit : [first, ...fit.filter((name) => name !== first)],
      read,
    };
  }

  /**
   * Every environment the fix goes to, read before anything moves: the same checks and the same questions as one
   * environment, asked together in one card. With several, a question's id has its environment in front of it.
   */
  async plan(
    input: PrepareInput,
  ): Promise<
    { ok: true; envs: string[]; paths: OkPath[] } | { ok: false; why: string; ask?: DeployQuestion[] }
  > {
    const ordered = await this.order(input.project, {
      env: input.env ?? input.answers?.env,
      about: input.about,
    });
    if (!ordered.ok) return ordered;
    const several = ordered.envs.length > 1;
    const asks: DeployQuestion[] = [];
    const paths: OkPath[] = [];
    const reuse: ReusedImage[] = [...(input.reuse ?? [])];
    for (const env of ordered.envs) {
      const path = await this.prepare({
        ...input,
        env,
        answers: answersFor(input.answers, env, ordered.envs),
        reuse: [...reuse],
      });
      if (!path.ok) {
        // A refusal with nothing to ask (the checks did not pass) stops everything; questions are collected.
        if (path.ask === undefined) return { ok: false, why: path.why };
        asks.push(
          ...path.ask.map((q) =>
            several ? { ...q, id: `${env}:${q.id}`, question: `${env}: ${q.question}` } : q,
          ),
        );
        continue;
      }
      paths.push({ ...path, notes: [...(paths.length === 0 ? ordered.read : []), ...path.notes] });
      if (path.builds !== undefined) reuse.push({ registry: path.builds });
    }
    if (asks.length > 0) {
      return {
        ok: false,
        why: `${asks.map((a) => a.id).join(" and ")} must be answered before the fix goes to ${ordered.envs.join(", ")}: majhi does not guess. The owner is asked once.`,
        ask: asks,
      };
    }
    return { ok: true, envs: ordered.envs, paths };
  }

  /**
   * Whether the branch may be deployed at all: the project has a deploy path majhi knows, and the hand-off checks of
   * the case's head passed. Nothing moves before both hold. A recipe from the CI is filled with what the case knows
   * (the commit when it starts, the parts the change touches, the version the environment runs now); what it cannot
   * fill with certainty comes back as the questions of one card.
   */
  async prepare(input: PrepareInput): Promise<DeployPath> {
    const chosen = await this.path(input.project, {
      env: input.env ?? input.answers?.env,
      about: input.about,
    });
    if (!chosen.ok) return chosen;
    const { candidate } = chosen;
    const notes = [...chosen.read];
    const checked = await this.ports.checks(input.task);
    if (!checked.ok) {
      return {
        ok: false,
        why: `The checks of ${input.branch} did not pass: ${checked.why}. A deploy goes only when they do. Wait for the helper's next report, or give it the failure with case_help.`,
      };
    }
    const recipe = candidate.env.recipe;
    if (recipe === undefined) {
      return {
        ok: true,
        env: candidate.env,
        runs: candidate.runs ?? [],
        previous: candidate.previous ?? "",
        notes,
      };
    }
    return this.fromRecipe(input, candidate.env, recipe, notes);
  }

  private async fromRecipe(
    input: PrepareInput,
    env: DeployEnvironment,
    recipe: DeployRecipe,
    notes: string[],
  ): Promise<DeployPath> {
    const answers = { ...recipe.answers, ...input.answers };
    const asks: DeployQuestion[] = [];
    notes.push(`Deploys ${env.env} the way ${recipeSource(env) ?? "the CI"} says.`);

    // The parts of the project the change touches: from the changed files and the project's folders, else the owner says.
    let components: string | undefined;
    if (recipe.components !== undefined) {
      const said = answers.components;
      if (said !== undefined) components = said;
      else {
        const paths = await this.ports.changedPaths(input.project, input.branch);
        const picked = paths === undefined ? undefined : componentsFor(recipe.components, paths);
        if (picked !== undefined) {
          components = picked.option;
          notes.push(`Components: ${picked.option}, because ${picked.why}.`);
        } else {
          components = recipe.components.all;
          notes.push(`Components: ${recipe.components.all}: majhi could not tell which part changed.`);
        }
      }
    } else if (recipe.asks.some((a) => a.key === "components")) {
      const ask = recipe.asks.find((a) => a.key === "components");
      if (answers.components === undefined && ask !== undefined) asks.push({ id: ask.key, ...pick(ask) });
      components = answers.components;
    }

    // A part with no image sends no version and builds nothing.
    const versionless = isVersionless(recipe, components);

    // What the project cannot say by itself: inputs with no value, and a version the build does not name by the commit.
    const filled: Record<string, string> = {};
    for (const ask of recipe.asks) {
      if (ask.key === "components") continue;
      if (ask.key === "input:build-version" && versionless) continue;
      const said = answers[ask.key];
      if (said === undefined) asks.push({ id: ask.key, ...pick(ask) });
      else filled[ask.key] = said;
    }

    // The build of the registry this target uses, when the project's own files could not say which: the owner's pick.
    let runs: DeployRunStep[] = [...recipe.deploy];
    let registry = recipe.pick?.registry;
    const chosen = filled.registry;
    if (recipe.builds !== undefined && chosen !== undefined) {
      const build = recipe.builds.find((b) => b.kind === "gitlab-job" && b.job === chosen);
      if (build === undefined) {
        asks.push({
          id: "registry",
          question: `${chosen} is not one of ${env.env}'s builds. Which job builds its image?`,
          options: recipe.builds.flatMap((b) => (b.kind === "gitlab-job" ? [b.job] : [])),
        });
      } else {
        runs = [build, ...runs];
        registry = chosen;
      }
    }

    // The image of this registry was built by an earlier target of the same deploy: it is used, not built again.
    const reused = registry === undefined ? undefined : input.reuse?.find((r) => r.registry === registry);
    if (reused !== undefined) {
      runs = runs.filter((step) => !isBuild(step));
      notes.push(
        `${env.env} uses the ${registry} image${reused.version === undefined ? " the first target builds" : ` ${reused.version}, built for the first target`}: it is not built again.`,
      );
    }
    if (versionless) {
      runs = withoutVersion(runs);
      notes.push(
        `${env.env}: only ${components} is deployed, which has no image, so no version is built or sent.`,
      );
    }

    // The version the build makes: majhi picks the next patch when the build takes its version as an input.
    const builtAnswer = reused?.version ?? answers["input:build-version"];
    if (recipe.pick !== undefined && reused === undefined && !versionless) {
      if (builtAnswer !== undefined) notes.push(`Build version: ${builtAnswer}, as the owner said.`);
      else {
        const next = await this.ports.nextVersion(input.project, env.env).catch(() => undefined);
        if (next === undefined) {
          asks.push({
            id: "input:build-version",
            question: `Which version should the build make for this fix (X.Y.Z, not built yet)? majhi could not find the versions already built.`,
            options: [],
          });
        } else notes.push(`Build version: ${next.version}, the next patch after ${next.after}.`);
      }
    }

    // The version the environment runs now, read before anything moves: where a rollback goes.
    let replaces = await this.ports
      .current(input.project, env.env, {
        connection: answers.connection,
        version: answers["previous-version"],
      })
      .catch(() => undefined);
    const ownerCommit = answers["previous-commit"];
    if (ownerCommit !== undefined) replaces = { ...replaces, commit: ownerCommit, from: "owner" };
    const lack = goesBackBy(recipe, replaces, components);
    // Several hosts could be this environment's: which one is asked before the version is.
    const hosts =
      lack !== undefined && !versionless && recipe.running !== undefined
        ? await this.ports.hostChoices(input.project, env.env, answers.connection).catch(() => [])
        : [];
    if (lack !== undefined && hosts.length > 1) {
      asks.push({
        id: "connection",
        question: `Which host runs ${env.env}? majhi reads the image its containers use there.`,
        options: hosts.slice(0, 8).map((h) => h.id),
      });
    } else if (lack !== undefined) {
      if (
        !versionless &&
        replaces?.version === undefined &&
        bindsOf(recipe.rollback?.runs ?? [], "previous-version").length > 0
      ) {
        asks.push({
          id: "previous-version",
          question: `Which version does ${env.env} run now? majhi could not read it from the CI, and a rollback needs it.`,
          options: [],
        });
      } else {
        asks.push({
          id: "previous-commit",
          question: `Which commit does ${env.env} run now? A rollback needs it.`,
          options: [],
        });
      }
    }
    if (asks.length > 0) {
      return {
        ok: false,
        why: `${env.env} needs ${asks.map((a) => a.id).join(" and ")} before it can deploy: majhi does not guess. The owner is asked once.`,
        ask: asks,
      };
    }

    // An input of the workflow with no value of its own is the same for every deploy of the environment: kept.
    const remember = Object.fromEntries(
      Object.entries(input.answers ?? {}).filter(
        ([key]) =>
          (key.startsWith("input:") && key !== "input:build-version") ||
          key === "connection" ||
          key === "registry",
      ),
    );
    const filledInputs = runs.map((step) => {
      if (step.kind !== "github-workflow") return step;
      const inputs = { ...step.inputs };
      for (const [key, value] of Object.entries(filled)) {
        if (key.startsWith("input:") && key !== "input:build-version")
          inputs[key.slice("input:".length)] = value;
      }
      return Object.keys(inputs).length === 0 ? step : { ...step, inputs };
    });
    const bound = bindRuns(filledInputs, {
      components,
      built: builtAnswer,
    });
    const previous = replaces?.version ?? replaces?.commit ?? "";
    notes.push(`${env.env} runs ${shortVersion(previous === "" ? "an unknown version" : previous)} now.`);
    return {
      ok: true,
      env,
      runs: bound.runs,
      previous: previous.slice(0, 64),
      ...(replaces === undefined ? {} : { replaces }),
      ...(Object.keys(remember).length === 0 ? {} : { remember }),
      ...(registry !== undefined && reused === undefined && runs.some(isBuild) ? { builds: registry } : {}),
      notes,
    };
  }

  /**
   * The fix, environment after environment: the branch lands before the first one, each later environment is read again
   * right before its own step (what it runs now is recorded just before it goes), and an image a target of the same
   * registry built is not built again. It stops at the first that does not go live: that one was put back by the
   * deploy service, and the ones after it get nothing. An environment that needs an answer stops it too, `blocked`.
   */
  async deployAll(
    input: PrepareInput & { landed: boolean },
    plan: { envs: readonly string[]; paths: readonly OkPath[] },
    hooks: DeployHooks,
  ): Promise<{
    targets: { path: OkPath; record: DeployRecord }[];
    blocked?: { env: string; why: string; ask?: DeployQuestion[] };
  }> {
    const targets: { path: OkPath; record: DeployRecord }[] = [];
    const reuse: ReusedImage[] = [];
    let landed = input.landed;
    for (const [i, first] of plan.paths.entries()) {
      let path = first;
      if (i > 0) {
        const again = await this.prepare({
          ...input,
          env: first.env.env,
          answers: answersFor(input.answers, first.env.env, plan.envs),
          reuse: [...reuse],
        });
        if (!again.ok) {
          return {
            targets,
            blocked: {
              env: first.env.env,
              why: again.why,
              ...(again.ask === undefined ? {} : { ask: again.ask }),
            },
          };
        }
        path = again;
      }
      hooks.started(path);
      let record: DeployRecord;
      try {
        record = await this.run({
          task: input.task,
          project: input.project,
          env: path.env.env,
          runs: path.runs,
          landed,
          replaces: path.replaces,
        });
      } catch (err) {
        hooks.threw(path, err);
        throw err;
      }
      landed = true;
      await hooks.ended(path, record);
      targets.push({ path, record });
      if (record.state !== "live") break;
      if (path.builds !== undefined && record.version !== undefined) {
        reuse.push({ registry: path.builds, version: record.version });
      }
    }
    return { targets };
  }

  /** Keeps the owner's answers about an environment's own inputs. */
  remember(project: string, env: string, answers: Readonly<Record<string, string>>): Promise<void> {
    return this.ports.remember(project, env, answers);
  }

  /**
   * Lands the branch (unless it landed already) and deploys it to the environment with the runs of its path, then
   * waits until the deploy is live or failed. A failed deploy was rolled back by the deploy service itself.
   */
  async run(input: {
    task: string;
    project: string;
    env: string;
    runs: DeployRunStep[];
    landed: boolean;
    replaces?: DeployReplaces | undefined;
  }): Promise<DeployRecord> {
    if (!input.landed)
      await this.ports.land(input.task, input.project, await this.ports.onHost(input.project));
    const started = await this.ports.deploy(
      { project: input.project, env: input.env, runs: input.runs, task: input.task },
      "captain",
      input.replaces === undefined ? {} : { replaces: input.replaces },
    );
    return this.settled(started.record);
  }

  /** The record once it is no longer moving. A deploy still moving after the wait is a failure the captain reads. */
  private async settled(first: DeployRecord): Promise<DeployRecord> {
    const until = this.ports.now().getTime() + this.ports.waitMs;
    let record = first;
    // A deploy that failed is still moving while the deploy service puts the environment back.
    while (deployIsActive(record.state) || this.ports.rollingBack(first.id)) {
      if (this.ports.now().getTime() >= until) {
        throw new UserError(
          `The deploy is still going after ${Math.round(this.ports.waitMs / 60_000)} minutes. majhi keeps following it; read the project's deploys before you go on.`,
          409,
        );
      }
      await this.ports.sleep(this.ports.pollMs);
      record = this.ports.record(first.id) ?? record;
    }
    return record;
  }

  /** Puts the version the deploy replaced back, through the same runs. */
  async rollback(record: number): Promise<DeployRecord> {
    return (await this.ports.rollback(record, "captain")).record;
  }
}

const pick = (ask: { question: string; options: string[] }): { question: string; options: string[] } => ({
  question: ask.question,
  options: ask.options,
});

/** Each run of a deploy in a line for the case room: what it was, its link and how it ended. */
export function runLines(record: DeployRecord): string[] {
  const states = deployRunStates(record);
  return record.runs.map((run, i) => {
    const url = record.handles[i]?.url;
    const state = states[i] ?? "waiting";
    const sent = record.handles[i]?.inputs;
    const inputs =
      sent === undefined
        ? ""
        : ` (${Object.entries(sent)
            .map(([k, v]) => `${k}=${shortVersion(v)}`)
            .join(", ")})`;
    return `${deployRunLine(run)}${inputs}: ${state === "done" ? "done" : state === "failed" ? "failed" : state}${url === undefined ? "" : ` ${url}`}`;
  });
}
