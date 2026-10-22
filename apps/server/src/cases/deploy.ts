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
import type { DeployHint } from "../deploy/service.ts";
import { goesBackBy } from "../deploy/service.ts";
import { bindRuns, bindsOf, componentsFor, recipeSource } from "../deploy/recipe.ts";
import { UserError } from "../errors.ts";
import { shortVersion } from "./record.ts";

/**
 * The captain's deploy of a case's fix (docs/briefs/instructions.md, docs/briefs/deploy-from-ci.md). Nothing here is a
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
  /** What an environment runs now: majhi's own last deploy, else what the host says. Absent where neither knows. */
  current(project: string, env: string): Promise<DeployReplaces | undefined>;
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
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Time between looks at the deploy, and the longest the captain's call waits for it. */
  pollMs: number;
  waitMs: number;
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
      /** What majhi decided and where it read the path from: lines for the case room. */
      notes: string[];
    }
  | { ok: false; why: string; ask?: DeployQuestion[] };

const NO_PATH = (project: string): string =>
  `${project} has no deploy majhi can repeat: its CI files show no deploy it can start, and no environment of it went live through a run the captain may start and put back. Ask the owner once with case_ask how to deploy it.`;

/** The lowercase letters and digits of a text, as words. */
function wordsOf(text: string): Set<string> {
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
  ): Promise<{ ok: true; candidate: Candidate; read: string[] } | { ok: false; why: string; ask?: DeployQuestion[] }> {
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
      ask: [{ id: "env", question: `Which environment is the fix for: ${names.join(", ")}?`, options: names }],
    };
  }

  /**
   * Whether the branch may be deployed at all: the project has a deploy path majhi knows, and the hand-off checks of
   * the case's head passed. Nothing moves before both hold. A recipe from the CI is filled with what the case knows
   * (the commit when it starts, the parts the change touches, the version the environment runs now); what it cannot
   * fill with certainty comes back as the questions of one card.
   */
  async prepare(input: PrepareInput): Promise<DeployPath> {
    const chosen = await this.path(input.project, input);
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
    const answers = input.answers ?? {};
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

    // What the project cannot say by itself: inputs with no value, and a version the build does not name by the commit.
    const filled: Record<string, string> = {};
    for (const ask of recipe.asks) {
      if (ask.key === "components") continue;
      const said = answers[ask.key];
      if (said === undefined) asks.push({ id: ask.key, ...pick(ask) });
      else filled[ask.key] = said;
    }

    // The version the environment runs now, read before anything moves: where a rollback goes.
    let replaces = await this.ports.current(input.project, env.env).catch(() => undefined);
    const owner = answers["previous-version"];
    const ownerCommit = answers["previous-commit"];
    if (owner !== undefined || ownerCommit !== undefined) {
      replaces = {
        ...replaces,
        ...(owner === undefined ? {} : { version: owner }),
        ...(ownerCommit === undefined ? {} : { commit: ownerCommit }),
        from: "owner",
      };
    }
    const lack = goesBackBy(recipe, replaces);
    if (lack !== undefined) {
      if (replaces?.version === undefined && bindsOf(recipe.rollback?.runs ?? [], "previous-version").length > 0) {
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

    const filledInputs = recipe.deploy.map((step) => {
      if (step.kind !== "github-workflow") return step;
      const inputs = { ...step.inputs };
      for (const [key, value] of Object.entries(filled)) {
        if (key.startsWith("input:") && key !== "input:build-version") inputs[key.slice("input:".length)] = value;
      }
      return Object.keys(inputs).length === 0 ? step : { ...step, inputs };
    });
    const bound = bindRuns(filledInputs, {
      components,
      built: filled["input:build-version"],
    });
    const previous = replaces?.version ?? replaces?.commit ?? "";
    notes.push(`${env.env} runs ${shortVersion(previous === "" ? "an unknown version" : previous)} now.`);
    return {
      ok: true,
      env,
      runs: bound.runs,
      previous: previous.slice(0, 64),
      ...(replaces === undefined ? {} : { replaces }),
      notes,
    };
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
    while (deployIsActive(record.state)) {
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
