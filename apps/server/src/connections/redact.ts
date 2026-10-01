/** A secret value a run holds, by `<connection>.<field>`. */
export interface HeldSecret {
  name: string;
  value: string;
}

/** Shorter values would match ordinary text. */
const MIN_LENGTH = 4;

/**
 * Replaces each of the run's secret values with `[secret <connection>.<field>]` (SPEC 5.14), longest
 * first so a value that holds another is replaced whole.
 */
export function redactSecrets(text: string, secrets: readonly HeldSecret[]): string {
  if (secrets.length === 0 || text === "") return text;
  let out = text;
  for (const { name, value } of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (value.length >= MIN_LENGTH && out.includes(value)) out = out.split(value).join(`[secret ${name}]`);
  }
  return out;
}

/** The same JSON value with `clean` applied to every string in it. */
export function redactDeep<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, clean)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, clean)])) as T;
  }
  return value;
}
