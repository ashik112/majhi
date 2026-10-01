import { basename } from "node:path";
import type {
  ContainerInfo,
  ContainersSettings,
  PreviewBuildInput,
  PreviewRunInput,
  ProcessContainer,
  ProcessInfo,
  ServiceStartInput,
  StoppedBy,
  Task,
} from "@majhi/shared";
import { sameImage } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { ProcessManager } from "../processes/manager.ts";
import {
  buildArgs,
  builderCreateArgs,
  type HostPaths,
  type Limits,
  networkCreateArgs,
  previewRunArgs,
  type Safety,
  serviceRunArgs,
  volumeCreateArgs,
} from "./args.ts";
import type { DockerCli } from "./docker.ts";
import { containerNames } from "./names.ts";

export const NOT_IN_DOCKER = "Containers need majhi running in Docker.";

/** The docker calls the service makes. A test gives it a fake. */
export type ContainerDocker = Pick<DockerCli, "exec" | "connect" | "create" | "attached">;

export interface ContainerServiceDeps {
  /** Absent when majhi does not run in Docker: every call then says so. */
  docker: ContainerDocker | undefined;
  processes: ProcessManager;
  task: (id: string) => Task | undefined;
  /** Ids of the tasks that are not done. Volumes, builders and images of these survive a restart. */
  openTasks: () => string[];
  settings: () => Promise<ContainersSettings>;
  /** The network runners are on. A preview joins it. */
  runnerNetwork: string;
  paths: HostPaths;
  /** Tells the Hub that the list of containers changed. */
  changed?: () => void;
  /** How long a preview gets to show its port on the host, in ms. */
  portWaitMs?: number;
}

/** What `serviceStart` did: started it, or asked the owner for the image first. */
export type ServiceStartResult = { status: "started"; container: ContainerInfo } | { status: "asked" };

/** Asks for an image the owner has not allowed yet, through an approval card. */
export type AskImage = (image: string) => Promise<"allowed" | "pending">;

const PORT_POLL_MS = 400;
/** The runner containers of a task are found by these labels. */
const RUNNER_LABEL = "label=majhi.runner=1";

/**
 * The containers majhi runs for agents (PRV-53). Each is a majhi process in `ProcessManager`, so the
 * Processes card, `majhi-processes output`, Stop, waking the agent when a build ends and stopping with
 * the task all come from the code that exists. This class decides what may run, builds the docker
 * calls with `args.ts`, and cleans up by label.
 */
