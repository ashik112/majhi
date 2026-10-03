/**
 * Reads an owner's room message as a request to install a skill or an MCP server (Phase 6, "install
 * by message"): "@agent install this skill <link>", "@agent add this MCP server <registry name>".
 * Only a message that is nothing but the request counts. Anything longer is ordinary conversation
 * and goes to the agent as it always did, so "install the skill, then fix the bug" is not hijacked.
 */

export type InstallRequest =
  | {
      kind: "skill";
      /** A link, `owner/repo` or a folder path. */
      source: string;
      /** Install only this skill of a source that holds several. */
      skill?: string;
    }
  | { kind: "mcp"; ref: McpRef };

/** What the owner named for an MCP server. */
export type McpRef =
  | { type: "registry"; name: string }
  | { type: "url"; url: string }
  | { type: "command"; command: string }
  | { type: "json"; json: string }
  /** One plain word: a registry search decides. */
  | { type: "search"; query: string };

const ASK = String.raw`^(?:(?:please|kindly)[\s,]+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:install|add|set\s*up|get)\s+`;
const THIS = String.raw`(?:(?:this|the|a|an|that)\s+)?`;
const SKILL = new RegExp(`${ASK}${THIS}(?:agent\\s+)?skill\\s*(?::|-)?\\s+(.+)$`, "is");
const MCP = new RegExp(`${ASK}${THIS}mcp(?:\\s+server)?\\s*(?::|-)?\\s+(.+)$`, "is");

/** First words that make the rest a local command. */
const RUNNERS = new Set(["npx", "uvx", "bunx", "pnpm", "docker", "node", "python", "python3", "deno"]);
const FENCE = /^```[a-z]*\n?([\s\S]*?)\n?```$/i;

/** The message without @mentions at its start, which only say who is asked. */
function withoutMentions(text: string): string {
  return text
    .trim()
    .replace(/^(?:@[a-z0-9][a-z0-9-]*[\s,:]+)+/i, "")
    .trim();
}

function plain(word: string): string {
  return word.replace(/^[<`'"(]+|[>`'")]+$/g, "").replace(/[.,;!?]+$/, "");
}

export function parseInstallRequest(text: string): InstallRequest | undefined {
  const body = withoutMentions(text);
  if (body === "" || body.length > 20_000) return undefined;
  const skill = SKILL.exec(body);
  if (skill?.[1] !== undefined) return skillRequest(fromless(skill[1]));
  const mcp = MCP.exec(body);
  if (mcp?.[1] !== undefined) return mcpRequest(fromless(mcp[1]));
  return undefined;
}

/** "from <source>" right after the noun names the source the same way. */
function fromless(rest: string): string {
  return rest.trim().replace(/^from\s+/i, "");
}

function skillRequest(rest: string): InstallRequest | undefined {
  // "lint-fixes from acme/agent-skills": one skill of a source.
  const named = /^(\S+)\s+from\s+(\S+)$/i.exec(rest);
  if (named?.[1] !== undefined && named[2] !== undefined) {
    const skill = plain(named[1]);
    const source = plain(named[2]);
    return skill === "" || source === "" ? undefined : { kind: "skill", source, skill };
  }
  if (/\s/.test(rest)) return undefined;
  const source = plain(rest);
  return source === "" ? undefined : { kind: "skill", source };
}

function mcpRequest(rest: string): InstallRequest | undefined {
  const fenced = FENCE.exec(rest);
  const code = (fenced?.[1] ?? rest).trim();
  if (code.startsWith("{") && code.endsWith("}")) return { kind: "mcp", ref: { type: "json", json: code } };
  const words = code.split(/\s+/);
  const first = words[0]?.toLowerCase() ?? "";
  if (words.length > 1) {
    if (!RUNNERS.has(first)) return undefined;
    return { kind: "mcp", ref: { type: "command", command: code.replace(/[.;!]+$/, "") } };
  }
  const word = plain(code);
  if (word === "") return undefined;
  if (/^https?:\/\//i.test(word)) return { kind: "mcp", ref: { type: "url", url: word } };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(word))
    return { kind: "mcp", ref: { type: "registry", name: word } };
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(word)) return { kind: "mcp", ref: { type: "search", query: word } };
  return undefined;
}

/** Hosts whose pages show a repository, not an MCP server: a link there is not an address to connect to. */
const REPO_HOSTS = new Set(["github.com", "www.github.com", "gitlab.com", "www.gitlab.com", "bitbucket.org"]);

export function isRepoPage(url: string): boolean {
  try {
    return REPO_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
