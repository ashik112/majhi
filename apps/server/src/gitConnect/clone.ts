import { rm } from "node:fs/promises";
import {
  type CloneInputSchema,
  type CloneJob,
  type CloneStart,
  type CommandMeta,
  DEFAULT_GIT_HOST,
  type GitAuth,
  type HostCloneProgress,
  type MrHost,
  normalizeSshRoute,
  type ProjectView,
} from "@majhi/shared";
import type { z } from "zod";
import { UserError } from "../errors.ts";
import type { RegisterInput } from "../projects/service.ts";
import { type CloneRepo, newCloneId } from "./cloneJobs.ts";
import { remoteKey, repoKeyOf } from "./here.ts";
import { checkPlace, isInside, projectIdFor, projectPlace } from "./paths.ts";
import { type GitTokens, tokenAuth } from "./tokens.ts";

/** Progress is written and announced at most this often per job. */
const PROGRESS_EVERY_MS = 500;

export const HELPER_MISSING =
  "The host helper is not running, and cloning needs it. Start majhi's host helper on this computer, then try again.";

export interface CloneDeps {
  repo: CloneRepo;
  /** The workspace roots as written in majhi.yaml, and the home `~` expands to. */
  roots: () => Promise<{ roots: string[]; hostHome: string }>;
  orgExists: (org: string) => Promise<boolean>;
  /** Registered projects, with the URLs of their git remotes. */
  projects: () => Promise<{ id: string; org: string; path: string; aliases: string[]; remotes: string[] }[]>;
  aliases: () => Promise<ReadonlyMap<string, string>>;
  tokens: GitTokens;
  hostConnected: () => boolean;
  /** The host helper's `git.clone`. Throws a sentence safe to show. */
  hostClone: (
    params: { clone: string; url: string; path: string; auth: GitAuth },
    onProgress: (progress: HostCloneProgress) => void,
  ) => Promise<{ head: string; branch: string }>;
  register: (input: RegisterInput, change: { command: string; meta: CommandMeta }) => Promise<ProjectView>;
  /** A job changed. `registered` when a project was added. */
  changed: (registered: boolean) => void;
  now?: () => number;
}

/** A sentence safe to show for anything a clone threw. */
function cloneFailure(err: unknown): string {
  if (err instanceof UserError) return err.message;
  const name = err instanceof Error ? err.constructor.name : "";
  if (name === "HostOfflineError")
    return "The host helper stopped during the clone. Start it and clone again.";
  if (name === "HostJobError" && err instanceof Error) return err.message;
  return "The clone failed. Try again.";
}

/**
 * `projects.clone`: checks the input, the path rule and the refusals on the server, then hands the
 * clone to the host helper with the workspace's own credential, follows its progress, and
 * registers the project when it is done.
 */
export class CloneService {
  constructor(private readonly deps: CloneDeps) {}

  list(clone?: string): CloneJob[] {
    if (clone === undefined) return this.deps.repo.list();
    const job = this.deps.repo.get(clone);
    return job === undefined ? [] : [job];
  }