export class ContainerService {
  private readonly docker: ContainerDocker | undefined;
  /** Tasks whose network exists. */
  private readonly networks = new Set<string>();
  /** Looking up the host port of a preview, by container name. */
  private readonly lookups = new Map<string, Promise<void>>();
  /** One start at a time per task, so the limit and the names are checked on the truth. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** The startup cleanup. A start waits for it, so the cleanup cannot sweep away what a start made. */
  private starting: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ContainerServiceDeps) {
    this.docker = deps.docker;
  }

  available(): boolean {
    return this.docker !== undefined;
  }

  reason(): string | undefined {
    return this.docker === undefined ? NOT_IN_DOCKER : undefined;
  }

  /** The networks a run of this task joins when it starts: the task's own, once it has services. */
  taskNetworks(task: string): string[] {
    return this.networks.has(task) ? [containerNames(task).network] : [];
  }

  // ---------------------------------------------------------------------------
  // Preview

  /** Builds the image of a task repo as its preview. Returns at once; the agent is woken when the build ends. */
  async previewBuild(task: string, agent: string, input: PreviewBuildInput): Promise<ProcessInfo> {
    const docker = this.need();
    const t = this.task(task);
    const names = containerNames(task);
    const settings = await this.deps.settings();
    await this.starting;
    return this.locked(task, async () => {
      const building = this.all(task).find((p) => p.container?.kind === "build" && p.status === "running");
      if (building !== undefined) {
        throw new UserError(
          `${building.id} is already building the preview. Wait for it to end, or stop it.`,
          409,
        );
      }
      const context = this.repoFolder(t, input.repo);
      const safety = this.safety(t);
      // Checked before anything starts, so a refusal reads clearly.
      const parts = buildArgs(safety, {
        context,
        dockerfile: input.dockerfile,
        target: input.target,
        buildArgs: input.build_args,
      });
      await this.ensureBuilder(docker, safety, settings);
      const info = await this.deps.processes.start({
        task,
        agent,
        name: "preview build",
        command: `docker buildx build ${names.previewImage}`,
        cwd: t.folder,
        wait: true,
        managed: {
          container: { kind: "build", name: "preview build", image: names.previewImage },
          spawn: () => docker.attached(parts, safety, { cwd: context }),
        },
      });
      this.deps.changed?.();
      return info;
    });
  }

  /** Runs the built preview image on a free port of the host, on the runner network. */
  async previewRun(task: string, agent: string, input: PreviewRunInput): Promise<ContainerInfo> {
    const docker = this.need();
    const t = this.task(task);
    const names = containerNames(task);
    const settings = await this.deps.settings();
    await this.starting;
    return this.locked(task, async () => {
      try {
        await docker.exec(["image", "inspect", names.previewImage]);
      } catch {
        throw new UserError("There is no preview image yet. Build it first with preview_build.");
      }
      const old = this.running(task, "preview", "preview");
      if (old !== undefined) await this.deps.processes.stop(task, old.id, "agent");
      this.checkLimit(task, settings);
      const safety = this.safety(t);
      const parts = previewRunArgs(safety, limitsOf(settings), {
        port: input.port,
        env: input.env,
        command: input.command,
        scratch: input.scratch,
        taskNetwork: this.networks.has(task),
      });
      const url = `http://${names.previewContainer}:${input.port}`;
      const container: ProcessContainer = {
        kind: "preview",
        name: "preview",
        image: names.previewImage,
        url,
      };
      const info = await this.deps.processes.start({
        task,
        agent,
        name: "preview",
        command: `docker run ${names.previewImage}`,
        cwd: t.folder,
        wait: false,
        managed: {
          container,
          spawn: async (ctx) => {
            const spawned = await docker.attached(parts, safety, { cwd: t.folder });
            const lookup = this.lookupHostPort(
              docker,
              names.previewContainer,
              input.port,
              spawned.child,
            ).then((hostPort) => {
              if (hostPort !== undefined) ctx.update({ hostUrl: `http://127.0.0.1:${hostPort}` });
            });
            this.lookups.set(names.previewContainer, lookup);
            return spawned;
          },
        },
      });
      await this.lookups.get(names.previewContainer);
      const now = this.deps.processes.get(task, info.id);
      if (now === undefined || now.status !== "running") {
        const tail = (now?.tail ?? []).slice(-8).join("\n");
        throw new UserError(`The preview did not stay up.${tail === "" ? "" : `\n${tail}`}`);
      }
      this.deps.changed?.();
      return this.infoOf(now) as ContainerInfo;
    });
  }

  // ---------------------------------------------------------------------------
  // Services

  /**
   * Starts a service container on the task's network. An image the owner has not allowed asks
   * through `ask` (an approval card) and answers `asked`; without `ask` it is refused.
   */
  async serviceStart(
    task: string,
    agent: string,
    input: ServiceStartInput,
    ask?: AskImage,
  ): Promise<ServiceStartResult> {
    const docker = this.need();
    const t = this.task(task);
    let settings = await this.deps.settings();
    if (!settings.images.some((image) => sameImage(image, input.image))) {
      if (ask === undefined) {
        throw new UserError(
          `${input.image} is not allowed yet. Allow it first with containers.images.allow, then start the service.`,
        );
      }
      if ((await ask(input.image)) === "pending") return { status: "asked" };
      settings = await this.deps.settings();
      if (!settings.images.some((image) => sameImage(image, input.image))) {
        throw new UserError(`${input.image} is not allowed.`);
      }
    }
    const names = containerNames(task);
    await this.starting;
    return this.locked(task, async () => {
      if (this.running(task, "service", input.name) !== undefined) {
        throw new UserError(
          `A service ${input.name} already runs in ${task}. Stop it first, or pick another name.`,
          409,
        );
      }
      this.checkLimit(task, settings);
      const safety = this.safety(t);
      const limits = limitsOf(settings);
      // Checked before the network and the volumes exist.
      const parts = serviceRunArgs(safety, limits, {
        name: input.name,
        image: input.image,
        env: input.env,
        command: input.command,
        volumes: input.volumes,
      });
      await this.ensureNetwork(docker, safety);
      for (const volume of input.volumes ?? []) await this.ensureVolume(docker, safety, volume.name);
      const container: ProcessContainer = {
        kind: "service",
        name: input.name,
        image: input.image,
        ...(input.port === undefined ? {} : { url: `${input.name}:${input.port}` }),
      };
      const info = await this.deps.processes.start({
        task,
        agent,
        name: `service ${input.name}`,
        command: `docker run ${names.service(input.name)}`,
        cwd: t.folder,
        wait: false,
        managed: { container, spawn: () => docker.attached(parts, safety, { cwd: t.folder }) },
      });
      this.deps.changed?.();
      return { status: "started" as const, container: this.infoOf(info) as ContainerInfo };
    });
  }

  // ---------------------------------------------------------------------------
  // Stop, list, logs

  /** Stops the preview (`preview`) or a service. An ended one is returned as it is. */
  async stop(task: string, name: string, by: StoppedBy): Promise<ContainerInfo> {
    this.need();
    this.task(task);
    const found = this.latest(task, name);
    if (found === undefined)
      throw new UserError(
        `There is no ${name === "preview" ? "preview" : `service ${name}`} in ${task}.`,
        404,
      );
    const info = await this.deps.processes.stop(task, found.id, by);
    this.deps.changed?.();
    return this.infoOf(info) as ContainerInfo;
  }

  /** Previews and services, running and recently ended, of one task or of all. */
  list(task?: string): ContainerInfo[] {
    const all = task === undefined ? this.deps.processes.listAll() : this.all(task);
    return all.flatMap((p) => this.infoOf(p) ?? []);
  }

  /** The last lines of a container's output. */
  logs(task: string, name: string, lines: number): { container: ContainerInfo; lines: string[] } {
    const found = this.latest(task, name);
    if (found === undefined)
      throw new UserError(
        `There is no ${name === "preview" ? "preview" : `service ${name}`} in ${task}.`,
        404,
      );
    return {
      container: this.infoOf(found) as ContainerInfo,
      lines: this.deps.processes.output(task, found.id, lines),
    };
  }

  // ---------------------------------------------------------------------------
  // Cleanup

  /**
   * The task stopped (stop, close, remove): its containers and network go. Volumes stay, so a
   * paused task keeps its test data. Call after the task's processes were stopped.
   */
  async taskStopped(task: string): Promise<void> {
    const docker = this.docker;
    if (docker === undefined) return;
    const names = containerNames(task);
    await this.quietly(async () => {
      const ids = await this.lines(docker, [
        "ps",
        "-aq",
        "--filter",
        "label=majhi.container",
        "--filter",
        `label=majhi.task=${task}`,
      ]);
      if (ids.length > 0) await docker.exec(["rm", "-f", "-v", ...ids]);
    });
    await this.quietly(() => this.removeNetwork(docker, names.network));
    // A paused task leaves nothing running: the builder stops, and the next build starts it again.
    await this.stopBuilder(docker, names.builder);
    this.networks.delete(task);
    this.deps.changed?.();
  }

  /** The task is done or removed: everything of it goes, volumes, builder and preview image too. */
  async taskEnded(task: string): Promise<void> {
    await this.taskStopped(task);
    const docker = this.docker;
    if (docker === undefined) return;
    const names = containerNames(task);
    await this.quietly(async () => {
      const volumes = await this.lines(docker, [
        "volume",
        "ls",
        "-q",
        "--filter",
        "label=majhi.container=volume",
        "--filter",
        `label=majhi.task=${task}`,
      ]);
      if (volumes.length > 0) await docker.exec(["volume", "rm", "-f", ...volumes]);
    });
    await this.quietly(() => docker.exec(["buildx", "rm", "--force", names.builder]));
    await this.quietly(() => docker.exec(["image", "rm", "-f", names.previewImage]));
  }

  /**
   * At startup: containers and networks a previous majhi left go, and the volumes, builders and
   * preview images of tasks that are done or gone. Those of open tasks stay.
   */
  startup(): Promise<void> {
    const cleaning = this.cleanAtStart();
    // A failed cleanup is the caller's to report; it must not block the starts that wait for it.
    this.starting = cleaning.catch(() => undefined);
    return cleaning;
  }

  private async cleanAtStart(): Promise<void> {
    const docker = this.docker;
    if (docker === undefined) return;
    const open = new Set(this.deps.openTasks());
    await this.quietly(async () => {
      const ids = await this.lines(docker, ["ps", "-aq", "--filter", "label=majhi.container"]);
      if (ids.length > 0) await docker.exec(["rm", "-f", "-v", ...ids]);
    });
    await this.quietly(async () => {
      const networks = await this.lines(docker, [
        "network",
        "ls",
        "--filter",
        "label=majhi.container=network",
        "--format",
        "{{.Name}}",
      ]);
      for (const network of networks) await this.quietly(() => this.removeNetwork(docker, network));
    });
    await this.quietly(async () => {
      const rows = await this.lines(docker, [
        "volume",
        "ls",
        "--filter",
        "label=majhi.container=volume",
        "--format",
        '{{.Label "majhi.task"}} {{.Name}}',
      ]);
      const gone = rows.flatMap((row) => {
        const [task, name] = row.split(" ");
        return task !== undefined && name !== undefined && !open.has(task) ? [name] : [];
      });
      if (gone.length > 0) await docker.exec(["volume", "rm", "-f", ...gone]);
    });
    const openKeys = new Set([...open].map((id) => id.toLowerCase()));
    const leftover = (name: string) =>
      name.startsWith("majhi-preview-") && !openKeys.has(name.slice("majhi-preview-".length));
    await this.quietly(async () => {
      const builders = (await this.lines(docker, ["buildx", "ls", "--format", "{{.Name}}"])).map((n) =>
        n.replace(/\*$/, ""),
      );
      for (const name of builders.filter(leftover))
        await this.quietly(() => docker.exec(["buildx", "rm", "--force", name]));
      // The builders of open tasks stop running. The next build starts them again.
      for (const name of builders.filter((n) => n.startsWith("majhi-preview-") && !leftover(n))) {
        await this.stopBuilder(docker, name);
      }
    });
    await this.quietly(async () => {
      const images = await this.lines(docker, [
        "image",
        "ls",
        "--filter",
        "reference=majhi-preview-*",
        "--format",
        "{{.Repository}}",
      ]);
      for (const name of images.filter(leftover))
        await this.quietly(() => docker.exec(["image", "rm", "-f", name]));
    });
    this.networks.clear();
    this.deps.changed?.();
  }

  // ---------------------------------------------------------------------------
  // Pieces

  private need(): ContainerDocker {
    if (this.docker === undefined) throw new UserError(NOT_IN_DOCKER, 501);
    return this.docker;
  }

  private task(id: string): Task {
    const task = this.deps.task(id);
    if (task === undefined) throw new UserError(`Task ${id} does not exist.`, 404);
    return task;
  }

  private safety(task: Task): Safety {
    return {
      task: task.id,
      runnerNetwork: this.deps.runnerNetwork,
      majhiHome: this.deps.paths.majhiHome,
      hostHome: this.deps.paths.hostHome,
      protectedPaths: this.deps.paths.protectedPaths,
      taskFolder: task.folder,
    };
  }

  private all(task: string): ProcessInfo[] {
    return this.deps.processes.list(task);
  }

  /** The running container of this kind and name, if any. */
  private running(task: string, kind: "preview" | "service", name: string): ProcessInfo | undefined {
    return this.all(task).find(
      (p) => p.status === "running" && p.container?.kind === kind && p.container.name === name,
    );
  }

  /** The newest container of this name: `preview` or a service. */
  private latest(task: string, name: string): ProcessInfo | undefined {
    const kind = name === "preview" ? "preview" : "service";
    const same = this.all(task).filter((p) => p.container?.kind === kind && p.container.name === name);
    return same.find((p) => p.status === "running") ?? same.at(-1);
  }

  private checkLimit(task: string, settings: ContainersSettings): void {
    const running = this.all(task).filter(
      (p) => p.status === "running" && p.container !== undefined && p.container.kind !== "build",
    );
    if (running.length >= settings.per_task) {
      throw new UserError(
        `${task} already runs ${running.length} container${running.length === 1 ? "" : "s"}, the most it may (${settings.per_task}): ${running.map((p) => p.container?.name).join(", ")}. Stop one first.`,
        409,
      );
    }
  }

  private repoFolder(task: Task, repo: string | undefined): string {
    const trees = task.repos.flatMap((r) =>
      r.worktree === undefined ? [] : [{ name: r.project, path: r.worktree }],
    );
    const found =
      repo === undefined ? trees[0] : trees.find((r) => r.name === repo || basename(r.path) === repo);
    if (found === undefined) {
      throw new UserError(
        repo === undefined
          ? `${task.id} has no repo to build.`
          : `${task.id} has no repo ${repo}. Its repos: ${trees.map((r) => r.name).join(", ") || "none"}.`,
      );
    }
    return found.path;
  }

  private infoOf(p: ProcessInfo): ContainerInfo | undefined {
    const c = p.container;
    if (c === undefined || c.kind === "build") return undefined;
    return {
      task: p.task,
      process: p.id,
      agent: p.agent,
      kind: c.kind,
      name: c.name,
      image: c.image,
      status: p.status,
      ...(c.url === undefined ? {} : { url: c.url }),
      ...(c.hostUrl === undefined ? {} : { hostUrl: c.hostUrl }),
      startedAt: p.startedAt,
    };
  }

  /** The task's builder, made on first use with the limits from the settings. */
  private async ensureBuilder(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
  ): Promise<void> {
    const names = containerNames(safety.task);
    try {
      await docker.exec(["buildx", "inspect", names.builder]);
      return;
    } catch {
      // Not there yet.
    }
    await docker.create(
      builderCreateArgs(safety, { cpus: settings.build_cpus, memory: settings.build_memory }),
      safety,
    );
  }

  /** The task's internal network, made once, with the task's running runners (and preview) joined to it. */
  private async ensureNetwork(docker: ContainerDocker, safety: Safety): Promise<void> {
    const task = safety.task;
    if (this.networks.has(task)) return;
    const names = containerNames(task);
    try {
      await docker.exec(["network", "inspect", names.network]);
    } catch {
      await docker.create(networkCreateArgs(safety), safety);
    }
    this.networks.add(task);
    const runners = await this.lines(docker, [
      "ps",
      "-q",
      "--filter",
      RUNNER_LABEL,
      "--filter",
      `label=majhi.task=${task}`,
    ]);
    for (const id of [...runners, names.previewContainer]) {
      try {
        await docker.connect(names.network, id);
      } catch (err) {
        // A preview that is not running, or a runner that just ended.
        if (!/No such container|is not running|already exists/i.test(errorMessage(err))) throw err;
      }
    }
  }

  /** A named volume of the task. An existing one is used only when it is this task's, with the default driver and no options. */
  private async ensureVolume(docker: ContainerDocker, safety: Safety, name: string): Promise<void> {
    const volume = containerNames(safety.task).volume(name);
    let found: string | undefined;
    try {
      found = (await docker.exec(["volume", "inspect", "--format", "{{json .}}", volume])).stdout;
    } catch (err) {
      if (!/no such volume/i.test(errorMessage(err))) throw err;
    }
    if (found === undefined) {
      await docker.create(volumeCreateArgs(safety, name), safety);
      return;
    }
    const inspected = parseVolume(found);
    if (
      inspected === undefined ||
      inspected.Labels?.["majhi.task"] !== safety.task ||
      inspected.Labels["majhi.container"] !== "volume" ||
      (inspected.Driver !== undefined && inspected.Driver !== "local") ||
      Object.keys(inspected.Options ?? {}).length > 0
    ) {
      throw new UserError(
        `The volume ${volume} exists but is not one majhi made for ${safety.task}, so it is not used.`,
      );
    }
  }

  /** `docker port`, until the container shows its host port or ends. */
  private async lookupHostPort(
    docker: ContainerDocker,
    container: string,
    port: number,
    child: { exitCode: number | null },
  ): Promise<number | undefined> {
    const deadline = Date.now() + (this.deps.portWaitMs ?? 10_000);
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const out = (await docker.exec(["port", container, `${port}/tcp`])).stdout;
        const match = /:(\d{2,5})\s*$/m.exec(out);
        if (match?.[1] !== undefined) return Number(match[1]);
      } catch {
        // The container is not up yet.
      }
      await new Promise((done) => setTimeout(done, PORT_POLL_MS));
    }
    return undefined;
  }

  /** Stops a builder's container, if the builder exists. Its cache and state stay. */
  private async stopBuilder(docker: ContainerDocker, builder: string): Promise<void> {
    try {
      await docker.exec(["buildx", "inspect", builder]);
    } catch {
      return;
    }
    await this.quietly(() => docker.exec(["buildx", "stop", builder]));
  }

  private async removeNetwork(docker: ContainerDocker, network: string): Promise<void> {
    let members: string[] = [];
    try {
      members = (
        await docker.exec([
          "network",
          "inspect",
          "--format",
          "{{range .Containers}}{{.Name}} {{end}}",
          network,
        ])
      ).stdout
        .split(/\s+/)
        .filter(Boolean);
    } catch {
      return;
    }
    for (const member of members)
      await this.quietly(() => docker.exec(["network", "disconnect", "-f", network, member]));
    await docker.exec(["network", "rm", network]);
  }

  private async lines(docker: ContainerDocker, args: string[]): Promise<string[]> {
    return (await docker.exec(args)).stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** Cleanup goes on after a failure: what is left is removed by the next startup. */
  private async quietly(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (err) {
      console.error(`Container cleanup: ${errorMessage(err)}`);
    }
  }

  private locked<T>(task: string, run: () => Promise<T>): Promise<T> {
    const before = this.locks.get(task) ?? Promise.resolve();
    const next = before.then(run, run);
    const settled = next.catch(() => undefined);
    this.locks.set(task, settled);
    void settled.then(() => {
      if (this.locks.get(task) === settled) this.locks.delete(task);
    });
    return next;
  }
}

function limitsOf(settings: ContainersSettings): Limits {
  return { cpus: settings.cpus, memory: settings.memory };
}

interface InspectedVolume {
  Driver?: string;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
}

function parseVolume(text: string): (InspectedVolume & { Labels: Record<string, string> }) | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return undefined;
    const v = raw as InspectedVolume;
    return { ...v, Labels: v.Labels ?? {} };
  } catch {
    return undefined;
  }
}
