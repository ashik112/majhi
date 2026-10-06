import { WIKI_RULES, type WikiStatus } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { DriftOf } from "./drift.ts";
import type { WikiRepo } from "./repo.ts";
import type { WikiEnabled } from "./switch.ts";

type WikiCommand = "wiki.get" | "wiki.page" | "wiki.estimate" | "wiki.update";

export interface WikiHandlerDeps extends Pick<FindingsHandlerDeps, "lanes" | "store"> {
  repo: WikiRepo;
  enabled: WikiEnabled;
  /** Ids of the workspaces that exist. */
  orgs: () => Promise<readonly string[]>;
  /** Ids of a workspace's registered projects. */
  projects: (org: string) => Promise<readonly string[]>;
  /** How far the code has moved past a built commit. Absent: the status leaves it out. */
  drift?: DriftOf;
}

/**
 * The `wiki.*` commands. The owner reads and updates any workspace's wiki. The captain does the same in its
 * own workspace. Every other agent reads its own workspace's wiki only. With the wiki off for a workspace,
 * nothing but the empty view answers.
 */
export function wikiHandlers(deps: WikiHandlerDeps): Pick<CommandHandlers, WikiCommand> {
  const { repo } = deps;
  const scope = async (ctx: CommandContext, org: string, write: boolean): Promise<void> => {
    if (!(await deps.orgs()).includes(org)) throw new UserError(`Workspace "${org}" does not exist.`, 404);
    const actor = await findingActor(deps, ctx);
    if (actor.kind === "owner") return;
    if (actor.org !== undefined && actor.org !== org) {
      throw new UserError("You work with your own workspace's wiki only.", 409);
    }
    if (actor.kind === "agent" && write) {
      throw new UserError(
        `${ctx.command} changes the wiki, which is the owner's and the captain's. You can read it with wiki.get and wiki.page.`,
        409,
      );
    }
  };
  const requireOn = async (org: string): Promise<void> => {
    if (!(await deps.enabled(org))) throw new UserError(`The wiki is off for workspace "${org}".`, 409);
  };
  const statusOf = async (org: string, project: string): Promise<WikiStatus> => {
    const state = repo.state(org, project);
    const drift =
      state.builtCommit === undefined ? undefined : await deps.drift?.(org, project, state.builtCommit);
    return {
      org,
      project,
      running: false,
      ...(state.builtCommit === undefined ? {} : { builtCommit: state.builtCommit }),
      ...(state.updatedAt === undefined || state.builtCommit === undefined
        ? {}
        : { builtAt: state.updatedAt }),
      ...(drift === undefined ? {} : { behind: drift.behind }),
      changed: drift?.changed ?? [],
      oldRules: state.builtCommit !== undefined && state.rules !== WIKI_RULES,
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    };
  };
  return {
    "wiki.get": async (input, ctx) => {
      await scope(ctx, input.org, false);
      const { org, project } = input;
      if (!(await deps.enabled(org))) {
        return { org, ...(project === undefined ? {} : { project }), enabled: false, pages: [], status: [] };
      }
      const projects = project === undefined ? await deps.projects(org) : [project];
      return {
        org,
        ...(project === undefined ? {} : { project }),
        enabled: true,
        pages: repo.pages(org, project),
        status: await Promise.all(projects.map((p) => statusOf(org, p))),
      };
    },
    "wiki.page": async (input, ctx) => {
      await scope(ctx, input.org, false);
      await requireOn(input.org);
      const stored = repo.page(input.org, input.project, input.id);
      if (stored === undefined) throw new UserError(`There is no wiki page ${input.id}.`, 404);
      return {
        page: stored.page,
        updatedAt: stored.updatedAt,
        versions: repo.versionCount(input.org, input.project, input.id),
      };
    },
    "wiki.estimate": async (input, ctx) => {
      await scope(ctx, input.org, false);
      await requireOn(input.org);
      return notBuilt();
    },
    "wiki.update": async (input, ctx) => {
      await scope(ctx, input.org, true);
      await requireOn(input.org);
      return notBuilt();
    },
  };
}

/** The update service comes with W5. */
async function notBuilt(): Promise<never> {
  throw new UserError("Updating the wiki is not built yet.", 501);
}
