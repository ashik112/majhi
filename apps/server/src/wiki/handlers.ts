import {
  type OwnerAnswer,
  type OwnerCallAnswer,
  type OwnerRoleAnswer,
  WIKI_NOTES_PER_PAGE,
  WIKI_RULES,
  type WikiPageId,
  type WikiStatus,
  wikiPageId,
  wikiPageKind,
} from "@majhi/shared";
import { redactText } from "../admin/policy.ts";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";
import { type FindingsHandlerDeps, findingActor } from "../findings/handlers.ts";
import type { WikiAsk } from "./ask.ts";
import type { DriftOf } from "./drift.ts";
import type { WikiRepo } from "./repo.ts";
import { flowsNotChosen, type WikiService } from "./service.ts";
import type { WikiEnabled } from "./switch.ts";
import { answerAddress, answerCall, answerRole } from "./system/answers.ts";

type WikiCommand =
  | "wiki.get"
  | "wiki.page"
  | "wiki.ask"
  | "wiki.estimate"
  | "wiki.update"
  | "wiki.system"
  | "wiki.answer"
  | "wiki.setRole";

export interface WikiHandlerDeps extends Pick<FindingsHandlerDeps, "lanes" | "store"> {
  repo: WikiRepo;
  enabled: WikiEnabled;
  /** Ids of the workspaces that exist. */
  orgs: () => Promise<readonly string[]>;
  /** Ids of a workspace's registered projects. */
  projects: (org: string) => Promise<readonly string[]>;
  /** How far the code has moved past a built commit. Absent: the status leaves it out. */
  drift?: DriftOf;
  service: Pick<WikiService, "start" | "estimate" | "progress" | "system" | "redraw">;
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
      failed: state.gaps.failed.map((f) => f.page),
      flowsNotChosen: flowsNotChosen(state),
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
  const inWorkspace = async (org: string, project: string): Promise<void> => {
    if (!(await deps.projects(org)).includes(project)) {
      throw new UserError(`"${project}" is not a project of workspace "${org}".`, 404);
    }
  };
  /** Stores one kind of answer for the workspace, replacing every earlier answer of that kind. */
  const keepAddresses = (org: string, next: readonly OwnerAnswer[]) =>
    repo.replaceAnswers(
      org,
      "address",
      next.map((a) => ({ ...a, kind: "address" as const })),
    );
  const keepCalls = (org: string, next: readonly OwnerCallAnswer[]) =>
    repo.replaceAnswers(
      org,
      "call",
      next.map((a) => ({ ...a, kind: "call" as const })),
    );
  const keepRoles = (org: string, next: readonly OwnerRoleAnswer[]) =>
    repo.replaceAnswers(
      org,
      "role",
      next.map((a) => ({ ...a, kind: "role" as const })),
    );
  /** Adds or drops the note of a `wiki.update`. A note belongs to one page of one project of the workspace. */
  const keepNote = async (input: {
    org: string;
    project?: string | undefined;
    page?: WikiPageId | undefined;
    note?: string | undefined;
    dropNote?: string | undefined;
  }): Promise<void> => {
    const { org, project, page } = input;
    if (project === undefined || page === undefined) {
      throw new UserError("A note belongs to one page of one project: give both project and page.", 409);
    }
    await inWorkspace(org, project);
    // A note is one line, and a secret in it is hidden: it is shown on the page and given to the writer.
    const oneLine = (text: string) => redactText(text.split("\r").join(" ").split("\n").join(" ").trim());
    if (input.dropNote !== undefined) {
      if (!repo.dropNote(org, { project, page, text: oneLine(input.dropNote) })) {
        throw new UserError(`${page} of ${project} has no note with that text.`, 404);
      }
    }
    if (input.note !== undefined) {
      if (repo.notes(org, project, page).length >= WIKI_NOTES_PER_PAGE) {
        throw new UserError(
          `${page} of ${project} has ${WIKI_NOTES_PER_PAGE} notes already. Drop one first with dropNote.`,
          409,
        );
      }
      repo.addNote(org, { project, page, text: oneLine(input.note) });
    }
  };
  return {
    "wiki.system": async (input, ctx) => {
      await scope(ctx, input.org, false);
      await requireOn(input.org);
      return (await deps.service.system(input.org)).view;
    },
    "wiki.answer": async (input, ctx) => {
      await scope(ctx, input.org, true);
      await requireOn(input.org);
      const { org, question } = input;
      // An answer names a project of this workspace and no other: nothing crosses into another workspace.
      if (input.to?.kind === "project") await inWorkspace(org, input.to.project);
      const to = input.to ?? undefined;
      if (question.kind === "address") {
        const address = { host: question.host.toLowerCase(), port: question.port, scope: question.scope };
        if (address.scope !== undefined) await inWorkspace(org, address.scope);
        keepAddresses(org, answerAddress(repo.addressAnswers(org), address, to));
      } else {
        const call = (await deps.service.system(org)).facts.find(
          (f) => f.kind === "call" && f.id === question.call,
        );
        if (call === undefined || call.kind !== "call") {
          throw new UserError(`There is no call ${question.call} in workspace "${org}".`, 404);
        }
        keepCalls(
          org,
          answerCall(repo.callAnswers(org), { repo: call.repo, method: call.method, path: call.path }, to),
        );
      }
      await deps.service.redraw(org);
      return (await deps.service.system(org)).view;
    },
    "wiki.setRole": async (input, ctx) => {
      await scope(ctx, input.org, true);
      await requireOn(input.org);
      const { org, project } = input;
      await inWorkspace(org, project);
      const id = wikiPageId({ kind: "overview" });
      const stored = repo.page(org, project, id);
      const tile =
        stored === undefined
          ? undefined
          : repo.shown(stored.page).roles.find((r) => r.role === input.role && r.where === input.where);
      if (stored === undefined || tile === undefined) {
        throw new UserError(`The overview of ${project} has no ${input.role} tile at ${input.where}.`, 404);
      }
      const choice = input.choice === "undo" ? undefined : input.choice;
      keepRoles(
        org,
        answerRole(repo.roleAnswers(org), { project, role: input.role, where: input.where }, choice),
      );
      await deps.service.redraw(org);
      const now = repo.page(org, project, id) ?? stored;
      return {
        page: repo.shown(now.page),
        updatedAt: now.updatedAt,
        versions: repo.versionCount(org, project, id),
        notes: repo.notes(org, project, id),
      };
    },
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
        // The owner's decisions about role tiles show on read; the stored page is the writer's.
        page: repo.shown(stored.page),
        updatedAt: stored.updatedAt,
        versions: repo.versionCount(input.org, input.project, input.id),
        notes: input.project === undefined ? [] : repo.notes(input.org, input.project, input.id),
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
      return deps.service.estimate(input.org, input.project, input.page);
    },
    "wiki.update": async (input, ctx) => {
      await scope(ctx, input.org, true);
      await requireOn(input.org);
      // A workspace has an overview, flows and gaps. Name the mistake now: the run goes on after the answer.
      if (input.page !== undefined && input.project === undefined) {
        const kind = wikiPageKind(input.page);
        if (kind !== "overview" && kind !== "flow" && kind !== "gaps") {
          throw new UserError(
            `A workspace has no ${kind} page. Name a project to update ${input.page}.`,
            409,
          );
        }
      }
      const noted = input.note !== undefined || input.dropNote !== undefined;
      if (noted) await keepNote(input);
      let started: Awaited<ReturnType<typeof deps.service.start>>;
      try {
        started = await deps.service.start(input.org, input.project, {
          ...(input.replan === undefined ? {} : { replan: input.replan }),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      } catch (err) {
        // The note is kept and shows on the page; only the rewrite waits.
        if (noted && err instanceof UserError) {
          throw new UserError(
            `The note is saved and shows on the page. The page was not rewritten: ${err.message}`,
            err.status,
          );
        }
        throw err;
      }
      const { finished } = started;
      // The run goes on after the answer; its failure is the project's last error, which the page shows.
      void finished.catch(() => undefined);
      return view(input.org, input.project);
    },
  };
}
