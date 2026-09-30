import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface HostBlock {
  /** Patterns from the `Host` line, lowercased. Empty for `Match` blocks, which never match here. */
  patterns: string[];
  /** The patterns as written, for listing aliases. */
  names?: string[];
  hostName?: string;
  user?: string;
  identityFile?: string;
}

/** One `Host` alias of `~/.ssh/config` (no wildcards), for picking a remote's SSH alias. */
export interface SshAlias {
  alias: string;
  hostName?: string;
  user?: string;
  identityFile?: string;
}

/**
 * The part of `~/.ssh/config` majhi needs: which host an alias points to.
 * Supports `Host` patterns with `*`, `?` and `!` and the first `HostName`
 * that applies, as ssh does. `Include` and `Match` are not followed.
 */
export class SshConfig {
  constructor(private readonly blocks: readonly HostBlock[]) {}

  static parse(text: string): SshConfig {
    const blocks: HostBlock[] = [{ patterns: ["*"] }];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
      if (!match) continue;
      const keyword = (match[1] ?? "").toLowerCase();
      const args = (match[2] ?? "").trim();
      if (keyword === "host") {
        const names = splitArgs(args);
        blocks.push({ patterns: names.map((p) => p.toLowerCase()), names });
      } else if (keyword === "match") {
        blocks.push({ patterns: [] });
      } else if (keyword === "hostname") {
        const block = blocks[blocks.length - 1];
        const value = splitArgs(args)[0];
        if (block && block.hostName === undefined && value !== undefined) block.hostName = value;
      } else if (keyword === "user" || keyword === "identityfile") {
        const block = blocks[blocks.length - 1];
        const value = splitArgs(args)[0];
        if (block === undefined || value === undefined) continue;
        if (keyword === "user") block.user ??= value;
        else block.identityFile ??= value;
      }
    }
    return new SshConfig(blocks);
  }

  /** Every literal `Host` name, in file order, with what its own block sets. Wildcards and negations are left out. */
  aliases(): SshAlias[] {
    const out: SshAlias[] = [];
    const seen = new Set<string>();
    for (const block of this.blocks) {
      for (const name of block.names ?? []) {
        if (/[*?!]/.test(name) || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        const hostName = this.hostNameFor(name);
        out.push({
          alias: name,
          ...(hostName === undefined ? {} : { hostName }),
          ...(block.user === undefined ? {} : { user: block.user }),
          ...(block.identityFile === undefined ? {} : { identityFile: block.identityFile }),
        });
      }
    }
    return out;
  }

  /** The real host name for `alias`, or undefined when no `HostName` applies to it. */
  hostNameFor(alias: string): string | undefined {
    const host = alias.toLowerCase();
    for (const block of this.blocks) {
      if (block.hostName !== undefined && matchesHost(block.patterns, host)) {
        return block.hostName.replaceAll("%h", host).replaceAll("%%", "%");
      }
    }
    return undefined;
  }
}

/** Reads `<home>/.ssh/config`. A missing or unreadable file means no aliases. */
export async function loadSshConfig(home: string): Promise<SshConfig> {
  try {
    return SshConfig.parse(await readFile(join(home, ".ssh", "config"), "utf8"));
  } catch {
    return new SshConfig([]);
  }
}

function matchesHost(patterns: readonly string[], host: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globMatch(pattern.slice(1), host)) return false;
    } else if (globMatch(pattern, host)) {
      matched = true;
    }
  }
  return matched;
}

function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`).test(value);
}

/** Splits ssh config arguments on whitespace, honoring double quotes. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/** The aliases in `<home>/.ssh/config`. A missing or unreadable file means none. */
export async function sshConfigHosts(home: string): Promise<SshAlias[]> {
  return (await loadSshConfig(home)).aliases();
}
