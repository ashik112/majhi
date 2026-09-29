import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { HostLink } from "../host/link.ts";
import type { LinkOptions } from "../tasks/links.ts";
import { git } from "./fixtures.ts";
import { type Harness, harness } from "./harness.ts";

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
}

/**
 * An acme org with a login account and a Builder agent (`acme-builder`, perms edit and shell),
 * and one registered project `acme-api` (alias `api`) with a `develop` branch and a bare remote.
 * Git runs without the machine's own config.
 */
export async function taskWorld(options: WorldOptions = {}): Promise<World> {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const h = await harness({
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.hostLink === undefined ? {} : { hostLink: options.hostLink }),
  });
  const world: World = {
    h,
    repo: (name) => join(h.dir, "Work", name),
    remote: (name) => join(h.dir, "remotes", `${name}.git`),
    async addRepo(name) {
      const path = world.repo(name);
      const remote = world.remote(name);
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
      return path;
    },
    taskDir: (id) => join(h.dir, "Work", ".majhi", id),
    cleanup: async () => {
      await h.majhi.services.runs.closeAll();
      await h.majhi.services.runs.idle();
      vi.unstubAllEnvs();
      await h.cleanup();
    },
  };
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

function must(res: { status: number; body: unknown }): void {
  if (res.status !== 200) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
}
