import { sep } from "node:path";

/**
 * What the config pass knows about each registered project, and how a name, URL or path found in one
 * project's files is traced to another project. Every rule is an exact lookup on typed facts or on word
 * sets: nothing here matches text.
 */

export interface ProjectFacts {
  id: string;
  /** The checkout, absolute. */
  path: string;
  /** `name` in package.json. */
  packageName?: string | undefined;
  /** `project.name` in pyproject.toml, lower case with `-` for `_` and `.`. */
  pythonName?: string | undefined;
  /** Remote URLs as `host/owner/repo` (no scheme, no `.git`). */
  remotes: string[];
  /** Ports the project's Dockerfile or compose file exposes. */
  ports: number[];
  /** Compose service names that build this project: a URL host with that name means this project. */
  services: Set<string>;
  /** Words of the project id. */
  words: Set<string>;
  /** Has something that runs: a Dockerfile, a compose file, a start script, a deploy file. */
  runnable: boolean;
  /** Has a manifest that publishes it for others (`main` or `exports`, or a Python build backend). */
  publishable: boolean;
}

/** Lower-case words of a name: the runs of letters and digits (`acme-api`, `ACME_API_URL`). */
export function wordsOf(name: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of name.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    const alnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (alnum) current += ch;
    else if (current !== "") {
      words.push(current);
      current = "";
    }
  }
  if (current !== "") words.push(current);
  return words;
}

/** Words that say "address" or "framework prefix", not which project. */
const FILLER: ReadonlySet<string> = new Set([
  "url",
  "uri",
  "host",
  "hostname",
  "base",
  "endpoint",
  "service",
  "server",
  "addr",
  "address",
  "port",
  "public",
  "next",
  "vite",
  "react",
  "app",
  "internal",
  "external",
  "origin",
]);

/** One candidate, or the one with the most words when that is unique, else none. */
function pick(candidates: readonly ProjectFacts[]): ProjectFacts | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const most = Math.max(...candidates.map((c) => c.words.size));
  const top = candidates.filter((c) => c.words.size === most);
  return top.length === 1 ? top[0] : undefined;
}

/** `host/owner/repo` of a git remote in URL or scp form, without the scheme, the user and `.git`. */
export function remoteKey(url: string): string | undefined {
  let text = url.trim();
  if (text.startsWith("git+")) text = text.slice(4);
  const hash = text.indexOf("#");
  if (hash >= 0) text = text.slice(0, hash);
  let host: string;
  let path: string;
  if (text.includes("://")) {
    try {
      const u = new URL(text);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return undefined;
    }
  } else {
    // scp form: user@host:owner/repo.git
    const at = text.indexOf("@");
    const colon = text.indexOf(":", at + 1);
    if (colon < 0) return undefined;
    host = text.slice(at + 1, colon);
    path = text.slice(colon + 1);
  }
  let clean = path.startsWith("/") ? path.slice(1) : path;
  if (clean.endsWith(".git")) clean = clean.slice(0, -4);
  if (host === "" || clean === "") return undefined;
  return `${host.toLowerCase()}/${clean}`;
}

export class Resolver {
  constructor(private readonly projects: readonly ProjectFacts[]) {}

  byPackage(name: string): ProjectFacts | undefined {
    return this.projects.find((p) => p.packageName === name);
  }

  byPython(name: string): ProjectFacts | undefined {
    return this.projects.find((p) => p.pythonName === name);
  }

  byRemote(url: string): ProjectFacts | undefined {
    const key = remoteKey(url);
    return key === undefined ? undefined : this.projects.find((p) => p.remotes.includes(key));
  }

  /** The project whose checkout is exactly this folder (or the one that holds it). */
  byPath(abs: string): ProjectFacts | undefined {
    return this.projects.find((p) => abs === p.path || abs.startsWith(p.path + sep));
  }

  /**
   * The project a URL in a config value points to, by these rules in order: the host is a compose service
   * that builds one; the host is localhost and the port is exposed by exactly one; the words of the variable
   * name are all in one project's name; the words of the host contain one project's name.
   */
  byUrl(url: URL, key: string | undefined, self: string): ProjectFacts | undefined {
    const others = this.projects.filter((p) => p.id !== self);
    const host = url.hostname.toLowerCase();
    const service = host.split(".")[0] ?? host;
    const named = others.find((p) => p.services.has(service) || p.id === service);
    if (named !== undefined) return named;
    const local =
      host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "host.docker.internal";
    if (local && url.port !== "") {
      const port = Number(url.port);
      const owners = others.filter((p) => p.ports.includes(port));
      if (owners.length === 1) return owners[0];
    }
    if (key !== undefined) {
      const want = wordsOf(key).filter((w) => !FILLER.has(w));
      if (want.length > 0) {
        const hit = pick(others.filter((p) => want.every((w) => p.words.has(w))));
        if (hit !== undefined) return hit;
      }
    }
    const hostWords = new Set(wordsOf(host));
    return pick(others.filter((p) => p.words.size > 0 && [...p.words].every((w) => hostWords.has(w))));
  }
}
