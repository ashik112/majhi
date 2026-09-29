import { type AccountModels, type AgentFrontmatter, AUTO, PRIVATE } from "@majhi/shared";
import type { ConfigSections } from "../config/sections.ts";

export interface WarningContext {
  sections: ConfigSections;
  /** Cached model lists by account id. Accounts never checked are absent. */
  models: ReadonlyMap<string, AccountModels>;
  agentIds: ReadonlySet<string>;
}

/** Problems that do not stop an agent file from loading. */
export function agentWarnings(f: AgentFrontmatter, ctx: WarningContext): string[] {
  const out: string[] = [];
  const account = ctx.sections.accounts[f.account];
  if (account === undefined) {
    out.push(`Account "${f.account}" is not in majhi.yaml`);
  } else if (f.scope !== "root" && account.org !== f.scope && account.org !== PRIVATE) {
    out.push(`Account "${f.account}" belongs to org "${account.org}", but this agent works in "${f.scope}"`);
  }

  const offered = ctx.models.get(f.account);
  if (offered !== undefined) {
    for (const id of [f.model, ...(f.models ?? [])]) {
      if (id !== undefined && id !== AUTO && !offered.models.some((m) => m.id === id)) {
        out.push(`Model "${id}" is not offered by ${f.account}`);
      }
    }
    if (f.effort !== undefined && f.effort !== AUTO && !offered.efforts.some((e) => e.id === f.effort)) {
      out.push(`Effort "${f.effort}" is not offered by ${f.account}`);
    }
  }

  if (f.fallback !== undefined && !ctx.agentIds.has(f.fallback)) {
    out.push(`Fallback agent "${f.fallback}" does not exist`);
  }
  return out;
}
