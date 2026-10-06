import type { OwnerRoleAnswer, WikiPage, WikiRoleRow } from "@majhi/shared";
import { WikiPageSchema } from "@majhi/shared";

/**
 * The owner's decisions about the role tiles of a project's overview. A tile the owner confirmed stands as proven
 * with the basis `owner`; one the owner changed takes the chosen role and the same basis. The writer's claim is left
 * as it was written, so a later update that writes the tile again meets the same decision. Pure.
 */

const decisionFor = (
  choices: readonly OwnerRoleAnswer[],
  project: string,
  row: Pick<WikiRoleRow, "role" | "where">,
) => choices.find((c) => c.project === project && c.role === row.role && c.where === row.where);

/** The overview with the owner's decisions applied. Any other page, and an overview with no decision, comes back as it was. */
export function applyRoleChoices(page: WikiPage, choices: readonly OwnerRoleAnswer[]): WikiPage {
  if (page.kind !== "overview" || page.project === undefined || page.roles.length === 0) return page;
  const project = page.project;
  let changed = false;
  const roles = page.roles.map((row) => {
    const decision = decisionFor(choices, project, row);
    if (decision === undefined) return row;
    changed = true;
    return {
      ...row,
      role: decision.choice === "confirm" ? row.role : decision.choice,
      basis: "owner" as const,
    };
  });
  return changed ? WikiPageSchema.parse({ ...page, roles }) : page;
}

/** The tiles of an overview that are still a guess: their claim is not proven and the owner has not decided. */
export function guessedRoles(page: WikiPage, choices: readonly OwnerRoleAnswer[]): WikiRoleRow[] {
  if (page.kind !== "overview" || page.project === undefined) return [];
  const project = page.project;
  return page.roles.filter((row) => {
    const claim = page.claims.find((c) => c.n === row.claim);
    return claim !== undefined && !claim.proven && decisionFor(choices, project, row) === undefined;
  });
}
