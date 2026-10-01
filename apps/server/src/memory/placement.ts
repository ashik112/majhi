import {
  type Answer,
  type DecideRequestInput,
  type DecisionResult,
  GLOBAL_SCOPE,
  type MemoryScope,
  orgScope,
  parseScope,
  projectScope,
} from "@majhi/shared";
import type { Decisions } from "../decisions/api.ts";
import { bulletsOf, parseBrief } from "./brief-doc.ts";

/**
 * Where a fact goes (global, an org or a project), decided per fact. The decision provider (Laya
 * first) answers two small described choices, which suit a small model better than one long list:
 *
 * A. Where does the fact apply: everywhere, this org, or one project (plus "none of these fits").
 * B. Only for "one project" with more than one candidate: which project, among at most eight.
 *
 * How the answer combines with the Housekeeper's own scope is `PLACEMENT_POLICY`, chosen from the
 * labeled set in `eval/scope-eval.json`. Without a usable answer the fact goes to the
 * Housekeeper's scope when it may, else to the narrowest scope the conversation clearly touched.
 */

/** Most projects in step B. Laya gets worse with many options. */
export const MAX_PROJECT_OPTIONS = 8;

export interface PlaceOrg {
  id: string;
  /** How the owner names it. Default: the id. */
  name?: string | undefined;
}

export interface PlaceProject {
  id: string;
  org: string;
  aliases?: readonly string[] | undefined;
  /** One line on what it is, from its brief. */
  about?: string | undefined;
}

/** The registered orgs and projects. */
export interface Registry {
  orgs: readonly PlaceOrg[];
  projects: readonly PlaceProject[];
}

/** The conversation a fact came from. */
export interface PlaceContext {
  task: string;
  agent?: string | undefined;
  /** The org of the task or chat. Undefined for a root (boss) conversation, which may write anywhere. */
  org?: string | undefined;
  /** Projects the conversation worked in, named or read. */
  touched: readonly string[];
  /** Scopes the fact may go to. */
  allowed: readonly MemoryScope[];
}

export interface FactToPlace {
  text: string;
  /** The Housekeeper's scope for it. */
  proposed?: MemoryScope | undefined;
}

/** `decision`: the provider's answer counted. `housekeeper`: its own scope. `touched`: the conversation's. */
export type PlacedBy = "decision" | "housekeeper" | "touched";

export interface Placement {
  scope: MemoryScope;
  by: PlacedBy;
  /** One line for the memory log. */
  reason: string;
}

/**
 * `override`: a counted answer wins over the Housekeeper's scope. `tiebreak`: the Housekeeper's
 * scope wins when it gave an allowed one; a counted answer is used only when it did not.
 * Set from the eval: see docs/DECISIONS.md, 2026-10-01.
 */
export type PlacementPolicy = "override" | "tiebreak";
export const PLACEMENT_POLICY: PlacementPolicy = "tiebreak";

const EVERYWHERE = "everywhere";
const ORG = "org";
const PROJECT = "project";

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the text names `name` as a whole word (a name inside a longer word is not a mention). */
export function names(text: string, name: string): boolean {
  if (name.length < 2) return false;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, "i").test(text);
}

function orgName(registry: Registry, id: string): string {
  return registry.orgs.find((o) => o.id === id)?.name ?? id;
}

function orgOf(registry: Registry, scope: MemoryScope | undefined): string | undefined {
  const parsed = scope === undefined ? undefined : parseScope(scope);
  if (parsed === undefined || parsed.kind === "global") return undefined;
  if (parsed.kind === "org") return parsed.id;
  return registry.projects.find((p) => p.id === parsed.id)?.org;
}

/** The candidates for one fact: the org option, if any, and the projects for step B, best first. */
export interface Candidates {
  org?: string | undefined;
  projects: PlaceProject[];
}

/**
 * The org the fact could belong to: the conversation's; in a root conversation the one org the
 * fact names, else the Housekeeper's, else the one org the touched projects share.
 */
