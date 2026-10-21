import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isId } from "@majhi/shared";
import type { AccountRuntime } from "./index.ts";
import { getTool } from "./tools/index.ts";

/**
 * Every agent session has a home of its own workspace and account: `<majhi home>/agent-homes/<org>/<account>`.
 * It is both `HOME` and the CLI's config home, so what an agent writes there (settings, hooks, MCP servers,
 * instructions, transcripts) reaches that workspace's next sessions and no other workspace's. The account's
 * own folder (`accounts/<id>`) keeps only the sign-in, the probes and the usage reads, and no run mounts it.
 */
export const AGENT_HOMES_DIR = "agent-homes";

/**
 * The org of a session that belongs to no workspace: the captain across all workspaces, a job with no org, the
 * decisions stand-in. Not a valid org id, so no workspace can ever have it.
 */
export const INTERNAL_ORG = "_majhi";

/** `<majhi home>/agent-homes/<org>/<account>`. */
export function agentHomePath(majhiHome: string, org: string, account: string): string {
  return join(majhiHome, AGENT_HOMES_DIR, org, account);
}

/** An org folder name under `agent-homes`: a workspace id, or the internal one. */
export function isHomeOrg(name: string): boolean {
  return name === INTERNAL_ORG || isId(name);
}

/**
 * The file the CLI keeps its sign-in in, which is the one file shared by every workspace of an account: the
 * source in the account's folder, and the name it has inside a session's home. Undefined for an API-key
 * account (it has no such file) and for a request that is not a session of a workspace.
 */
export function signInFileOf(account: AccountRuntime): { source: string; name: string } | undefined {
  if (account.accountHome === undefined || account.apiKey !== undefined) return undefined;
  const name = getTool(account.tool).signInFile;
  return { source: join(account.accountHome, name), name };
}

/**
 * `signInFileOf` when the file is there, and a plain file. Docker makes a folder of a missing source, and a
 * link could lead anywhere, so neither is ever mounted.
 */
export function existingSignIn(account: AccountRuntime): { source: string; name: string } | undefined {
  const file = signInFileOf(account);
  if (file === undefined) return undefined;
  try {
    const info = lstatSync(file.source);
    return info.isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}
