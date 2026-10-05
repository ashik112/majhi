/**
 * Finds secrets in free text, so they can be saved and replaced by a reference before any
 * agent or the room database sees them (SPEC 5.16). Pure: the server and the web composer
 * share it. It favors few false alarms: hashes, uuids, paths and plain words pass.
 */

export type SecretKind =
  | "anthropic"
  | "openai"
  | "github"
  | "gitlab"
  | "slack"
  | "aws"
  | "private-key"
  | "jwt"
  | "assigned"
  | "token";

export interface SecretMatch {
  kind: SecretKind;
  /** Offsets into the scanned text: `text.slice(start, end)` is the secret. */
  start: number;
  end: number;
  value: string;
}

/** Patterns with a known shape. Order matters: the first to claim a range wins. */
const KNOWN: { kind: SecretKind; pattern: RegExp; group?: number }[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "gitlab", pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { kind: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    kind: "assigned",
    pattern:
      /\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?([^\s"',;]{12,})/gi,
    group: 1,
  },
  {
    // A quoted literal can be short: `password = "hunter2xyz9"`.
    kind: "assigned",
    pattern:
      /\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']([^\s"',;]{8,})["']/gi,
    group: 1,
  },
];

const GENERIC = /[A-Za-z0-9+_=-]{32,}/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
const REFERENCE = /^secret:/;

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** How many of lower case, upper case, digits and symbols the text uses. */
function classes(text: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[+_=-]/].filter((re) => re.test(text)).length;
}

/**
 * A bare name in code: `COUNTER_LOG_FIELD`, `max_retries`, `settings.API_TOKEN`. Each dotted part is
 * all upper case or all lower case, with words split by `_`, and each word is letters with at most
 * three trailing digits (`v2`, `int64`) or only digits. A random blob mixes digits in the middle of
 * its letters, so it never passes.
 */
export function isCodeIdentifier(value: string): boolean {
  return value.split(".").every((part) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) return false;
    if (/[a-z]/.test(part) && /[A-Z]/.test(part)) return false;
    return part.split("_").every((word) => /^(?:[A-Za-z]+[0-9]{0,3}|[0-9]+)?$/.test(word));
  });
}

function looksRandom(token: string, minEntropy: number, minClasses: number): boolean {
  if (REFERENCE.test(token)) return false;
  const bare = token.replaceAll("-", "");
  // Hashes, commit ids and uuids are hex.
  if (HEX_ONLY.test(bare) || /^[0-9]+$/.test(bare)) return false;
  return entropy(token) >= minEntropy && classes(token) >= minClasses;
}

function overlaps(taken: readonly SecretMatch[], start: number, end: number): boolean {
  return taken.some((m) => start < m.end && end > m.start);
}

/** Every secret in the text, in order of position, without overlaps. */
export function detectSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { kind, pattern, group } of KNOWN) {
    for (const m of text.matchAll(pattern)) {
      const value = group === undefined ? m[0] : (m[group] ?? "");
      if (value === "" || REFERENCE.test(value)) continue;
      const start = (m.index ?? 0) + (group === undefined ? 0 : m[0].lastIndexOf(value));
      const end = start + value.length;
      if (kind === "assigned" && (/^secret:\S/i.test(m[0]) || isCodeIdentifier(value))) continue;
      // A hash-length hex value is a secret only when a keyword such as `api_key` points at it.
      const hexBlob = HEX_ONLY.test(value) && value.length >= 32;
      if (kind === "assigned" && !hexBlob && !looksRandom(value, 3, 2)) continue;
      if (!overlaps(found, start, end)) found.push({ kind, start, end, value });
    }
  }
  for (const m of text.matchAll(GENERIC)) {
    const value = m[0];
    const start = m.index ?? 0;
    const end = start + value.length;
    // A path or URL segment: the token sits next to a slash or dot.
    const before = text[start - 1];
    const after = text[end];
    if (before === "/" || before === "." || after === "/" || after === ".") continue;
    // `field_name=SOME_CONSTANT`: the `=` is in the pattern, so judge each part of an assignment.
    if (value.split("=").every((part) => part === "" || isCodeIdentifier(part))) continue;
    if (!looksRandom(value, 4.2, 3)) continue;
    if (!overlaps(found, start, end)) found.push({ kind: "token", start, end, value });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The text with each match replaced by `replace(match)`. Matches must come from `detectSecrets`. */
export function replaceSecrets(
  text: string,
  matches: readonly SecretMatch[],
  replace: (match: SecretMatch) => string,
): string {
  let out = "";
  let at = 0;
  for (const m of matches) {
    out += text.slice(at, m.start) + replace(m);
    at = m.end;
  }
  return out + text.slice(at);
}

const KIND_NAMES: Partial<Record<SecretKind, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  github: "github",
  gitlab: "gitlab",
  slack: "slack",
  aws: "aws",
  "private-key": "private-key",
  jwt: "jwt",
};

/** A lowercase id from a label: "New Relic (Acme)" gives `new-relic-acme`. Empty when nothing is left. */
export function slugName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

/**
 * The name for a new secret: from the label, else from the kind (`anthropic`), else `secret-1`,
 * `secret-2`. A name that is taken gets `-2`, `-3` and so on.
 */
export function deriveSecretName(input: {
  label?: string | undefined;
  kind?: SecretKind | undefined;
  taken: ReadonlySet<string>;
}): string {
  const fromLabel = input.label === undefined ? "" : slugName(input.label);
  const fromKind = input.kind === undefined ? undefined : KIND_NAMES[input.kind];
  const base = fromLabel !== "" ? fromLabel : fromKind;
  if (base === undefined) {
    for (let n = 1; ; n++) if (!input.taken.has(`secret-${n}`)) return `secret-${n}`;
  }
  if (!input.taken.has(base)) return base;
  for (let n = 2; ; n++) if (!input.taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Guess the kind of a single pasted value, for `secrets.save` without a name. */
export function kindOfSecret(value: string): SecretKind | undefined {
  return detectSecrets(value.trim()).find((m) => m.start === 0)?.kind;
}