export function candidates(registry: Registry, ctx: PlaceContext, fact: FactToPlace): Candidates {
  const allowed = new Set(ctx.allowed);
  const projects = registry.projects.filter((p) => allowed.has(projectScope(p.id)));
  const named = projects.filter((p) => [p.id, ...(p.aliases ?? [])].some((n) => names(fact.text, n)));
  let org = ctx.org;
  if (org === undefined) {
    const orgsNamed = registry.orgs.filter(
      (o) => names(fact.text, o.id) || (o.name !== undefined && names(fact.text, o.name)),
    );
    const touchedOrgs = new Set(
      projects.filter((p) => ctx.touched.includes(p.id) || named.includes(p)).map((p) => p.org),
    );
    org =
      orgsNamed.length === 1
        ? orgsNamed[0]?.id
        : (orgOf(registry, fact.proposed) ?? (touchedOrgs.size === 1 ? [...touchedOrgs][0] : undefined));
  }
  if (org !== undefined && !allowed.has(orgScope(org))) org = undefined;

  const proposed = parseScope(fact.proposed ?? "");
  const rank = (p: PlaceProject): number => {
    if (named.includes(p)) return 0;
    if (ctx.touched.includes(p.id)) return 1;
    if (proposed?.kind === "project" && proposed.id === p.id) return 2;
    if (org !== undefined && p.org === org) return 3;
    return 4;
  };
  const ranked = projects
    .map((p) => ({ p, r: rank(p) }))
    // In a root conversation with nothing to go on, a project of another org is no candidate.
    .filter(({ r }) => r < 4 || org === undefined)
    .sort((a, b) => a.r - b.r || a.p.id.localeCompare(b.p.id))
    .map(({ p }) => p);
  return { org, projects: ranked.slice(0, MAX_PROJECT_OPTIONS) };
}

/** One line of context for the state: which org and projects the conversation was about. */
export function contextLine(registry: Registry, ctx: PlaceContext): string {
  const touched = ctx.touched.filter((p) => registry.projects.some((x) => x.id === p));
  const where = touched.length === 0 ? "no project in particular" : `the project ${touched.join(", ")}`;
  const org = ctx.org === undefined ? "" : `, in the org ${orgName(registry, ctx.org)}`;
  return `Said while working on ${where}${org}.`;
}

/** Step A: where the fact applies. Options only for what exists; at least two, else undefined. */
export function levelQuestion(
  registry: Registry,
  ctx: PlaceContext,
  fact: FactToPlace,
  c: Candidates,
): DecideRequestInput | undefined {
  const options: { key: string; description: string }[] = [];
  if (ctx.allowed.includes(GLOBAL_SCOPE))
    options.push({
      key: EVERYWHERE,
      description: "a personal habit or style rule, true in any company",
    });
  if (c.org !== undefined)
    options.push({
      key: ORG,
      description: `a rule or fact about the company ${orgName(registry, c.org)}`,
    });
  if (c.projects.length > 0)
    options.push({
      key: PROJECT,
      description: "a technical detail of one app or service",
    });
  if (options.length < 2) return undefined;
  return {
    state: { fact: fact.text, context: contextLine(registry, ctx) },
    questions: {
      level: {
        type: "choice",
        // Worded after the eval (eval/scope-eval.ts): Laya reads "what is it about" better than "where".
        instructions: "What is this fact about?",
        options,
        abstain: true,
        // Laya favours some positions: ask in every order and average, as the other call sites do.
        orders: "shifted",
      },
    },
  };
}

/** Step B: which project, among the candidates, each described in plain words. */
export function projectQuestion(
  registry: Registry,
  ctx: PlaceContext,
  fact: FactToPlace,
  projects: readonly PlaceProject[],
): DecideRequestInput {
  return {
    state: { fact: fact.text, context: contextLine(registry, ctx) },
    questions: {
      project: {
        type: "choice",
        instructions: "Which codebase is this fact about?",
        options: projects.map((p) => ({
          key: p.id,
          description:
            `a codebase of ${orgName(registry, p.org)}${p.about === undefined || p.about === "" ? "" : `: ${p.about}`}`.slice(
              0,
              200,
            ),
        })),
        abstain: true,
        orders: "shifted",
      },
    },
  };
}

