import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandMeta,
  type ConnectRemote,
  type ConnectRemoteInputSchema,
  DEFAULT_GIT_HOST,
  type GitAuth,
  type MrHost,
  normalizeSshRoute,
  type OrgConfig,
  type ProjectConfig,
  type ProjectCreate,
  type ProjectCreateInputSchema,
  type ProjectPublish,
  type ProjectPublishInputSchema,
  type ProjectView,
  type RemoteConfig,
} from "@majhi/shared";
import type { z } from "zod";
import { UserError } from "../errors.ts";
import { git } from "../git/git.ts";
import { hostNameOf } from "../mrs/remote.ts";
import type { ProjectInfo, RegisterInput, UpdateInput } from "../projects/service.ts";
import { DEFAULT_IDENTITY } from "../runs/checkpoint.ts";
import { classifyHost, parseRemoteUrl } from "../scan/remote.ts";
import { HELPER_MISSING } from "./clone.ts";
import { type CreatedRepo, createRepo } from "./hostRepos.ts";
import { type Fetch, HostUnreachable } from "./http.ts";
import { whoAmI } from "./oauth.ts";
import { checkPlace, projectIdFor, projectPlace } from "./paths.ts";
import { type GitTokens, tokenAuth } from "./tokens.ts";

type Change = { command: string; meta: CommandMeta };

export interface ProjectDeps {
  roots: () => Promise<{ roots: string[]; hostHome: string }>;
  orgs: () => Promise<Record<string, OrgConfig>>;
  /** Project ids and aliases in use. */
  taken: () => Promise<Set<string>>;
  project: (id: string) => Promise<ProjectInfo>;
  register: (input: RegisterInput, change: Change) => Promise<ProjectView>;
  view: (id: string) => Promise<ProjectView>;
  aliases: () => Promise<ReadonlyMap<string, string>>;
  tokens: GitTokens;
  fetch: Fetch;
  hostConnected: () => boolean;
  /** The helper's `git.push` with the workspace's credential. Throws a sentence safe to show. */
  hostPush: (params: {
    path: string;
    url: string;
    branch: string;
    auth: GitAuth;
    setUpstream: boolean;
  }) => Promise<void>;
  /** The helper's `git.lsRemote`. Throws a sentence safe to show. */
  hostLsRemote: (params: {
    url: string;
    auth: GitAuth;
  }) => Promise<{ empty: boolean; defaultBranch?: string | undefined }>;
  /** `git push --set-upstream <remote> <branch>` with the server's own git, for SSH remotes. */
  serverPush: (path: string, remote: string, branch: string) => Promise<void>;
  /** `git fetch <remote>` with the server's own git. Failures are ignored by the caller. */
  serverFetch: (path: string, remote: string) => Promise<void>;
  /** One audit row for a push. */
  audit: (row: { org: string; project: string; ok: boolean; detail: string; meta: CommandMeta }) => void;
}

