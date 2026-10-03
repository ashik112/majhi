import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { zoneOr } from "../autonomy/service.ts";
import type { ConfigService } from "../config/service.ts";
import { git } from "../git/git.ts";
import type { HostLink } from "../host/link.ts";
import type { ProjectService } from "../projects/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import type { UploadStore } from "../uploads/store.ts";
import { E2eRepo } from "./repo.ts";
import { E2eService } from "./service.ts";

export interface E2eWiring {
  store: Store;
  config: ConfigService;
  projects: ProjectService;
  hostLink: HostLink;
  room: RoomService;
  tasks: Pick<TaskService, "create">;
  uploads: UploadStore;
  majhiHome: string;
  log?: (message: string) => void;
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const out = (await git(cwd, args)).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** The real pieces behind the background e2e service: git, the host link, rooms, tasks and uploads. */
export function createE2e(w: E2eWiring): E2eService {
  const tracesDir = join(w.majhiHome, "e2e", "traces");
  return new E2eService({
    repo: new E2eRepo(w.store.raw),
    host: w.hostLink,
    projects: async () =>
      (await w.projects.infos()).map((p) => ({
        id: p.id,
        org: p.org,
        path: p.path,
        base: p.base,
        exists: p.exists,
      })),
    settings: async () => {
      const settings = await w.config.settings();
      // The owner's zone is autonomous mode's, as for its daily summary.
      return {
        projects: settings.e2e.projects,
        dailyAt: settings.e2e.daily_at,
        tz: zoneOr(settings.autonomy.tz),
      };
    },
    git: {
      tip: (path, branch) =>
        tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]),
      subject: (path, commit) => tryGit(path, ["log", "-1", "--format=%s", commit]),
      between: async (path, from, to, limit) =>
        (await tryGit(path, ["log", `--max-count=${limit}`, "--format=%h %s", `${from}..${to}`]))?.split(
          "\n",
        ) ?? [],
    },
    say: (task, id, level, text) =>
      w.room.post(task, `${id}:${randomUUID()}`, { type: "system", level, text }),
    taskExists: (id) => w.store.tasks.get(id) !== undefined,
    createTask: async ({ project, title, text, attachments }) => {
      const task = await w.tasks.create({
        title,
        text,
        repos: [{ project }],
        kind: "code",
        attachments,
        start: false,
      });
      return { id: task.id };
    },
    uploadTrace: async (file) => {
      // The helper wrote the file in the majhi folder. Only a plain file under e2e/traces goes in.
      const path = resolve(w.majhiHome, file);
      const inside = relative(tracesDir, path);
      if (inside === "" || inside.startsWith("..") || inside.startsWith(sep) || !path.endsWith(".zip"))
        return undefined;
      const stat = await lstat(path);
      if (!stat.isFile()) return undefined;
      const saved = await w.uploads.save({
        name: basename(path),
        mime: "application/zip",
        data: await readFile(path),
      });
      return saved.id;
    },
    newId: randomUUID,
    now: () => new Date(),
    log: w.log ?? (() => undefined),
  });
}
