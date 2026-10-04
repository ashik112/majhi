/**
 * Lockfile readers. Each takes the text of one lockfile and answers the packages it pins, as OSV names
 * them (`ecosystem`, `name`, `version`). They are forgiving: a line or an entry that does not fit is
 * skipped, never thrown on, and a file that is not the format answers nothing. Nothing here runs a
 * package manager or reads outside the text it is given.
 */

export interface Pkg {
  ecosystem: "npm" | "crates.io" | "Go" | "PyPI" | "RubyGems" | "Packagist";
  name: string;
  version: string;
  /** Only known to be a development dependency when the format says so. */
  dev?: boolean;
}

/** A file bigger than this is not read: a lockfile of a very large monorepo is a few MB. */
export const MAX_LOCKFILE_BYTES = 25_000_000;

export const LOCKFILE_NAMES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
] as const;

/** Whether a tracked path is a lockfile this sensor reads (`requirements*.txt` included). */
export function isLockfile(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return (
    (LOCKFILE_NAMES as readonly string[]).includes(name) || /^requirements([._-][\w.-]*)?\.txt$/.test(name)
  );
}

const SEMVERISH = /^v?\d[\w.+~-]*$/;

function clean(version: string): string | undefined {
  const v = version.trim();
  return SEMVERISH.test(v) && v.length <= 80 ? v : undefined;
}

function push(out: Pkg[], p: Pkg): void {
  const version = clean(p.version);
  if (version === undefined || p.name === "" || p.name.length > 214) return;
  out.push({ ...p, version: version.replace(/^v/, "") });
}

/** The packages of a lockfile, by its file name. Duplicates are removed. */
export function parseLockfile(path: string, text: string): Pkg[] {
  const name = path.split("/").at(-1) ?? "";
  let out: Pkg[] = [];
  try {
    if (name === "pnpm-lock.yaml") out = pnpm(text);
    else if (name === "package-lock.json") out = npmLock(text);
    else if (name === "yarn.lock") out = yarn(text);
    else if (name === "bun.lock") out = bun(text);
    else if (name === "Cargo.lock") out = tomlPackages(text, "crates.io", true);
    else if (name === "poetry.lock") out = tomlPackages(text, "PyPI", false);
    else if (name === "go.sum") out = goSum(text);
    else if (name === "Gemfile.lock") out = gemfile(text);
    else if (name === "composer.lock") out = composer(text);
    else if (/^requirements/.test(name)) out = requirements(text);
  } catch {
    return [];
  }
  return unique(out);
}

function unique(list: Pkg[]): Pkg[] {
  const seen = new Map<string, Pkg>();
  for (const p of list) {
    const key = `${p.ecosystem}\u0000${p.name}\u0000${p.version}`;
    const known = seen.get(key);
    // Used by anything that ships: not dev.
    if (known === undefined) seen.set(key, p);
    else if (known.dev === true && p.dev !== true) seen.set(key, { ...known, dev: false });
  }
  return [...seen.values()];
}

function splitNameVersion(spec: string): { name: string; version: string } | undefined {
  // `@scope/name@1.2.3(peer@x)` or `name@1.2.3`.
  const bare = spec
    .replace(/\(.*$/, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/^\//, "");
  const at = bare.lastIndexOf("@");
  if (at > 0) return { name: bare.slice(0, at), version: bare.slice(at + 1) };
  // pnpm v5: `/name/1.2.3` or `/@scope/name/1.2.3`.
  const slash = bare.lastIndexOf("/");
  if (slash > 0) return { name: bare.slice(0, slash), version: bare.slice(slash + 1).replace(/_.*$/, "") };
  return undefined;
}

function pnpm(text: string): Pkg[] {
  const out: Pkg[] = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}(\S.*?):\s*(\{.*)?$/.exec(line);
    if (m?.[1] === undefined) continue;
    const nv = splitNameVersion(m[1]);
    if (nv !== undefined) push(out, { ecosystem: "npm", ...nv });
  }
  return out;
}

interface NpmLock {
  packages?: Record<string, { version?: string; dev?: boolean; name?: string; link?: boolean } | undefined>;
  dependencies?: Record<string, NpmV1 | undefined>;
}
interface NpmV1 {
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, NpmV1 | undefined>;
}

function npmLock(text: string): Pkg[] {
  const json = JSON.parse(text) as NpmLock;
  const out: Pkg[] = [];
  if (json.packages !== undefined && typeof json.packages === "object") {
    for (const [key, p] of Object.entries(json.packages)) {
      if (key === "" || p === undefined || p === null || p.link === true || typeof p.version !== "string")
        continue;
      const at = key.lastIndexOf("node_modules/");
      if (at === -1) continue;
      push(out, {
        ecosystem: "npm",
        name: p.name ?? key.slice(at + "node_modules/".length),
        version: p.version,
        dev: p.dev === true,
      });
    }
    return out;
  }
  const walk = (deps: Record<string, NpmV1 | undefined> | undefined, depth: number): void => {
    if (deps === undefined || typeof deps !== "object" || depth > 40) return;
    for (const [name, d] of Object.entries(deps)) {
      if (d === undefined || d === null || typeof d !== "object") continue;
      if (typeof d.version === "string")
        push(out, { ecosystem: "npm", name, version: d.version, dev: d.dev === true });
      walk(d.dependencies, depth + 1);
    }
  };
  walk(json.dependencies, 0);
  return out;
}

function yarn(text: string): Pkg[] {
  const out: Pkg[] = [];
  let names: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\S/.test(line) && !line.startsWith("#")) {
      // `"@scope/a@^1", "@scope/a@^1.2":` or `a@npm:^1:`. The first name stands for the block.
      const first = line.replace(/:\s*$/, "").split(",")[0]?.trim().replace(/^"|"$/g, "") ?? "";
      const at = first.indexOf("@", 1);
      names = at > 0 && !first.includes("@workspace:") ? [first.slice(0, at)] : [];
      continue;
    }
    const v = /^ {2}version:? "?([^"\s]+)"?\s*$/.exec(line);
    if (v?.[1] !== undefined && names[0] !== undefined) {
      // Berry workspace entries (`workspace:`) and patches are not registry versions.
      push(out, { ecosystem: "npm", name: names[0], version: v[1] });
    }
  }
  return out;
}