/** `projects.create`: a new local repo in the workspace's folder, committed and registered. */
export async function createProject(
  deps: ProjectDeps,
  input: z.output<typeof ProjectCreateInputSchema>,
  change: Change,
): Promise<ProjectCreate> {
  const org = (await deps.orgs())[input.org];
  if (org === undefined) throw new UserError(`Workspace "${input.org}" does not exist.`, 404);
  const { roots, hostHome } = await deps.roots();
  const place = projectPlace({ roots, hostHome, root: input.root, org: input.org, folder: input.name });
  const taken = await deps.taken();
  if (input.id !== undefined && taken.has(input.id))
    throw new UserError(`The project id ${input.id} is taken.`, 409);
  const existed = await checkPlace(place);
  const id = input.id ?? projectIdFor(input.name, taken);
  const identity = org.identity ?? DEFAULT_IDENTITY;
  try {
    await mkdir(place.path, { recursive: true });
    await git(place.path, ["init", "--quiet", "-b", "main"]);
    const readme = `# ${input.name}\n${input.description ? `\n${input.description}\n` : ""}`;
    await writeFile(join(place.path, "README.md"), readme);
    await git(place.path, ["add", "README.md"]);
    await git(place.path, ["commit", "--quiet", "--no-verify", "--message", "Initial commit"], {
      env: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      },
    });
    const commit = (await git(place.path, ["rev-parse", "HEAD"])).trim();
    const project = await deps.register(
      { id, org: input.org, path: place.path, aliases: input.aliases ?? [], base: "main" },
      change,
    );
    return { project, commit };
  } catch (err) {
    // Nothing half made is left: majhi made this folder in this call.
    if (existed === "missing") await rm(place.path, { recursive: true, force: true }).catch(() => undefined);
    else await rm(join(place.path, ".git"), { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function remoteNames(path: string): Promise<string[]> {
  return (await git(path, ["remote"])).split("\n").filter((r) => r !== "");
}

/** The branch a project publishes or connects: its base, else what is checked out, else main. */
async function baseOf(project: ProjectInfo): Promise<string> {
  if (project.base !== undefined) return project.base;
  const head = (await git(project.path, ["symbolic-ref", "--short", "HEAD"]).catch(() => "")).trim();
  return head === "" ? "main" : head;
}

async function hasCommit(path: string, branch: string): Promise<boolean> {
  return git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

/** `projects.publish`: makes the remote repo, sets `origin`, pushes the base branch. */
export async function publishProject(
  deps: ProjectDeps,
  input: z.output<typeof ProjectPublishInputSchema>,
  change: Change,
): Promise<ProjectPublish> {
  const project = await deps.project(input.id);
  if (!project.exists) throw new UserError(`${project.path} is not a git repo majhi can see.`, 409);
  if ((await remoteNames(project.path)).includes("origin")) {
    throw new UserError(`${project.id} already has an origin remote. Use it, or remove it first.`, 409);
  }
  const host = input.host ?? DEFAULT_GIT_HOST[input.kind];
  const cred = await deps.tokens.credential(project.org, input.kind, host);
  if (cred.tokenRef === undefined) {
    throw new UserError(`${project.org} is not signed in to ${host}. Sign in first.`, 409);
  }
  const route = cred.ssh === undefined ? undefined : normalizeSshRoute(host, cred.ssh);
  if (route === undefined && !deps.hostConnected()) throw new UserError(HELPER_MISSING, 409);
  const branch = await baseOf(project);
  if (!(await hasCommit(project.path, branch))) {
    throw new UserError(`${project.id} has no commit on ${branch} to push yet.`, 409);
  }
  const name = input.name ?? project.path.split("/").at(-1) ?? project.id;
  const made = await deps.tokens
    .withToken(project.org, input.kind, host, async (token, account) =>
      createRepo(
        deps.fetch,
        input.kind,
        host,
        token,
        account ?? (await whoAmI(deps.fetch, input.kind, host, token)),
        {
          owner: input.owner ?? account ?? (await whoAmI(deps.fetch, input.kind, host, token)),
          name,
          private: input.private,
          description: input.description,
        },
      ),
    )
    .catch((err: unknown) => {
      if (err instanceof HostUnreachable) throw new UserError(err.message, 409);
      throw err;
    });
  if (made.state === "signed-out")
    throw new UserError(`${project.org} is not signed in to ${host}. Sign in first.`, 409);
  if (made.state === "refused") {
    throw new UserError(`${host} refused ${project.org}'s token. Sign in again.`, 409);
  }
  const repo: CreatedRepo = made.value;
  const alias = route === undefined || route === "default" ? undefined : route;
  const url =
    route === undefined ? repo.httpsUrl : `git@${alias ?? host.replace(/:\d+$/, "")}:${repo.fullName}.git`;
  await git(project.path, ["remote", "add", "origin", url]);
  await push(
    deps,
    project,
    { remote: "origin", url, branch, kind: input.kind, tokenRef: cred.tokenRef, ssh: route !== undefined },
    change.meta,
  );
  const view = await deps.view(project.id);
  return {
    project: view,
    remote: { name: "origin", url, fullName: repo.fullName, webUrl: repo.webUrl },
    pushed: branch,
  };
}

async function push(
  deps: ProjectDeps,
  project: ProjectInfo,
  target: {
    remote: string;
    url: string;
    branch: string;
    kind: MrHost;
    tokenRef: string | undefined;
    ssh: boolean;
  },
  meta: CommandMeta,
): Promise<void> {
  try {
    if (target.ssh) {
      await deps.serverPush(project.path, target.remote, target.branch);
    } else {
      const token = target.tokenRef === undefined ? undefined : await deps.tokens.value(target.tokenRef);
      if (token === undefined) throw new UserError(`${project.org}'s token is missing. Sign in again.`, 409);
      await deps.hostPush({
        path: project.path,
        url: target.url,
        branch: target.branch,
        auth: tokenAuth(target.kind, token),
        setUpstream: true,
      });
    }
    deps.audit({ org: project.org, project: project.id, ok: true, detail: target.branch, meta });
  } catch (err) {
    const message = err instanceof Error && !(err instanceof TypeError) ? err.message : "The push failed.";
    deps.audit({ org: project.org, project: project.id, ok: false, detail: message, meta });
    throw err instanceof UserError ? err : new UserError(`The push failed: ${message}`, 409);
  }
}

/** The MR host kind and real host name of a remote URL, with SSH aliases resolved. */
function hostOfUrl(
  url: string,
  aliases: ReadonlyMap<string, string>,
): { kind: MrHost; host: string; ssh: boolean } {
  const address = parseRemoteUrl(url);
  const raw = hostNameOf(url)?.toLowerCase();
  if (raw === undefined) throw new UserError("That is not a git remote URL.");
  const host = aliases.get(raw)?.toLowerCase() ?? raw;
  const kind = classifyHost(host);
  return { kind: kind === "other" ? "gitlab" : kind, host, ssh: address.ssh };
}

/**
 * `projects.connectRemote`: checks the pasted remote with the workspace's credential, adds it, and
 * pushes the base branch only when the remote is empty. A remote with commits is fetched, never
 * pushed to, and never forced.
 */
export async function connectRemote(
  deps: ProjectDeps,
  input: z.output<typeof ConnectRemoteInputSchema>,
  change: Change,
): Promise<ConnectRemote> {
  const project = await deps.project(input.id);
  if (!project.exists) throw new UserError(`${project.path} is not a git repo majhi can see.`, 409);
  const name = input.remote ?? "origin";
  if ((await remoteNames(project.path)).includes(name)) {
    throw new UserError(`${project.id} already has a remote named ${name}. Pick another name.`, 409);
  }
  const at = hostOfUrl(input.url, await deps.aliases());
  let auth: GitAuth = { kind: "ssh" };
  let tokenRef: string | undefined;
  if (!at.ssh) {
    tokenRef = (await deps.tokens.credential(project.org, at.kind, at.host)).tokenRef;
    const token = tokenRef === undefined ? undefined : await deps.tokens.value(tokenRef);
    if (token === undefined)
      throw new UserError(`${project.org} is not signed in to ${at.host}. Sign in first.`, 409);
    auth = tokenAuth(at.kind, token);
  }
  if (!deps.hostConnected()) throw new UserError(HELPER_MISSING, 409);
  const remote = await deps.hostLsRemote({ url: input.url, auth });
  const branch = await baseOf(project);
  await git(project.path, ["remote", "add", name, input.url]);
  if (remote.empty) {
    if (!(await hasCommit(project.path, branch))) {
      throw new UserError(`${project.id} has no commit on ${branch} to push yet.`, 409);
    }
    await push(
      deps,
      project,
      { remote: name, url: input.url, branch, kind: at.kind, tokenRef, ssh: at.ssh },
      change.meta,
    );
    const view = await deps.view(project.id);
    return { state: "pushed", project: view, remote: { name, url: input.url }, pushed: branch };
  }
  await deps.serverFetch(project.path, name).catch(() => undefined);
  const view = await deps.view(project.id);
  const theirs = remote.defaultBranch ?? branch;
  return {
    state: "connected",
    project: view,
    remote: { name, url: input.url },
    ...(remote.defaultBranch === undefined ? {} : { remoteBranch: remote.defaultBranch }),
    detail: `The remote already has commits on ${theirs}. majhi pushed nothing. Start a task to merge the two histories.`,
  };
}
