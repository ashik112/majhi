import { detectSecrets, type SecretKind, type SecretMatch } from "@majhi/shared";
import { git } from "../git/git.ts";

/**
 * The secret scan of a branch before it ships. It reads what the branch adds over `from`, one file
 * at a time, so a big diff is scanned in full instead of refused. Lockfiles, generated files and
 * binaries are left out by pattern. Only a diff that is truly huge, or a single file git cannot hand
 * over, stops the scan, and the reason names the biggest files.
 */

/** Added lines past which a diff is too big to scan, after lockfiles and generated files are left out. */
export const MAX_SCANNED_LINES = 3_000_000;
/** Files past which a diff is too big to scan. */
export const MAX_SCANNED_FILES = 5_000;
const PARALLEL = 6;
const FILE_TIMEOUT_MS = 60_000;

const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|flake\.lock|pubspec\.lock|Podfile\.lock|mix\.lock|gradle\.lockfile)$|\.lock$/;
const GENERATED =
  /(^|\/)(node_modules|dist|build|\.next|coverage|__generated__)\/|\.min\.(js|css)$|\.map$|\.snap$|\.generated\.|\.pb\.go$|_pb2\.pyi?$/;
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|wasm|mp[34]|mov|webm|ogg|wav|so|dylib|dll|exe|class|pyc)$/i;

/** Whether a file is left out of the scan: a lockfile, generated output or a binary. */
export function skippedByPattern(path: string): boolean {
  return LOCKFILE.test(path) || GENERATED.test(path) || BINARY.test(path);
}

export type SecretScan =
  | { kind: "clean"; files: number; skipped: number }
  | { kind: "secret"; hit: SecretHit }
  | { kind: "too-large"; why: string };

/** Where the scan found a secret, and which rule. The value itself never leaves `maskSecret`. */
export interface SecretHit {
  path: string;
  /** The line in the new version of the file, from 1. */
  line: number;
  /** The rule that matched: `github`, `private-key`, `assigned` (a password-like assignment), `token`... */
  rule: SecretKind;
  /** The value, masked: what is safe to show. */
  masked: string;
  /** More secrets in the same file after this one. */
  more: number;
}

interface Stat {
  path: string;
  added: number;
  binary: boolean;
}

/** `git diff --numstat -z`: `added TAB deleted TAB path NUL`, with `-` for a binary file. */
export function parseNumstat(raw: string): Stat[] {
  const out: Stat[] = [];
  for (const record of raw.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record.replace(/^\n/, ""));
    if (match === null) continue;
    const [, added = "-", , path = ""] = match;
    out.push({ path, added: added === "-" ? 0 : Number(added), binary: added === "-" });
  }
  return out;
}

/** Rules whose value starts with a public prefix (`ghp_`, `sk-ant-`), which says what it is and gives nothing away. */
const PREFIXED: Partial<Record<SecretKind, number>> = {
  anthropic: 7,
  github: 4,
  gitlab: 6,
  slack: 5,
  aws: 4,
};

/** A value for the room: its public prefix when the rule has one, and its length. Never the rest. */
export function maskSecret(match: Pick<SecretMatch, "kind" | "value">): string {
  const keep = PREFIXED[match.kind] ?? 0;
  return `${match.value.slice(0, keep)}[hidden, ${match.value.length} chars]`;
}

/** The lines a patch adds, with their numbers in the new file. `-U0` hunks: `@@ -a,b +c,d @@`. */
export function addedLines(patch: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let next = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) {
      const plus = l.split(" ").find((w) => w.startsWith("+"));
      next = Number((plus ?? "+1").slice(1).split(",")[0]);
      continue;
    }
    if (l.startsWith("+++")) continue;
    if (l.startsWith("+")) {
      out.push({ line: next, text: l.slice(1) });
      next++;
    }
  }
  return out;
}

/** The first secret in a file's added lines, with where it is. Undefined when there is none. */
export function findSecret(path: string, patch: string): SecretHit | undefined {
  const added = addedLines(patch);
  const found = detectSecrets(added.map((a) => a.text).join("\n"));
  const first = found[0];
  if (first === undefined) return undefined;
  let offset = 0;
  let line = added[0]?.line ?? 1;
  for (const a of added) {
    if (first.start < offset + a.text.length + 1) {
      line = a.line;
      break;
    }
    offset += a.text.length + 1;
  }
  return { path, line, rule: first.kind, masked: maskSecret(first), more: found.length - 1 };
}

/** One line for the room: the file, the line, the rule and the masked value. */
export function describeHit(hit: SecretHit): string {
  const more = hit.more > 0 ? ` and ${hit.more} more in the file` : "";
  return `${hit.path} line ${hit.line}, rule ${hit.rule}, value ${hit.masked}${more}`;
}

/** Scans what `tip` adds over `from` in the repo at `cwd`. */
export async function scanForSecrets(
  cwd: string,
  from: string,
  tip: string,
  ceiling: { files: number; lines: number } = { files: MAX_SCANNED_FILES, lines: MAX_SCANNED_LINES },
): Promise<SecretScan> {
  const args = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-renames", "-U0"];
  const stats = parseNumstat(await git(cwd, [...args, "--numstat", "-z", from, tip]));
  const scannable = stats.filter((s) => !s.binary && s.added > 0 && !skippedByPattern(s.path));
  const lines = scannable.reduce((sum, s) => sum + s.added, 0);
  if (scannable.length > ceiling.files || lines > ceiling.lines) {
    const biggest = scannable
      .toSorted((a, b) => b.added - a.added)
      .slice(0, 3)
      .map((s) => `${s.path} (${s.added} lines)`)
      .join(", ");
    return {
      kind: "too-large",
      why: `${scannable.length} files and ${lines} added lines; the biggest are ${biggest}`,
    };
  }
  for (let i = 0; i < scannable.length; i += PARALLEL) {
    const batch = scannable.slice(i, i + PARALLEL);
    const results = await Promise.all(
      batch.map(async (s): Promise<SecretScan | undefined> => {
        try {
          const patch = await git(cwd, [...args, from, tip, "--", `:(literal)${s.path}`], {
            timeoutMs: FILE_TIMEOUT_MS,
          });
          const hit = findSecret(s.path, patch);
          return hit === undefined ? undefined : { kind: "secret", hit };
        } catch {
          return { kind: "too-large", why: `git could not hand over ${s.path} (${s.added} lines) to read` };
        }
      }),
    );
    // A secret is the more useful answer than a file that could not be read.
    const found = results.find((r) => r?.kind === "secret") ?? results.find((r) => r !== undefined);
    if (found !== undefined) return found;
  }
  return { kind: "clean", files: scannable.length, skipped: stats.length - scannable.length };
}
