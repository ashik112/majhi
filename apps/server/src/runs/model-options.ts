import {
  type EffortTier,
  findPrice,
  type ModelTier,
  normalizeModel,
  type OptionValue,
  type Price,
  type PricesConfig,
  type Role,
} from "@majhi/shared";

/**
 * The models and efforts an ACP session offers, made fit for a question (PRV-51). Nothing here
 * knows a model name, a version or a provider: families come from the shape of the ids, and
 * ranks come from the price table.
 */

/** One model on offer, after merging: the newest member of its family. */
export interface OfferedModel {
  id: string;
  /** The id without version numbers, date suffixes, context suffix and provider prefix. */
  family: string;
  /** Numbers in the id, in order: `claude-opus-5-5` is [5, 5]. Empty for an alias like `opus`. */
  version: number[];
  /** The CLI's own description. Used only when the model has no price to rank by. */
  description?: string;
}

/** What may end a model id without being part of the version: a date (`-20260101` or `-2026-01-01`), `-latest`, or a pin (`@...`). */
const SNAPSHOT = /(-\d{4}-\d{2}-\d{2}|-\d{6,8}|-latest|@.+)$/;
const VERSION_TOKEN = /^\d+(\.\d+)*$/;

/** The CLI's sentinel for "whatever you pick": not a model name. */
const SENTINEL = "default";

interface Parsed {
  family: string;
  tokens: string[];
  version: number[];
}

function parse(id: string): Parsed {
  const tokens = normalizeModel(id).replace(SNAPSHOT, "").split("-").filter(Boolean);
  const words = tokens.filter((t) => !VERSION_TOKEN.test(t));
  const version = tokens.filter((t) => VERSION_TOKEN.test(t)).flatMap((t) => t.split(".").map(Number));
  return { family: words.join("-"), tokens: words, version };
}

/** Negative when `a` is older than `b`: [5, 5] is newer than [5], which is newer than [4, 8]. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Groups the offered models into families and keeps the newest of each.
 * - `claude-opus-5-5`, `claude-opus-5` and `claude-opus-4-8-20260101` are family `claude-opus`;
 *   `gpt-5.5-codex` and `gpt-5.3-codex` are family `gpt-codex`.
 * - On equal versions the shorter id wins, so a plain id beats a dated snapshot or a `[1m]` variant.
 * - An alias without a version (`sonnet`, `opus[1m]`) is dropped when a versioned model of its
 *   family is offered, and kept when nothing versioned matches it.
 * - `default` is dropped when anything else is offered.
 * The order of the CLI's list is kept.
 */
export function normalizeOffered(options: readonly OptionValue[]): OfferedModel[] {
  const real = options.filter((o) => o.id !== SENTINEL);
  const entries = (real.length === 0 ? options : real).map((o) => ({ option: o, ...parse(o.id) }));

  const best = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const held = best.get(e.family);
    const d = held === undefined ? 1 : compareVersions(e.version, held.version);
    if (d > 0 || (d === 0 && held !== undefined && e.option.id.length < held.option.id.length)) {
      best.set(e.family, e);
    }
  }

  const versioned = [...best.values()].filter((e) => e.version.length > 0);
  const covered = (alias: { tokens: string[] }) =>
    alias.tokens.length > 0 && versioned.some((v) => alias.tokens.every((t) => v.tokens.includes(t)));
  const kept = new Set(
    [...best.values()].filter((e) => e.version.length > 0 || !covered(e)).map((e) => e.option),
  );
  return entries
    .filter((e) => kept.has(e.option))
    .map((e) => ({
      id: e.option.id,
      family: e.family,
      version: e.version,
      ...(e.option.description?.trim() ? { description: e.option.description.trim() } : {}),
    }));
}

/** One option of a question: the id the session takes, and the text Laya reads. */
export interface PickOption {
  id: string;
  label: string;
  /** Set when the price table ranks the model against the others: "balanced". Not the CLI's text. */
  rank?: string;
}

const CHEAPEST = "cheapest and fastest";
const BALANCED = "balanced";
const DEAREST = "most capable";

/** Dearest last: output price, then input price. */
function byPrice(a: Price, b: Price): number {
  return a.output - b.output || a.input - b.input;
}

/** Who ranks the models when the price table cannot: the decision provider's two answers. */
export interface RankHint {
  /** The id it named as the most capable. */
  capable?: string | undefined;
  /** The id it named as the cheapest and fastest. */
  cheapest?: string | undefined;
}

/** The models from cheapest to dearest, and what to call each. */
export interface ModelRank {
  /** Cheapest first. */
  order: string[];
  /** True when the order is a guess (a model has no price), not the price table's. */
  estimated: boolean;
  /** "cheapest and fastest", "balanced" or "most capable", where there is more than one model to compare. */
  labels: Map<string, string>;
}

/** True when a price is missing, so the order can only be estimated. */
export function needsEstimate(models: readonly OfferedModel[], owner: PricesConfig = {}): boolean {
  return models.some((m) => findPrice(m.id, owner) === undefined);
}

/**
 * Ranks the models. When every one has a price (`findPrice`: the owner's rows over the defaults), by
 * output price, then input price: the cheapest is "cheapest and fastest", the dearest is "most
 * capable", the rest "balanced", and equal prices share a label. When any has none, the ranking is an
 * estimate from the CLI's order and the provider's answers (`hint`), whatever their confidence:
 * - The CLI lists most capable first, unless the model named most capable comes after the one named
 *   cheapest. With fewer answers, most capable first is assumed.
 * - The model named most capable goes first and the one named cheapest goes last.
 */