function bun(text: string): Pkg[] {
  const out: Pkg[] = [];
  // `"name": ["name@1.2.3", "", { ... }, "sha512-..."]` in the packages section.
  for (const m of text.matchAll(/^\s*"[^"\n]+":\s*\[\s*"((?:@[^/"\s]+\/)?[^@"\s]+)@([^"\s]+)"/gm)) {
    if (m[1] !== undefined && m[2] !== undefined && !m[2].includes(":")) {
      push(out, { ecosystem: "npm", name: m[1], version: m[2] });
    }
  }
  return out;
}

/** `[[package]]` tables with name and version. Cargo's local crates have no `source` and are skipped. */
function tomlPackages(text: string, ecosystem: "crates.io" | "PyPI", needSource: boolean): Pkg[] {
  const out: Pkg[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const end = block.search(/^\[(?!\[package\])/m);
    const body = end === -1 ? block : block.slice(0, end);
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (name === undefined || version === undefined) continue;
    if (needSource && !/^source\s*=/m.test(body)) continue;
    push(out, { ecosystem, name, version });
  }
  return out;
}

function goSum(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const line of text.split("\n")) {
    const [mod, version, hash] = line.trim().split(/\s+/);
    if (mod === undefined || version === undefined || hash === undefined) continue;
    if (version.endsWith("/go.mod")) continue;
    push(out, { ecosystem: "Go", name: mod, version: version.replace(/\+incompatible$/, "") });
  }
  return out;
}

function gemfile(text: string): Pkg[] {
  const out: Pkg[] = [];
  let inSpecs = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inSpecs = false;
      continue;
    }
    if (/^ {2}specs:\s*$/.test(line)) {
      inSpecs = true;
      continue;
    }
    if (!inSpecs) continue;
    const m = /^ {4}(\S+) \(([^)\s]+)\)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined)
      push(out, { ecosystem: "RubyGems", name: m[1], version: m[2] });
  }
  return out;
}

interface Composer {
  packages?: { name?: string; version?: string }[];
  "packages-dev"?: { name?: string; version?: string }[];
}

function composer(text: string): Pkg[] {
  const json = JSON.parse(text) as Composer;
  const out: Pkg[] = [];
  for (const [list, dev] of [
    [json.packages, false],
    [json["packages-dev"], true],
  ] as const) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p?.name === "string" && typeof p.version === "string") {
        push(out, { ecosystem: "Packagist", name: p.name, version: p.version, dev });
      }
    }
  }
  return out;
}

/** Only exact pins (`name==1.2.3`) are known versions; a range says nothing about what is installed. */
function requirements(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s#.*$/, "").trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([0-9][\w.+!-]*)/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined)
      push(out, { ecosystem: "PyPI", name: m[1].toLowerCase(), version: m[2] });
  }
  return out;
}

/** Splits a version into its numbers, for comparing majors. Undefined when it has no leading number. */
export function majorOf(version: string): number | undefined {
  const m = /^v?(\d+)/.exec(version.trim());
  return m?.[1] === undefined ? undefined : Number(m[1]);
}
