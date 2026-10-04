import { join } from "node:path";
import { DEFAULT_GIT_HOST, type MrHost, type RemoteRepo } from "@majhi/shared";
import type { CommandContext, CommandHandlers } from "../commands/handlers.ts";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import type { HostLink } from "../host/link.ts";
import type { RepoScanner } from "../scan/scanner.ts";
import type { Services } from "../services.ts";
import { appsView, setApp } from "./apps.ts";
import { type HereIndex, hereOf, repoKeyOf } from "./here.ts";
import { listOwners, listRepos } from "./hostRepos.ts";
import { HostUnreachable } from "./http.ts";
import { whoAmI } from "./oauth.ts";
import { onboardingStatus } from "./onboarding.ts";
import { targetState } from "./paths.ts";
import { connectRemote, createProject, publishProject } from "./project.ts";

/** The commands of git sign-in, remote repos, clone, new project and the onboarding status. */
type GitConnectCommand =
  | "git.oauthApps.get"
  | "git.oauthApps.set"
  | "git.signIn.start"
  | "git.signIn.poll"
  | "git.signIn.cancel"
  | "git.signIn.confirm"
  | "git.signIn.token"
  | "git.signOut"
  | "git.remoteRepos"
  | "git.remoteOwners"
  | "projects.clone"
  | "projects.cloneStatus"
  | "projects.create"
  | "projects.publish"
  | "projects.connectRemote"
  | "onboarding.status";

export interface GitConnectHandlerDeps {
  config: ConfigService;
  scanner: RepoScanner;
  hostLink: HostLink;
  services: Services;
}

/** Sign-in and the OAuth apps are the owner's: an agent never gets them, even past the agent-blocked set. */
function ownerOnly(ctx: CommandContext, what: string): void {
  if (ctx.meta.actor.kind === "agent") {
    throw new UserError(`Only the owner can ${what}, under Git accounts on the Workspaces page.`, 409);
  }
}

const change = (ctx: CommandContext) => ({ command: ctx.command, meta: ctx.meta });

/** Host errors become 409 sentences; anything else goes on. */
function plain<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    if (err instanceof HostUnreachable) throw new UserError(err.message, 409);
    throw err;
  });
}

/**
 * The onboarding and git connect commands (docs/briefs/onboarding-and-git-connect.md). The table
 * in `commands/handlers.ts` spreads these in.
 */
