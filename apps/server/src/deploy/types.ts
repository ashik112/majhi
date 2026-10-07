import type { DeployEnvironment, DeployKind, DeployRunStep } from "@majhi/shared";
import type { RemoteRunFn } from "../connections/remote.ts";
import type { Fetch } from "../gitConnect/http.ts";

/**
 * What a deploy needs from the providers it can run on. One provider per kind of run. A run on a git host
 * uses the workspace's git account for the host of the run's remote; vercel and ssh runs use a connection
 * of the workspace. Nothing in here builds a command from text: an ssh run is the string its owner wrote.
 */

/** The run a provider started: its id, its page, and for GitHub which attempt of it is ours. */
export interface RunHandle {
  id: string;
  url?: string | undefined;
  attempt?: number | undefined;
  /** Set by the service once the run ended well. */
  ended?: boolean | undefined;
  /** A provider whose run ends before `start` returns (an ssh command) hands the outcome back here. */
  outcome?: RunProgress | undefined;
}

export type RunProgress = { state: "running" } | { state: "success" } | { state: "failed"; detail: string };

/** The host of a project's repo, as the project's remote says. Absent when it has none a provider can use. */
export interface RepoRef {
  provider: "github" | "gitlab" | "bitbucket";
  /** `owner/repo`, or `group/subgroup/repo`. */
  slug: string;
  /** The host name the workspace's git account is for: `github.com`, or a self-hosted server. */
  host: string;
}

/** What a provider knows when it deploys: whose, what, which commit, and the environment. */
export interface DeployContext {
  org: string;
  project: string;
  env: DeployEnvironment;
  /** The base branch a run starts from when the run says `base`. */
  base: string;
  commit: string;
  /** The host and repo of one of the project's remotes, or of the one merge requests go to when none is named. Undefined when it is not a host a provider reaches. */
  repoOf(remote?: string): Promise<RepoRef | undefined>;
}

/** The run a rollback goes back to: the commit and the run that deployed it. */
export interface PreviousDeploy {
  commit: string;
  run: RunHandle | undefined;
}

export interface DeployProvider {
  /** A sentence when the host does not have the commit where the run would start from, else undefined. */
  preflight(ctx: DeployContext, step: DeployRunStep): Promise<string | undefined>;
  start(ctx: DeployContext, step: DeployRunStep): Promise<RunHandle>;
  poll(ctx: DeployContext, step: DeployRunStep, run: RunHandle): Promise<RunProgress>;
  /** Starts the run that deployed `previous` again. Absent: this kind of run cannot go back to an earlier commit. */
  redeploy?(ctx: DeployContext, step: DeployRunStep, previous: PreviousDeploy): Promise<RunHandle>;
}

export type Providers = Record<DeployKind, DeployProvider>;

/** The credentials of a workspace's connections. Each answer is a value or one sentence saying why not. */
export interface DeployCredentials {
  /** The workspace's own git account for a host: the one merge requests and pushes use. */
  git(
    org: string,
    host: string,
    provider: "github" | "gitlab",
  ): Promise<{ token: string } | { problem: string }>;
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
