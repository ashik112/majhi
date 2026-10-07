import type { DeploySuggestion, DeployTarget } from "@majhi/shared";
import { parse } from "yaml";
import type { RepoFiles } from "../projectcard/files.ts";

/**
 * Deploy targets found in a project, offered to the owner to confirm. Read from the repo's files and the
 * workspace's connections each time, never stored: a suggestion the owner hid is only remembered by its id.
 * Nothing here writes a command: an ssh host is offered with its command left for the owner to write.
 */

export interface SuggestDeps {
  files(path: string): RepoFiles;
  /** The workspace's own connections, as far as a deploy cares. */
  connections(
    org: string,
  ): Promise<{ id: string; type: string; provider?: string | undefined; vercel: boolean }[]>;
  /** The workspace's watches that look at an address. */
  watches(org: string): Promise<{ id: string; name: string; url?: string | undefined }[]>;
}

export interface SuggestProject {
  id: string;
  org: string;
  path: string;
  /** The host of the project's remote, when it is one a deploy can use. */
  provider: "github" | "gitlab" | "bitbucket" | undefined;
}

const WAIT = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a workflow can be started by hand: `on` is `workflow_dispatch`, a list holding it, or a map with it. */
function hasDispatch(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  const on = doc.on;
  if (on === "workflow_dispatch") return true;
  if (Array.isArray(on)) return on.includes("workflow_dispatch");
  return isRecord(on) && Object.hasOwn(on, "workflow_dispatch");
}

/** The environments a suggestion may take, in the order they go live. */
const ENVS = ["staging", "production"] as const;

function envFor(label: string, taken: ReadonlySet<string>): string {
  const lower = label.toLowerCase();
  const named = lower.includes("prod") ? "production" : lower.includes("stag") ? "staging" : undefined;
  if (named !== undefined && !taken.has(named)) return named;
  return ENVS.find((e) => !taken.has(e)) ?? `env-${taken.size + 1}`;
}

