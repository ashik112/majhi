import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { RemoteRunFn } from "../connections/remote.ts";
import type { ContainerDocker } from "../containers/service.ts";
import type { HostLink } from "../host/link.ts";
import type { MrHostOptions } from "../mrs/hosts/index.ts";
import type { Probe } from "../runs/network.ts";
import type { LinkOptions } from "../tasks/links.ts";
import { git, tempDir } from "./fixtures.ts";
import { type Harness, type HarnessOptions, harness, harnessOver } from "./harness.ts";
import { copyTemplate } from "./template.ts";

export interface World {
  h: Harness;
  /** `<home>/Work/<name>`. */
  repo(name: string): string;
  /** The bare remote of a repo made by `addRepo`. */
  remote(name: string): string;
  /** Makes a repo with `main` and `develop`, and a bare remote, under the workspace root. */
  addRepo(name: string): Promise<string>;
  /** `<tasks dir>/<task id>`. */
  taskDir(id: string): string;
  cleanup(): Promise<void>;
}

export interface WorldOptions {
  /** Agent frontmatter overrides for `acme-builder`. */
  agent?: Record<string, unknown>;
  /** Skip the agent, to test tasks with nobody to run them. */
  noAgent?: boolean;
  links?: LinkOptions;
  hostLink?: HostLink;
  probe?: Probe;
  runClock?: () => Date;
  mrHosts?: MrHostOptions;
  containerDocker?: ContainerDocker;
  connectionsRemote?: RemoteRunFn;
  idleWatchMs?: number;
  /** Replaces `fetch` for git sign-in and the git hosts' APIs. */
  gitFetch?: typeof fetch;
  skillsCommand?: HarnessOptions["skillsCommand"];
  skillsFetch?: HarnessOptions["skillsFetch"];
  mcpFetch?: HarnessOptions["mcpFetch"];
  connectCatalog?: HarnessOptions["connectCatalog"];
  opsProbes?: HarnessOptions["opsProbes"];
  ntfyFetch?: HarnessOptions["ntfyFetch"];
}

/**
 * An acme org with a login account and a Builder agent (`acme-builder`, perms edit and shell),
 * and one registered project `acme-api` (alias `api`) with a `develop` branch and a bare remote.
 * Git runs without the machine's own config.
 */
export async function taskWorld(options: WorldOptions = {}): Promise<World> {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  // The setup (org, account, agent, repo, project) is the same for every test with the same agent
  // options, so it is built once per run and copied (`template.ts`).
  const setup = {
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.noAgent === undefined ? {} : { noAgent: options.noAgent }),
  };
  const { dir, cleanup } = await tempDir();
  await copyTemplate(JSON.stringify(setup), dir, async () => {
    const built = await freshWorld(setup);
    await built.h.majhi.close();
    return { dir: built.h.dir, patch: [join("Work", "api", ".git", "config")] };
  });
  const h = harnessOver(dir, cleanup, harnessOptionsOf(options));
  // Registering the project writes its card in the background, and some tests wait for it. The template
  // has none (its paths would be the template's), so each world starts it, as registering did.
  h.majhi.services.cards.onRegistered("acme-api");
  return worldOver(h);
}

function harnessOptionsOf(options: WorldOptions): HarnessOptions {
  return {
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.hostLink === undefined ? {} : { hostLink: options.hostLink }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    ...(options.runClock === undefined ? {} : { runClock: options.runClock }),
    ...(options.mrHosts === undefined ? {} : { mrHosts: options.mrHosts }),
    ...(options.containerDocker === undefined ? {} : { containerDocker: options.containerDocker }),
    ...(options.connectionsRemote === undefined ? {} : { connectionsRemote: options.connectionsRemote }),
    ...(options.idleWatchMs === undefined ? {} : { idleWatchMs: options.idleWatchMs }),
    ...(options.gitFetch === undefined ? {} : { gitFetch: options.gitFetch }),
    ...(options.skillsCommand === undefined ? {} : { skillsCommand: options.skillsCommand }),
    ...(options.skillsFetch === undefined ? {} : { skillsFetch: options.skillsFetch }),
    ...(options.mcpFetch === undefined ? {} : { mcpFetch: options.mcpFetch }),
    ...(options.connectCatalog === undefined ? {} : { connectCatalog: options.connectCatalog }),
    ...(options.opsProbes === undefined ? {} : { opsProbes: options.opsProbes }),
    ...(options.ntfyFetch === undefined ? {} : { ntfyFetch: options.ntfyFetch }),
  };
}

function worldOver(h: Harness): World {
  const world: World = {
    h,
    repo: (name) => join(h.dir, "Work", name),
    remote: (name) => join(h.dir, "remotes", `${name}.git`),
    async addRepo(name) {
      // The same repo every time for a name, so it is made once per run and copied.
      await copyTemplate(`repo:${name}`, h.dir, async () => {
        const { dir } = await tempDir();
        await makeSampleRepo(dir, name);
        return { dir, patch: [join("Work", name, ".git", "config")] };
      });
      return world.repo(name);
    },
    taskDir: (id) => join(h.dir, "Work", ".majhi", id),
    cleanup: async () => {
      await h.majhi.services.runs.closeAll();
      await h.majhi.services.runs.idle();
      vi.unstubAllEnvs();
      await h.cleanup();
    },
  };
  return world;
}

/** The setup itself, run for real: what a template is a copy of. */
async function freshWorld(options: Pick<WorldOptions, "agent" | "noAgent">): Promise<World> {
  const h = await harness();
  const world = worldOver(h);
  // Registering a project starts its card in the background (a scan of the repo, and gaps written to the
  // findings). Not here: the card names this folder, so each world made from the template starts its own.
  h.majhi.services.cards.onRegistered = () => undefined;
  must(await h.cmd("orgs.create", { id: "acme", name: "Acme", key: "ACM" }));
  must(await h.cmd("accounts.create", { id: "claude-acme", tool: "claude", org: "acme", auth: "login" }));
  if (options.noAgent !== true) {
    must(
      await h.cmd("agents.create", {
        id: "acme-builder",
        frontmatter: {
          scope: "acme",
          role: "Builder",
          account: "claude-acme",
          model: "sonnet",
          effort: "high",
          perms: ["edit", "shell"],
          ...options.agent,
        },
        instructions: "Build things.\n",
      }),
    );
  }
  await world.addRepo("api");
  must(
    await h.cmd("projects.register", { id: "acme-api", org: "acme", path: "~/Work/api", aliases: ["api"] }),
  );
  return world;
}

/** `<home>/Work/<name>` with `main` and `develop`, and its bare remote `<home>/remotes/<name>.git`. */
async function makeSampleRepo(home: string, name: string): Promise<void> {
  const path = join(home, "Work", name);
  const remote = join(home, "remotes", `${name}.git`);
  await mkdir(remote, { recursive: true });
  await git(remote, "init", "--bare", "--quiet", "--initial-branch=main");
  await mkdir(path, { recursive: true });
  await git(path, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(path, "README.md"), `# ${name}\n`);
  await git(path, "add", ".");
  await git(path, "commit", "--quiet", "-m", "init");
  await git(path, "remote", "add", "origin", remote);
  await git(path, "branch", "develop");
  await git(path, "push", "--quiet", "origin", "main", "develop");
  await git(path, "remote", "set-head", "origin", "main");
}

function must(res: { status: number; body: unknown }): void {
  if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
}