  async start(
    input: z.output<typeof CloneInputSchema>,
    change: { command: string; meta: CommandMeta },
  ): Promise<CloneStart> {
    if (!(await this.deps.orgExists(input.org)))
      throw new UserError(`Workspace "${input.org}" does not exist.`, 404);
    const host = input.host ?? DEFAULT_GIT_HOST[input.kind];
    const folder = input.folder ?? input.fullName.split("/").at(-1) ?? "";
    const { roots, hostHome } = await this.deps.roots();
    const place = projectPlace({ roots, hostHome, root: input.root, org: input.org, folder });

    const projects = await this.deps.projects();
    const aliases = await this.deps.aliases();
    const key = repoKeyOf(host, input.fullName);
    const already = projects.find((p) => p.remotes.some((url) => remoteKey(url, aliases) === key));
    if (already !== undefined) {
      throw new UserError(`${input.fullName} is already the project ${already.id}, at ${already.path}.`, 409);
    }
    const taken = new Set(projects.flatMap((p) => [p.id, ...p.aliases]));
    if (input.id !== undefined && taken.has(input.id)) {
      throw new UserError(`The project id ${input.id} is taken. Pick another.`, 409);
    }
    for (const job of this.deps.repo.running()) {
      if (job.path === place.path) throw new UserError(`A clone into ${place.path} is already running.`, 409);
      if (repoKeyOf(job.host, job.fullName) === key) {
        throw new UserError(`${input.fullName} is already being cloned.`, 409);
      }
    }
    const existed = await checkPlace(place);

    const cred = await this.deps.tokens.credential(input.org, input.kind, host);
    const route = cred.ssh === undefined ? undefined : normalizeSshRoute(host, cred.ssh);
    const via = input.via ?? (route !== undefined ? "ssh" : "https");
    let url: string;
    let sshAlias: string | undefined;
    if (via === "ssh") {
      if (route === undefined) {
        throw new UserError(
          `${input.org} has no SSH key for ${host}. Clone over https after signing in, or set an SSH route in the workspace's git accounts.`,
          409,
        );
      }
      sshAlias = route === "default" ? undefined : route;
      url = `git@${sshAlias ?? host.replace(/:\d+$/, "")}:${input.fullName}.git`;
    } else {
      if (cred.tokenRef === undefined) {
        throw new UserError(`${input.org} is not signed in to ${host}. Sign in first.`, 409);
      }
      url = `https://${host}/${input.fullName}.git`;
    }
    if (!this.deps.hostConnected()) throw new UserError(HELPER_MISSING, 409);

    const id = input.id ?? projectIdFor(folder, taken);
    const job = this.deps.repo.insert({
      id: newCloneId(),
      org: input.org,
      kind: input.kind,
      host,
      fullName: input.fullName,
      root: place.root,
      path: place.path,
      project: id,
      createdFolder: existed === "missing",
    });
    this.deps.changed(false);
    void this.run(job.clone, {
      kind: input.kind,
      url,
      via,
      tokenRef: cred.tokenRef,
      register: {
        id,
        org: input.org,
        path: place.path,
        aliases: input.aliases ?? [],
      },
      root: place.root,
      createdFolder: existed === "missing",
      change,
    });
    return { clone: job.clone, path: place.path, project: id };
  }

  private async run(
    clone: string,
    job: {
      kind: MrHost;
      url: string;
      via: "ssh" | "https";
      tokenRef: string | undefined;
      register: Omit<RegisterInput, "base">;
      root: string;
      createdFolder: boolean;
      change: { command: string; meta: CommandMeta };
    },
  ): Promise<void> {
    const now = this.deps.now ?? Date.now;
    let cloned = false;
    try {
      let auth: GitAuth = { kind: "ssh" };
      if (job.via === "https") {
        const token = job.tokenRef === undefined ? undefined : await this.deps.tokens.value(job.tokenRef);
        if (token === undefined) throw new UserError("The workspace's token is missing. Sign in again.");
        auth = tokenAuth(job.kind, token);
      }
      if (!isInside(job.root, job.register.path))
        throw new UserError("That folder is outside the project folder.");
      let last = 0;
      const result = await this.deps.hostClone(
        { clone, url: job.url, path: job.register.path, auth },
        (progress) => {
          const at = now();
          if (at - last < PROGRESS_EVERY_MS && progress.percent !== 100) return;
          last = at;
          this.deps.repo.progress(clone, progress.phase, progress.percent);
          this.deps.changed(false);
        },
      );
      cloned = true;
      this.deps.repo.registering(clone);
      this.deps.changed(false);
      await this.deps.register({ ...job.register, base: result.branch }, job.change);
      this.deps.repo.done(clone, result.branch);
      this.deps.changed(true);
    } catch (err) {
      // A clone that could not be registered is removed, so a failed job leaves no folder behind.
      if (cloned && job.createdFolder && isInside(job.root, job.register.path)) {
        await rm(job.register.path, { recursive: true, force: true }).catch(() => undefined);
      }
      this.deps.repo.failed(clone, cloneFailure(err));
      this.deps.changed(false);
    }
  }
}