/** The answer's value when the gate let it count, else undefined. */
function counted(a: Answer | undefined): string | undefined {
  return a !== undefined && a.gate?.accepted === true ? String(a.value) : undefined;
}

/** Where the fact goes without a model: the Housekeeper's scope when allowed, else what was touched. */
export function placeWithoutModel(registry: Registry, ctx: PlaceContext, fact: FactToPlace): Placement {
  if (fact.proposed !== undefined && ctx.allowed.includes(fact.proposed))
    return { scope: fact.proposed, by: "housekeeper", reason: "the Housekeeper's scope" };
  return { ...touchedScope(registry, ctx), by: "touched" };
}

/** The narrowest scope the conversation clearly touched: its one project, their shared org, its org, or global. */
export function touchedScope(registry: Registry, ctx: PlaceContext): { scope: MemoryScope; reason: string } {
  const allowed = new Set(ctx.allowed);
  const touched = ctx.touched.filter((p) => allowed.has(projectScope(p)));
  const [only] = touched;
  if (touched.length === 1 && only !== undefined)
    return { scope: projectScope(only), reason: `the one project it worked in, ${only}` };
  const orgs = new Set(touched.map((p) => registry.projects.find((x) => x.id === p)?.org));
  const [shared] = [...orgs];
  if (touched.length > 1 && orgs.size === 1 && shared !== undefined && allowed.has(orgScope(shared)))
    return { scope: orgScope(shared), reason: `the org of the projects it worked in, ${shared}` };
  if (ctx.org !== undefined && allowed.has(orgScope(ctx.org)))
    return { scope: orgScope(ctx.org), reason: `its org, ${ctx.org}` };
  return { scope: GLOBAL_SCOPE, reason: "no org or project in particular" };
}

/** What the provider said for one fact: the scope when it counted, and every decision it took. */
export interface ProviderPick {
  scope?: MemoryScope | undefined;
  /** Decisions asked, so the caller can record what was done with them. */
  decisions: DecisionResult[];
  /** Why it did not count, in plain words. */
  why?: string | undefined;
}

export interface PlacerDeps {
  decisions: Pick<Decisions, "decide" | "outcome">;
  registry: () => Promise<Registry>;
  policy?: PlacementPolicy;
}

/** Places facts, one at a time, and records each decision's outcome in the decision log. */
export class Placer {
  constructor(private readonly deps: PlacerDeps) {}

  async place(ctx: PlaceContext, fact: FactToPlace): Promise<Placement> {
    const registry = await this.deps.registry();
    const policy = this.deps.policy ?? PLACEMENT_POLICY;
    const fallback = placeWithoutModel(registry, ctx, fact);
    // The Housekeeper's allowed scope stands under `tiebreak`: no model is asked.
    if (policy === "tiebreak" && fallback.by === "housekeeper") return fallback;
    const pick = await this.ask(registry, ctx, fact);
    const placement: Placement =
      pick.scope !== undefined
        ? {
            scope: pick.scope,
            by: "decision",
            reason: `the decision provider (${pick.decisions.map((d) => d.id).join(", ")})`,
          }
        : { ...fallback, reason: `${fallback.reason}; ${pick.why ?? "no decision"}` };
    const fellBack = placement.by !== "decision";
    for (const d of pick.decisions)
      this.deps.decisions.outcome(d.id, {
        text: `Memory scope ${placement.scope}, from ${fellBack ? placement.reason : "this answer"}.`,
        fellBack,
        choices: ctx.allowed.slice(0, 40),
      });
    return placement;
  }

