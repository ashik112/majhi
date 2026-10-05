import type { OrgView } from "@majhi/shared";
import { scopeName } from "@/features/connections/scope-picker";

/** A group of agents by the scope in their file: root agents, or a workspace by name. */
export function groupName(scope: string, orgs: readonly OrgView[]): string {
  return scope === "root" ? "Root agents" : scopeName(scope, orgs);
}
