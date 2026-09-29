import { LOCAL_TASK_PREFIX, type OrgConfig } from "@majhi/shared";

const MAX_KEY = 10;

/**
 * The task key prefix of every org: its own `key`, else letters from its name
 * (first letters of the words, or the first three letters of a single word),
 * capitalized. Explicit keys are reserved first; a derived key that is taken
 * gets a digit. Orgs are handled in config order, so adding an org never
 * changes the key of an earlier one.
 */
export function orgKeys(orgs: Readonly<Record<string, OrgConfig>>): Map<string, string> {
  const keys = new Map<string, string>();
  const taken = new Set<string>([LOCAL_TASK_PREFIX]);
  for (const [id, org] of Object.entries(orgs)) {
    if (org.key !== undefined) {
      keys.set(id, org.key);
      taken.add(org.key);
    }
  }
  for (const [id, org] of Object.entries(orgs)) {
    if (keys.has(id)) continue;
    const key = uniqueKey(deriveKey(org.name, id), taken);
    keys.set(id, key);
    taken.add(key);
  }
  return keys;
}

/** `Acme Corp` gives `AC`, `Globex` gives `IDE`, `acme` gives `ACM`. */
export function deriveKey(name: string, fallback: string): string {
  const words = name
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "")
    .filter((w) => /[A-Za-z]/.test(w));
  let key = "";
  if (words.length > 1) key = words.map((w) => w.replace(/^[^A-Za-z]+/, "")[0] ?? "").join("");
  else if (words.length === 1) key = (words[0] ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 3);
  key = key.toUpperCase().slice(0, MAX_KEY);
  if (!/^[A-Z]/.test(key))
    key = fallback
      .replace(/[^A-Za-z]/g, "")
      .toUpperCase()
      .slice(0, 3);
  return /^[A-Z]/.test(key) ? key : "ORG";
}

function uniqueKey(key: string, taken: ReadonlySet<string>): string {
  if (!taken.has(key)) return key;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = `${key.slice(0, MAX_KEY - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
