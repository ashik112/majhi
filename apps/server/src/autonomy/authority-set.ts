import {
  type AuthoritySetInput,
  type AuthoritySetResult,
  type AutonomyOrg,
  type CommandMeta,
  carriedOver,
  DEFAULT_LEVEL,
  LEVEL_LABEL,
  PRIVATE,
} from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";

/**
 * `authority.set`: the one place a workspace's authority level and its two incident switches are written. It
 * is the org policy CLAUDE.md asks for push, merge and outbound messages, so only the owner reaches it: the
 * command is not a tool of any agent or of the captain, and it refuses an agent's actor here as well.
 */
export async function setAuthority(
  config: ConfigService,
  input: AuthoritySetInput,
  change: { command: string; meta: CommandMeta },
): Promise<AuthoritySetResult> {
  if (change.meta.actor.kind !== "owner") {
    throw new UserError(
      `${change.command} is the owner's. The authority level is the workspace's policy for push, merge and messages, so no agent and no captain changes it.`,
      409,
    );
  }
  const sections = await config.sections();
  if (!sections.exists) throw new UserError("Pick workspace roots first.", 409);
  if (input.org !== PRIVATE && sections.orgs[input.org] === undefined) {
    throw new UserError(`Org "${input.org}" does not exist.`, 404);
  }
  const { autonomy } = await config.settings();
  const had = carriedOver(autonomy.orgs[input.org], input.org === PRIVATE);
  const incident = {
    ...(had.incident ?? {}),
    ...(input.fix === undefined ? {} : { fix: input.fix }),
    ...(input.clientUpdate === undefined ? {} : { clientUpdate: input.clientUpdate }),
  };
  const next: AutonomyOrg = {
    ...had,
    ...(input.level === undefined ? {} : { level: input.level }),
    ...(Object.keys(incident).length === 0 ? {} : { incident }),
  };
  const name = input.org === PRIVATE ? "Private" : (sections.orgs[input.org]?.name ?? input.org);
  const parts = [
    ...(input.level === undefined ? [] : [`its authority level to ${LEVEL_LABEL[input.level]}`]),
    ...(input.fix === undefined
      ? []
      : [`an incident's fix to ${input.fix === "ships" ? "Captain ships" : "Ask me"}`]),
    ...(input.clientUpdate === undefined
      ? []
      : [`the client update to ${input.clientUpdate === "sends" ? "Captain sends" : "Ask me"}`]),
  ];
  await config.setSettings(
    { autonomy: { orgs: { ...autonomy.orgs, [input.org]: next } } },
    { ...change, summary: `set ${name}'s ${parts.join(" and ")}` },
  );
  return {
    org: input.org,
    level:
      next.level === "ask" || next.level === "routine" || next.level === "full" ? next.level : DEFAULT_LEVEL,
    fix: next.incident?.fix ?? "ask",
    clientUpdate: next.incident?.clientUpdate ?? "ask",
  };
}
