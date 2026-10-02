import { DEFAULT_MAJHI_ORIGIN, oauthCallbackUrl } from "@majhi/shared";
import type { CommandHandlers } from "../commands/handlers.ts";
import { UserError } from "../errors.ts";

/** The commands of git sign-in, remote repos, clone, new project and the onboarding status. */
type GitConnectCommand =
  | "git.oauthApps.get"
  | "git.oauthApps.set"
  | "git.signIn.start"
  | "git.signIn.poll"
  | "git.signIn.cancel"
  | "git.signIn.confirm"
  | "git.signOut"
  | "git.remoteRepos"
  | "git.remoteOwners"
  | "projects.clone"
  | "projects.cloneStatus"
  | "projects.create"
  | "projects.publish"
  | "projects.connectRemote"
  | "onboarding.status";

/** Until the phase is built: every command answers 501, except two reads whose empty answer is true. */
async function notBuilt(): Promise<never> {
  throw new UserError("This command is not built yet.", 501);
}

/**
 * Stubs for the onboarding and git connect contract (docs/briefs/onboarding-and-git-connect.md).
 * The command table spreads these in. Sign-in, clone and the OAuth apps are the owner's: the
 * agent-blocked set in `approval-groups.ts` keeps the sign-in commands from agents, and the real
 * handlers must refuse an agent actor too.
 */
export function gitConnectHandlers(): Pick<CommandHandlers, GitConnectCommand> {
  return {
    "git.oauthApps.get": async () => ({
      github: {},
      gitlab: [],
      bitbucket: { secretSaved: false },
      origin: DEFAULT_MAJHI_ORIGIN,
      bitbucketCallback: oauthCallbackUrl(DEFAULT_MAJHI_ORIGIN, "bitbucket"),
    }),
    "git.oauthApps.set": notBuilt,
    "git.signIn.start": notBuilt,
    "git.signIn.poll": notBuilt,
    "git.signIn.cancel": notBuilt,
    "git.signIn.confirm": notBuilt,
    "git.signOut": notBuilt,
    "git.remoteRepos": notBuilt,
    "git.remoteOwners": notBuilt,
    "projects.clone": notBuilt,
    "projects.cloneStatus": async () => ({ jobs: [] }),
    "projects.create": notBuilt,
    "projects.publish": notBuilt,
    "projects.connectRemote": notBuilt,
    "onboarding.status": notBuilt,
  };
}