  /** Steps A and B. Never throws: a provider that fails is a pick that did not count. */
  async ask(registry: Registry, ctx: PlaceContext, fact: FactToPlace): Promise<ProviderPick> {
    const c = candidates(registry, ctx, fact);
    const decisions: DecisionResult[] = [];
    const decide = async (request: DecideRequestInput) => {
      const result = await this.deps.decisions
        .decide(request, {
          use: "memory",
          task: ctx.task,
          ...(ctx.agent === undefined ? {} : { agent: ctx.agent }),
        })
        .catch(() => undefined);
      if (result !== undefined) decisions.push(result);
      return result;
    };
    const level = levelQuestion(registry, ctx, fact, c);
    if (level === undefined) return { decisions, why: "nothing to choose between" };
    const a = await decide(level);
    if (a === undefined) return { decisions, why: "no decision provider answered" };
    const where = counted(a.answers.level);
    if (where === undefined)
      return {
        decisions,
        why: `the provider was not sure (${a.answers.level?.gate?.reason ?? "no answer"})`,
      };
    if (where === EVERYWHERE) return { scope: GLOBAL_SCOPE, decisions };
    if (where === ORG && c.org !== undefined) return { scope: orgScope(c.org), decisions };
    if (where !== PROJECT) return { decisions, why: "the provider gave an unknown answer" };
    const [first] = c.projects;
    if (c.projects.length === 1 && first !== undefined) return { scope: projectScope(first.id), decisions };
    const b = await decide(projectQuestion(registry, ctx, fact, c.projects));
    const which = counted(b?.answers.project);
    if (which !== undefined && c.projects.some((p) => p.id === which))
      return { scope: projectScope(which), decisions };
    // One project, but which one is not clear: the Housekeeper's or the one the fact names, if any.
    const proposed = parseScope(fact.proposed ?? "");
    if (proposed?.kind === "project" && c.projects.some((p) => p.id === proposed.id))
      return { scope: projectScope(proposed.id), decisions };
    return { decisions, why: "the provider was not sure which project" };
  }
}

/** Most projects the Housekeeper's prompt lists, the touched ones first. */
const MAX_PROMPT_PROJECTS = 30;

/** Where facts from the conversation may go, with what each means, for the Housekeeper's prompt. */
export function placeChoices(
  registry: Registry,
  ctx: Pick<PlaceContext, "allowed" | "touched">,
): { scope: MemoryScope; meaning: string }[] {
  const allowed = new Set(ctx.allowed);
  const projects = registry.projects
    .filter((p) => allowed.has(projectScope(p.id)))
    .sort(
      (a, b) =>
        Number(ctx.touched.includes(b.id)) - Number(ctx.touched.includes(a.id)) || a.id.localeCompare(b.id),
    )
    .slice(0, MAX_PROMPT_PROJECTS);
  return [
    ...projects.map((p) => ({
      scope: projectScope(p.id),
      meaning: `only true in the codebase ${p.id} of ${orgName(registry, p.org)}${p.about === undefined || p.about === "" ? "" : ` (${p.about})`}${ctx.touched.includes(p.id) ? ", which this conversation worked in" : ""}`,
    })),
    ...registry.orgs
      .filter((o) => allowed.has(orgScope(o.id)))
      .map((o) => ({
        scope: orgScope(o.id),
        meaning: `true across all of ${o.name ?? o.id}'s work and codebases`,
      })),
    ...(allowed.has(GLOBAL_SCOPE)
      ? [{ scope: GLOBAL_SCOPE, meaning: "true everywhere, for every org: a general habit or preference" }]
      : []),
  ];
}

/** A project's one line: the first bullet of its brief's "What it is", cut short. */
export function briefAbout(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const first = bulletsOf(parseBrief(body)["What it is"])[0]?.replace(/[`*_]/g, "").trim();
  if (first === undefined || first === "") return undefined;
  return first.length > 120 ? `${first.slice(0, 117).trimEnd()}...` : first;
}