export async function suggestDeploys(
  project: SuggestProject,
  hidden: readonly string[],
  deps: SuggestDeps,
  existing: readonly DeployTarget[],
): Promise<DeploySuggestion[]> {
  const out: DeploySuggestion[] = [];
  const files = deps.files(project.path);
  const [connections, watches] = await Promise.all([
    deps.connections(project.org),
    deps.watches(project.org),
  ]);
  const taken = new Set(existing.map((t) => t.env));
  const watchFor = (env: string) => {
    const lower = env.toLowerCase();
    return watches.find(
      (w) => w.name.toLowerCase().includes(lower) || (w.url ?? "").toLowerCase().includes(lower),
    );
  };
  const complete = (
    env: string,
    via: DeployTarget["via"],
    watch: string | undefined,
  ): { target?: DeployTarget; needs?: string } =>
    watch === undefined
      ? { needs: "A health address or a watch" }
      : {
          target: { env, via, verify: { watch, waitSeconds: WAIT }, rollback: { kind: "redeploy-previous" } },
        };

  if (project.provider === "github") {
    const github = connections.find((c) => c.type === "git" && c.provider === "github");
    const listed = (await files.list(".github/workflows")).filter(
      (e) => !e.dir && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")),
    );
    const found: { file: string; name: string }[] = [];
    for (const entry of listed.sort((a, b) => a.name.localeCompare(b.name))) {
      const text = await files.read(`.github/workflows/${entry.name}`);
      if (text === undefined) continue;
      let doc: unknown;
      try {
        doc = parse(text);
      } catch {
        continue;
      }
      if (!hasDispatch(doc)) continue;
      found.push({
        file: entry.name,
        name: isRecord(doc) && typeof doc.name === "string" ? doc.name : entry.name,
      });
    }
    // The workflows that read like a deploy come first; the order only decides what is shown first.
    const rank = (f: { file: string; name: string }) =>
      `${f.file} ${f.name}`.toLowerCase().includes("deploy") ||
      `${f.file} ${f.name}`.toLowerCase().includes("release")
        ? 0
        : 1;
    for (const wf of found.sort((a, b) => rank(a) - rank(b))) {
      const id = `github-workflow:${wf.file}`;
      if (
        hidden.includes(id) ||
        existing.some((t) => t.via.kind === "github-workflow" && t.via.workflow === wf.file)
      ) {
        continue;
      }
      const env = envFor(`${wf.file} ${wf.name}`, taken);
      taken.add(env);
      const watch = watchFor(env);
      const via =
        github === undefined
          ? undefined
          : ({ kind: "github-workflow", connection: github.id, workflow: wf.file, ref: "base" } as const);
      out.push({
        id,
        env,
        kind: "github-workflow",
        found: `.github/workflows/${wf.file}`,
        because: "has workflow_dispatch",
        ...(github === undefined
          ? { needs: "A GitHub connection for this workspace" }
          : { connection: github.id }),
        workflow: wf.file,
        ...(watch === undefined ? {} : { watch: watch.id }),
        ...(via === undefined ? {} : complete(env, via, watch?.id)),
      });
    }
  }

  if (project.provider === "gitlab" && (await files.read(".gitlab-ci.yml")) !== undefined) {
    const id = "gitlab-pipeline:.gitlab-ci.yml";
    const gitlab = connections.find((c) => c.type === "git" && c.provider === "gitlab");
    if (!hidden.includes(id) && !existing.some((t) => t.via.kind === "gitlab-pipeline")) {
      const env = envFor("", taken);
      taken.add(env);
      const watch = watchFor(env);
      out.push({
        id,
        env,
        kind: "gitlab-pipeline",
        found: ".gitlab-ci.yml",
        because: "runs a pipeline on the base branch",
        ...(gitlab === undefined
          ? { needs: "A GitLab connection for this workspace" }
          : { connection: gitlab.id }),
        ...(watch === undefined ? {} : { watch: watch.id }),
      });
    }
  }

  const vercelJson = await files.read("vercel.json");
  if (vercelJson !== undefined && project.provider === "github") {
    const id = "vercel:vercel.json";
    const holder = connections.find((c) => c.type === "env" && c.vercel);
    if (!hidden.includes(id) && !existing.some((t) => t.via.kind === "vercel")) {
      let name = project.id;
      try {
        const doc: unknown = JSON.parse(vercelJson);
        if (isRecord(doc) && typeof doc.name === "string" && doc.name !== "") name = doc.name;
      } catch {
        // A vercel.json that does not parse still says the project is on Vercel.
      }
      const env = envFor("production", taken);
      taken.add(env);
      const watch = watchFor(env);
      const via =
        holder === undefined
          ? undefined
          : ({ kind: "vercel", connection: holder.id, project: name, target: "production" } as const);
      out.push({
        id,
        env,
        kind: "vercel",
        found: "vercel.json",
        because: "is deployed on Vercel",
        ...(holder === undefined
          ? { needs: "A variables connection that holds VERCEL_TOKEN" }
          : { connection: holder.id }),
        project: name,
        ...(watch === undefined ? {} : { watch: watch.id }),
        ...(via === undefined ? {} : complete(env, via, watch?.id)),
      });
    }
  }

  const compose = (await files.list("")).find(
    (e) =>
      !e.dir &&
      (e.name.startsWith("docker-compose") || e.name.startsWith("compose")) &&
      (e.name.endsWith(".yml") || e.name.endsWith(".yaml")),
  );
  const host = connections.find((c) => c.type === "ssh");
  if (compose !== undefined && host !== undefined) {
    const id = `ssh:${compose.name}`;
    if (!hidden.includes(id) && !existing.some((t) => t.via.kind === "ssh")) {
      const env = envFor("", taken);
      taken.add(env);
      out.push({
        id,
        env,
        kind: "ssh",
        found: compose.name,
        because: "describes a stack a host could run",
        connection: host.id,
        needs: "The command to run on the host",
      });
    }
  }
  return out;
}