export function gitConnectHandlers({
  config,
  scanner,
  hostLink,
  services,
}: GitConnectHandlerDeps): Pick<CommandHandlers, GitConnectCommand> {
  const gc = services.gitConnect;
  const view = async () => appsView(await gc.apps());

  /** Projects, repos under the roots and SSH aliases, for marking remote repos already here. */
  const hereIndex = async (): Promise<HereIndex> => {
    const loaded = await config.load();
    const scanned =
      loaded.state.status === "loaded"
        ? (
            await scanner.scan(
              {
                config: loaded.state.config,
                projectPaths: loaded.projectPaths,
                hostHome: config.paths.hostHome,
              },
              false,
            )
          ).roots.flatMap((r) =>
            r.repos.map((repo) => ({ path: repo.path, remotes: repo.remotes.map((x) => x.url) })),
          )
        : [];
    return { projects: await gc.projectRemotes(), scanned, aliases: await gc.aliases() };
  };
  const firstRoot = async (): Promise<string | undefined> => {
    const loaded = await config.load();
    return loaded.state.status === "loaded" ? loaded.state.config.workspaces[0] : undefined;
  };

  return {
    "git.oauthApps.get": () => view(),

    "git.oauthApps.set": async (input, ctx) => {
      ownerOnly(ctx, "set majhi's apps on git hosts");
      if (!(await config.sections()).exists) {
        throw new UserError("Pick a project folder first: majhi.yaml does not exist yet.", 409);
      }
      await setApp({ config }, input, change(ctx));
      return view();
    },

    "git.signIn.start": (input, ctx) => {
      ownerOnly(ctx, "sign a workspace in to a git host");
      return gc.signIn.start(input, ctx.meta);
    },
    "git.signIn.poll": async (input, ctx) => {
      ownerOnly(ctx, "follow a sign-in");
      return gc.signIn.poll(input.signIn);
    },
    "git.signIn.cancel": async (input, ctx) => {
      ownerOnly(ctx, "cancel a sign-in");
      return gc.signIn.cancel(input.signIn);
    },
    "git.signIn.confirm": async (input, ctx) => {
      ownerOnly(ctx, "confirm a sign-in");
      return gc.signIn.confirm(input.signIn);
    },
    "git.signIn.token": (input, ctx) => {
      ownerOnly(ctx, "save a git token for a workspace");
      return gc.signIn.token(input, ctx.meta);
    },
    "git.signOut": async (input, ctx) => {
      ownerOnly(ctx, "sign a workspace out of a git host");
      return gc.signIn.signOut(input, change(ctx));
    },

    "git.remoteRepos": async (input) => {
      const host = input.host ?? DEFAULT_GIT_HOST[input.kind];
      const kind: MrHost = input.kind;
      const answer = await plain(
        gc.tokens.withToken(input.org, kind, host, async (token, known) => {
          const account = known ?? (await whoAmI(gc.fetch, kind, host, token));
          const page = await listRepos(gc.fetch, kind, token, {
            host,
            account,
            query: input.query,
            page: input.page,
            perPage: input.perPage,
          });
          return { account, page };
        }),
      );
      if (answer.state === "signed-out") return { state: "signed-out", kind, host };
      if (answer.state === "refused") return { state: "refused", kind, host, account: answer.account };
      const index = await hereIndex();
      const root = await firstRoot();
      const repos: RemoteRepo[] = await Promise.all(
        answer.value.page.repos.map(async (repo) => {
          const folder = root === undefined ? undefined : join(root, input.org, repo.name);
          const exists =
            folder !== undefined && (await targetState(folder).catch(() => "missing" as const)) === "taken";
          return {
            ...repo,
            here: hereOf(index, repoKeyOf(host, repo.fullName), exists ? folder : undefined),
          };
        }),
      );
      return {
        state: "ok",
        account: answer.value.account,
        repos,
        page: input.page,
        ...(answer.value.page.nextPage === undefined ? {} : { nextPage: answer.value.page.nextPage }),
      };
    },

    "git.remoteOwners": async (input) => {
      const host = input.host?.toLowerCase() ?? DEFAULT_GIT_HOST[input.kind];
      const answer = await plain(
        gc.tokens.withToken(input.org, input.kind, host, async (token, known) => {
          const account = known ?? (await whoAmI(gc.fetch, input.kind, host, token));
          return { account, owners: await listOwners(gc.fetch, input.kind, host, token, account) };
        }),
      );
      if (answer.state === "signed-out") return { state: "signed-out", kind: input.kind, host };
      if (answer.state === "refused")
        return { state: "refused", kind: input.kind, host, account: answer.account };
      return { state: "ok", account: answer.value.account, owners: answer.value.owners };
    },

    "projects.clone": (input, ctx) => gc.clones.start(input, change(ctx)),
    "projects.cloneStatus": async (input) => ({ jobs: gc.clones.list(input.clone) }),
    "projects.create": (input, ctx) => createProject(gc.projectDeps, input, change(ctx)),
    "projects.publish": (input, ctx) => plain(publishProject(gc.projectDeps, input, change(ctx))),
    "projects.connectRemote": (input, ctx) => plain(connectRemote(gc.projectDeps, input, change(ctx))),

    "onboarding.status": async () => {
      const loaded = await config.load();
      const sections = await config.sections();
      const projects: Record<string, number> = {};
      for (const p of Object.values(sections.projects)) projects[p.org] = (projects[p.org] ?? 0) + 1;
      const agents = await services.agents.list();
      return onboardingStatus({
        roots: loaded.state.status === "loaded" ? loaded.state.config.workspaces : [],
        orgs: sections.orgs,
        accounts: await services.accounts.list(),
        hasCaptain: agents.some((a) => a.status === "ok" && a.isBoss),
        projects,
        hostHelper: hostLink.isConnected(),
      });
    },
  };
}
