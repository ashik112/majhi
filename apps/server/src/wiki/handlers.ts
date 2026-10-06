import { WIKI_RULES, type WikiStatus } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { WikiAsk } from "./ask.ts";
import type { DriftOf } from "./drift.ts";
import type { WikiRepo } from "./repo.ts";
import type { WikiService } from "./service.ts";
import type { WikiEnabled } from "./switch.ts";

type WikiCommand = "wiki.get" | "wiki.page" | "wiki.ask" | "wiki.estimate" | "wiki.update";

export interface WikiHandlerDeps extends Pick<FindingsHandlerDeps, "lanes" | "store"> {
  repo: WikiRepo;
  enabled: WikiEnabled;
  /** Ids of the workspaces that exist. */
  orgs: () => Promise<readonly string[]>;
  /** Ids of a workspace's registered projects. */
  projects: (org: string) => Promise<readonly string[]>;
  /** How far the code has moved past a built commit. Absent: the status leaves it out. */
  drift?: DriftOf;
  service: Pick<WikiService, "start" | "estimate" | "progress">;
  asker: Pick<WikiAsk, "answer">;
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
    const running = deps.service.progress(org, project);
    return {
      org,
      project,
      ...(running === undefined ? { running: false as const } : { running: true as const, ...running }),
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
  const view = async (org: string, project: string | undefined) => {
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
  };
  return {
    "wiki.get": async (input, ctx) => {
      await scope(ctx, input.org, false);
      return view(input.org, input.project);
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
    "wiki.ask": async (input, ctx) => {
      await scope(ctx, input.org, false);
      await requireOn(input.org);
      return deps.asker.answer(input.org, input.project, input.question);
    },
    "wiki.estimate": async (input, ctx) => {
      await scope(ctx, input.org, false);
      await requireOn(input.org);
      return deps.service.estimate(input.org, input.project);
    },
    "wiki.update": async (input, ctx) => {
      await scope(ctx, input.org, true);
      await requireOn(input.org);
      const { finished } = await deps.service.start(input.org, input.project, {
        ...(input.replan === undefined ? {} : { replan: input.replan }),
      });
      // The run goes on after the answer; its failure is the project's last error, which the page shows.
      void finished.catch(() => undefined);
      return view(input.org, input.project);
    },
  };
}