export function rankModels(
  models: readonly OfferedModel[],
  owner: PricesConfig = {},
  hint: RankHint = {},
): ModelRank {
  const ids = models.map((m) => m.id);
  if (!needsEstimate(models, owner)) {
    const priced = models
      .flatMap((m) => {
        const price = findPrice(m.id, owner)?.price;
        return price === undefined ? [] : [{ id: m.id, price }];
      })
      .sort((a, b) => byPrice(a.price, b.price));
    const labels = new Map<string, string>();
    const lo = priced[0]?.price;
    const hi = priced.at(-1)?.price;
    if (priced.length >= 2 && lo !== undefined && hi !== undefined) {
      for (const { id, price } of priced) {
        labels.set(
          id,
          byPrice(lo, hi) === 0
            ? BALANCED
            : byPrice(price, lo) === 0
              ? CHEAPEST
              : byPrice(price, hi) === 0
                ? DEAREST
                : BALANCED,
        );
      }
    }
    return { order: priced.map((p) => p.id), estimated: false, labels };
  }

  const at = (id: string | undefined) => (id === undefined ? -1 : ids.indexOf(id));
  const [c, h] = [at(hint.capable), at(hint.cheapest)];
  const capableFirst = c === -1 || h === -1 || c === h || c < h;
  const dearestFirst = capableFirst ? [...ids] : [...ids].reverse();
  if (c !== -1) dearestFirst.splice(0, 0, ...dearestFirst.splice(dearestFirst.indexOf(ids[c] ?? ""), 1));
  if (h !== -1 && h !== c) dearestFirst.push(...dearestFirst.splice(dearestFirst.indexOf(ids[h] ?? ""), 1));
  const labels = new Map<string, string>();
  if (dearestFirst.length >= 2) {
    for (const [i, id] of dearestFirst.entries()) {
      labels.set(id, i === 0 ? DEAREST : i === dearestFirst.length - 1 ? CHEAPEST : BALANCED);
    }
  }
  return { order: dearestFirst.reverse(), estimated: true, labels };
}

/**
 * The options of the model question. Ranked by price they read `id: most capable`; when the ranking
 * is only an estimate, or the models are unpriced, they read `id: <the CLI's description>`, because
 * the estimate comes from the same call.
 */
export function labelModels(models: readonly OfferedModel[], owner: PricesConfig = {}): PickOption[] {
  const rank = rankModels(models, owner);
  const seen = new Set<string>();
  return models.map((m) => {
    const label = rank.estimated ? undefined : rank.labels.get(m.id);
    return option(m.id, label ?? (rank.estimated ? m.description : undefined), seen, label);
  });
}

/** The options of the two ranking questions: `id: <the CLI's description>`. */
export function plainOptions(models: readonly OfferedModel[]): PickOption[] {
  const seen = new Set<string>();
  return models.map((m) => option(m.id, m.description, seen));
}

/** The efforts on offer, without `default` (not an effort), in the CLI's order. */
export function effortOptions(options: readonly OptionValue[]): PickOption[] {
  const seen = new Set<string>();
  return options.filter((o) => o.id !== SENTINEL).map((o) => option(o.id, o.description?.trim(), seen));
}

/** `id: note`, at most 200 characters, and unique in the list (the bare id when it would repeat). */
function option(id: string, note: string | undefined, seen: Set<string>, rank?: string): PickOption {
  const text = note ? `${id}: ${note}` : id;
  let label = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  if (seen.has(label)) label = id;
  seen.add(label);
  return { id, label, ...(rank === undefined ? {} : { rank }) };
}

/** How a role reads in the question. */
export function rolePhrase(role: Role): string {
  switch (role) {
    case "Lead":
      return "a Lead who plans and reviews the work";
    case "Builder":
      return "a Builder who writes the code";
    case "Reviewer":
      return "a Reviewer who checks the work of others";
    case "Tester":
      return "a Tester who runs and checks the results";
    case "Root":
      return "a Root agent who organizes projects and tasks";
  }
}

export function modelQuestion(role: Role): string {
  return `Which model fits ${rolePhrase(role)}? Use a small, fast model for simple work and a large one for hard, open-ended work.`;
}

export const CAPABLE_QUESTION = "Which of these models is the most capable?";
export const CHEAPEST_QUESTION = "Which of these models is the cheapest and fastest?";

export function effortQuestion(role: Role): string {
  return `How much reasoning effort does ${rolePhrase(role)} need for this task?`;
}

/**
 * The model a tier stands for, by rank: cheapest is the cheapest, most capable the dearest, balanced
 * the one in the middle (the cheaper of two). The rank is estimated when a model has no price.
 */
export function modelForTier(
  models: readonly OfferedModel[],
  tier: ModelTier,
  owner: PricesConfig = {},
  hint: RankHint = {},
): string | undefined {
  const { order } = rankModels(models, owner, hint);
  if (order.length === 0) return undefined;
  const index =
    tier === "cheapest" ? 0 : tier === "most-capable" ? order.length - 1 : Math.floor((order.length - 1) / 2);
  return order[index];
}

/**
 * The effort a tier stands for, by position in the list the adapter offers, lowest first: lowest is
 * the first, highest the last, middle the upper of two in the middle. `default` is not an effort.
 */
export function effortForTier(efforts: readonly OptionValue[], tier: EffortTier): string | undefined {
  const list = effortOptions(efforts);
  if (list.length === 0) return undefined;
  const index =
    tier === "lowest" ? 0 : tier === "highest" ? list.length - 1 : Math.ceil((list.length - 1) / 2);
  return list[index]?.id;
}
