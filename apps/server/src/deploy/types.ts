import type { DeployKind, DeployTarget } from "@majhi/shared";
import type { RemoteRunFn } from "../connections/remote.ts";
import type { Fetch } from "../gitConnect/http.ts";

/**
 * What a deploy needs from the providers it can run on. One provider per kind of target; each takes
 * the credential of the target's own connection and nothing else. Nothing in here builds a command
 * from text: an ssh target runs the string its owner wrote.
 */

/** The run a provider started: its id, its page, and for GitHub which attempt of it is ours. */
export interface RunHandle {
  id: string;
  url?: string | undefined;
  attempt?: number | undefined;
  /** A provider whose run ends before `start` returns (an ssh command) hands the outcome back here. */
  outcome?: RunProgress | undefined;
}

export type RunProgress = { state: "running" } | { state: "success" } | { state: "failed"; detail: string };

/** The host of a project's repo, as the project's remote says. Absent when it has none a provider can use. */
export interface RepoRef {
  provider: "github" | "gitlab" | "bitbucket";
  /** `owner/repo`, or `group/subgroup/repo`. */
  slug: string;
}

/** What a provider knows when it deploys: whose, what, which commit, and the target the owner set. */
export interface DeployContext {
  org: string;
  project: string;
  env: string;
  /** The base branch a run starts from when the target says `base`. */
  base: string;
  commit: string;
  repo: RepoRef | undefined;
  target: DeployTarget;
}

/** The run a rollback goes back to: the commit and the run that deployed it. */
export interface PreviousDeploy {
  commit: string;
  run: RunHandle | undefined;
}

export interface DeployProvider {
  /** A sentence when the host does not have the commit where the run would start from, else undefined. */
  preflight(ctx: DeployContext): Promise<string | undefined>;
  start(ctx: DeployContext): Promise<RunHandle>;
  poll(ctx: DeployContext, run: RunHandle): Promise<RunProgress>;
  /** Starts the run that deployed `previous` again. Undefined when this kind of target cannot. */
  redeploy?(ctx: DeployContext, previous: PreviousDeploy): Promise<RunHandle>;
}

export type Providers = Record<DeployKind, DeployProvider>;

/** The credentials of a workspace's connections. Each answer is a value or one sentence saying why not. */
export interface DeployCredentials {
  /** The workspace's sign-in to a git host, through one of its `git` connections. */
  git(
    org: string,
    connection: string,
    provider: "github" | "gitlab",
  ): Promise<{ token: string; host: string } | { problem: string }>;
  /** One variable of one of its `env` connections. */
  variable(org: string, connection: string, name: string): Promise<{ value: string } | { problem: string }>;
  /** The host of one of its `ssh` connections. */
  ssh(
    org: string,
    connection: string,
  ): Promise<{ alias: string; key?: string | undefined } | { problem: string }>;
}

export interface ProviderDeps {
  fetch: Fetch;
  credentials: DeployCredentials;
  remote: RemoteRunFn;
  sleep(ms: number): Promise<void>;
  now(): Date;
  /** Vercel's API address, when it is not Vercel's own (a fake one in tests and proofs). */
  vercelApi?: string | undefined;
}

/** A provider could not do what was asked. Its message is safe to show: it never holds a credential. */
export class DeployProblem extends Error {}

/** `https` for every host but one on this computer, which has no certificate to check. */
export function apiScheme(host: string): "http" | "https" {
  const name = host.startsWith("[") ? host : (host.split(":")[0] ?? host);
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" ? "http" : "https";
}
