import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Spawned } from "@majhi/acp";
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
  TaskDockerRequest,
  TaskDockerResult,
} from "@majhi/shared";
import { reservedNameReason, sameImage, type TaskDockerErrorCode } from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { ProcessManager } from "../processes/manager.ts";
import {
  buildArgs,
  builderContainer,
  builderCreateArgs,
  builderGuardRunArgs,
  checkBuildArgs,
  ContainerRefused,
  type HostPaths,
  hostForwardRunArgs,
  hostNetworkCreateArgs,
  isIpv4Cidr,
  type Limits,
  networkCreateArgs,
  PREVIEW_ALIAS,
  previewHoldRunArgs,
  previewRunArgs,
  type Safety,
  serviceRunArgs,
  taskAliases,
  taskHoldRunArgs,
  volumeCreateArgs,
} from "./args.ts";
import type { ComposeInvocation } from "./compose-cli.ts";
import { type ComposeHost, composeCall } from "./compose-run.ts";
import type { DockerCli, TaskCallResult } from "./docker.ts";
import { dockerfileImages } from "./dockerfile-images.ts";
import { prefetchEnvFiles } from "./env-file.ts";
import { containerNames } from "./names.ts";
import { lastPrune, PRUNE_EVERY_MS, pruneBuilderCache, pruneImages, savePrune } from "./prune.ts";
import { readTaskFile } from "./safe-file.ts";
import {
  flagValues,
  ImageNotAllowed,
  localImage,
  showUserNames,
  TASK_CONTAINER_ID,
  TASK_RUN_KIND,
  type TaskDockerContext,
  type TaskDockerPlan,
  translateTaskDocker,
} from "./task-docker.ts";

export const NOT_IN_DOCKER = "Containers need majhi running in Docker.";

/** The docker calls the service makes. A test gives it a fake. */
export type ContainerDocker = Pick<
  DockerCli,
  "exec" | "connect" | "guard" | "guardBuilder" | "create" | "attached" | "task" | "hold"
>;

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
  /** The runner image: a forwarder of a service on the owner's computer runs its script. */
  runnerImage?: string | undefined;
  /** Where majhi answers on the runner network: the one private address a guarded container may reach. */
  guardServer?: () => { host: string; port: number } | undefined;
  /** The ports majhi listens on, which no forwarder may name (with its default 7070). */
  ownPorts?: () => readonly number[];
  paths: HostPaths;
  /** Tells the Hub that the list of containers changed. */
  changed?: () => void;
  /** How long a preview gets to show its port on the host, in ms. */
  portWaitMs?: number;
}

/** A container a script started, as `list` shows it: the name the script gave it. */
export interface ScriptContainer {
  name: string;
  image: string;
  status: string;
  /** True for a compose service. */
  compose: boolean;
}

/** What `serviceStart` did: started it, or asked the owner for the image first. */
export type ServiceStartResult = { status: "started"; container: ContainerInfo } | { status: "asked" };

/** Asks for an image the owner has not allowed yet, through an approval card. */
export type AskImage = (image: string, service?: string) => Promise<"allowed" | "pending">;

/** A service or the preview as an agent started it, so majhi can start it again the same way. */
type StartedSpec =
  | { kind: "service"; agent: string; input: ServiceStartInput }
  | { kind: "preview"; agent: string; input: PreviewRunInput };

/** What `taskRunning` started again, and what would not start, by name. */
export interface Restarted {
  started: string[];
  failed: string[];
}

const PORT_POLL_MS = 400;
/** The most docker calls of one task that may wait at once (`wait`, `exec`, a build, a compose up). */
const MAX_WAITING_CALLS = 16;
/** How long a holder gets to set its network guard before the preview is given up on. */
const GUARD_READY_MS = 30_000;

/** Resolves when a holder says its guard is set (netguard `--hold`); rejects when it ends first or is too slow. */
function guardReady(holder: Spawned): Promise<void> {
  return new Promise((resolve, reject) => {
    let said = "";
    const done = (err?: Error) => {
      clearTimeout(timer);
      holder.child.stdout.off("data", onOut);
      holder.child.stderr.off("data", onErr);
      holder.child.off("close", onClose);
      if (err === undefined) resolve();
      else reject(err);
    };
    const onOut = (d: Buffer) => {
      if (d.toString().includes("majhi-netguard ready")) done();
    };
    const onErr = (d: Buffer) => {
      said = (said + d.toString()).slice(-400);
    };
    const onClose = () =>
      done(
        new UserError(`The preview's network guard did not start.${said === "" ? "" : ` ${said.trim()}`}`),
      );
    const timer = setTimeout(
      () => done(new UserError("The preview's network guard did not start in time.")),
      GUARD_READY_MS,
    );
    holder.child.stdout.on("data", onOut);
    holder.child.stderr.on("data", onErr);
    holder.child.on("close", onClose);
  });
}
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
  /** The IPv4 subnets of each task's network, once it exists. */
  private readonly subnets = new Map<string, string[]>();
  /** The ports each running forwarder was started with, by container name. */
  private readonly forwarded = new Map<string, string>();
  /** Looking up the host port of a preview, by container name. */
  private readonly lookups = new Map<string, Promise<void>>();
  /** One start at a time per task, so the limit and the names are checked on the truth. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** The startup cleanup. A start waits for it, so the cleanup cannot sweep away what a start made. */
  private starting: Promise<void> = Promise.resolve();
  /** How each task's services and preview were last started, by name (`preview` or the service's). */
  private readonly specs = new Map<string, Map<string, StartedSpec>>();
  /**
   * The compose stacks a task started with `docker compose up`, by task and then by folder and files:
   * what runs again when the task runs again. A `down` of the whole stack forgets it.
   */
  private readonly stacks = new Map<string, Map<string, ComposeInvocation>>();
  /** The stacks that stopped with the task. */
  private readonly parkedStacks = new Map<string, ComposeInvocation[]>();
  /** What ran when the task stopped running. It starts again when the task runs again. */
  private readonly parked = new Map<string, StartedSpec[]>();
  /** Preview builds running, by task. The builder stops when the last one ends. */
  private readonly builds = new Map<string, number>();
  private pendingStarts = 0;
  /** The start of each task's builder container that has its network guard, by task. */
  private readonly guardedBuilders = new Map<string, string>();
  /** Docker calls of scripts that are waiting right now, by task. */
  private readonly calls = new Map<string, number>();
  /** The end of the queue of limit checks that reserve a name across all tasks. */
  private globalTail: Promise<unknown> = Promise.resolve();
  /** Names of the task containers a script is starting or running in the foreground, by task. */
  private readonly scripted = new Map<string, Set<string>>();

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

  /**
   * Makes the task's network if it is not there, so a runner that starts now joins it. Resolves false
   * when majhi does not run in Docker. A process of the task starts in a runner with a name on it.
   */
  async ensureTaskNetwork(task: string): Promise<boolean> {
    const docker = this.docker;
    const t = this.deps.task(task);
    if (docker === undefined || t === undefined) return false;
    await this.starting;
    // A task that is done gets no network: a process that starts as it ends runs without one.
    if (!this.deps.openTasks().includes(task)) return false;
    await this.locked(task, () => this.ensureNetwork(docker, this.safety(t)));
    return true;
  }

  /** The subnets of the task's network: the one private address range its runners and preview may reach. */
  taskSubnets(task: string): string[] {
    return this.subnets.get(task) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Preview

  /** Builds the image of a task repo as its preview. Returns at once; the agent is woken when the build ends. */
  async previewBuild(
    task: string,
    agent: string,
    input: PreviewBuildInput,
    ask?: AskImage,
  ): Promise<ProcessInfo> {
    const docker = this.need();
    const t = this.task(task);
    const names = containerNames(task);
    const settings = await this.deps.settings();
    await this.starting;
    return this.locked(task, async () => {
      this.assertOpen(task);
      const building = this.all(task).find((p) => p.container?.kind === "build" && p.status === "running");
      if (building !== undefined) {
        throw new UserError(
          `${building.id} is already building the preview. Wait for it to end, or stop it.`,
          409,
        );
      }
      const context = this.repoFolder(t, input.repo);
      const safety = this.safety(t);
      try {
        await this.assertBuildImages(
          docker,
          safety,
          settings,
          resolve(context, input.dockerfile),
          Object.entries(input.build_args ?? {}).map(([k, v]) => `${k}=${v}`),
        );
      } catch (err) {
        if (!(err instanceof ImageNotAllowed)) throw err;
        const answers =
          ask === undefined
            ? []
            : await Promise.all(
                [err.image, ...err.also].map((image) =>
                  ask(image, "preview").catch(() => "pending" as const),
                ),
              );
        throw new UserError(
          `${err.message}${ask === undefined ? " Allow them first with containers.images.allow." : answers.every((a) => a === "allowed") ? " The owner allowed them. Run preview_build again." : " majhi asked the owner in the room. Run preview_build again after the answer."}`,
        );
      }
      // Checked before anything starts, so a refusal reads clearly.
      const parts = buildArgs(safety, {
        context,
        dockerfile: input.dockerfile,
        target: input.target,
        buildArgs: input.build_args,
      });
      if ([...this.builds.values()].reduce((n, count) => n + count, 0) >= settings.build_total) {
        throw new UserError(
          `The preview build limit (${settings.build_total}) is reached. Wait for a build to finish.`,
          409,
        );
      }
      this.builds.set(task, (this.builds.get(task) ?? 0) + 1);
      try {
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
            spawn: async () => {
              const spawned = await docker.attached(parts, safety, { cwd: context });
              spawned.child.once("exit", () => void this.buildEnded(task));
              return spawned;
            },
          },
        });
        this.deps.changed?.();
        return info;
      } catch (err) {
        void this.buildEnded(task);
        throw err;
      }
    });
  }

  /** Runs the built preview image on a free port of the host, on the runner network. */
  async previewRun(task: string, agent: string, input: PreviewRunInput): Promise<ContainerInfo> {
    const docker = this.need();
    const t = this.task(task);
    const names = containerNames(task);
    const settings = await this.deps.settings();
    await this.starting;
    // A preview may need the task's services: what stopped with the task starts first.
    await this.taskRunning(task, "preview");
    return this.locked(task, async () => {
      this.assertOpen(task);
      try {
        await docker.exec(["image", "inspect", names.previewImage]);
      } catch {
        throw new UserError("There is no preview image yet. Build it first with preview_build.");
      }
      const old = this.running(task, "preview", "preview");
      if (old !== undefined) await this.deps.processes.stop(task, old.id, "agent");
      return this.withContainerSlot(docker, task, settings, async () => {
        const safety = this.safety(t);
        const image = this.deps.runnerImage;
        if (image === undefined) throw new UserError("majhi does not know the runner image.", 501);
        const limits = limitsOf(settings);
        // The holder owns the network and the port and holds the guard; the preview runs inside its network.
        // The task's runners reach the preview on the task's network, so it exists before the holder joins it.
        await this.ensureNetwork(docker, safety);
        const holdParts = previewHoldRunArgs(safety, limits, {
          port: input.port,
          image,
          taskSubnets: this.taskSubnets(task),
        });
        const parts = previewRunArgs(safety, limits, {
          env: input.env,
          command: input.command,
          scratch: input.scratch,
        });
        const url = `http://${PREVIEW_ALIAS}:${input.port}`;
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
              const holder = await docker.attached(holdParts, safety, { cwd: t.folder });
              try {
                await guardReady(holder);
              } catch (err) {
                holder.kill();
                throw err;
              }
              const spawned = await docker.attached(parts, safety, { cwd: t.folder });
              spawned.child.once("close", () => holder.kill());
              const lookup = this.lookupHostPort(
                docker,
                names.previewContainer,
                input.port,
                spawned.child,
              ).then((hostPort) => {
                if (hostPort !== undefined) ctx.update({ hostUrl: `http://127.0.0.1:${hostPort}` });
              });
              this.lookups.set(names.previewContainer, lookup);
              return {
                ...spawned,
                kill: () => {
                  spawned.kill();
                  holder.kill();
                },
              };
            },
          },
        });
        await this.lookups.get(names.previewContainer);
        const now = this.deps.processes.get(task, info.id);
        if (now === undefined || now.status !== "running") {
          const tail = (now?.tail ?? []).slice(-8).join("\n");
          throw new UserError(`The preview did not stay up.${tail === "" ? "" : `\n${tail}`}`);
        }
        this.remember(task, "preview", { kind: "preview", agent, input });
        this.deps.changed?.();
        return this.infoOf(now) as ContainerInfo;
      });
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
    if (!this.allowed(task, settings).some((image) => sameImage(image, input.image))) {
      if (ask === undefined) {
        throw new UserError(
          `${input.image} is not allowed yet. Allow it first with containers.images.allow, then start the service.`,
        );
      }
      if ((await ask(input.image, input.name)) === "pending") return { status: "asked" };
      settings = await this.deps.settings();
      if (!this.allowed(task, settings).some((image) => sameImage(image, input.image))) {
        throw new UserError(`${input.image} is not allowed.`);
      }
    }
    const names = containerNames(task);
    await this.starting;
    // The task's other services that stopped with it start again; this one starts as asked now.
    await this.taskRunning(task, input.name);
    return this.locked(task, async () => {
      this.assertOpen(task);
      const existing = this.running(task, "service", input.name);
      if (existing !== undefined) {
        const saved = this.specs.get(task)?.get(input.name);
        if (saved?.kind === "service" && isDeepStrictEqual(saved.input, input)) {
          return { status: "started" as const, container: this.infoOf(existing) as ContainerInfo };
        }
        throw new UserError(
          `A service ${input.name} already runs in ${task}. Stop it first, or pick another name.`,
          409,
        );
      }
      return this.withContainerSlot(docker, task, settings, async () => {
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
        await this.assertNamesFree(docker, task, {
          name: input.name,
          aliases: taskAliases(task, input.name),
        });
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
          managed: {
            container,
            // The holder first (it owns the network namespace and holds the guard), then the service inside it.
            spawn: async () => {
              const holder = { name: input.name, aliases: taskAliases(task, input.name) };
              await this.startHolder(docker, safety, settings, holder);
              try {
                const spawned = await docker.attached(parts, safety, { cwd: t.folder });
                spawned.child.once("close", () => this.dropHolder(docker, task, input.name));
                return {
                  ...spawned,
                  kill: () => {
                    spawned.kill();
                    this.dropHolder(docker, task, input.name);
                  },
                };
              } catch (err) {
                this.dropHolder(docker, task, input.name);
                throw err;
              }
            },
          },
        });
        this.remember(task, input.name, { kind: "service", agent, input });
        this.deps.changed?.();
        return { status: "started" as const, container: this.infoOf(info) as ContainerInfo };
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Services on the owner's computer

  /**
   * Starts, on the task's own network, the forwarder of each service on the owner's computer the
   * task reaches (SPEC 5.14): a container named `<id>.host` there that forwards only the declared
   * ports to the same ports of the computer. A forwarder that already runs with the same ports stays;
   * one with other ports is replaced. Nothing else of the computer is reachable through it.
   * Returns the ids it started or replaced, so a live session is told only of what changed.
   */
  async hostForward(
    task: string,
    services: readonly { id: string; ports: readonly number[] }[],
  ): Promise<string[]> {
    const started: string[] = [];
    const docker = this.need();
    const image = this.deps.runnerImage;
    if (image === undefined) throw new UserError("majhi does not know the runner image.", 501);
    const t = this.task(task);
    const settings = await this.deps.settings();
    await this.starting;
    await this.locked(task, async () => {
      this.assertOpen(task);
      const safety = this.safety(t);
      const limits = limitsOf(settings);
      const names = containerNames(task);
      for (const service of services) {
        const alias = `${service.id}.host`;
        const wanted = service.ports.join(",");
        const existing = this.running(task, "service", alias);
        if (existing !== undefined && this.forwarded.get(names.hostForward(service.id)) === wanted) continue;
        if (existing !== undefined) await this.deps.processes.stop(task, existing.id, "task");
        await this.ensureNetwork(docker, safety);
        await this.ensureHostNetwork(docker, safety);
        // The forwarder answers only this task's own network: another task's runner may reach its address.
        const from =
          (
            await this.lines(docker, [
              "network",
              "inspect",
              "--format",
              "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
              names.network,
            ])
          )[0]?.split(" ")[0] ?? "";
        const parts = hostForwardRunArgs(safety, limits, {
          id: service.id,
          ports: service.ports,
          from,
          image,
        });
        await this.deps.processes.start({
          task,
          agent: "majhi",
          name: `host service ${alias}`,
          command: `docker run ${names.hostForward(service.id)}`,
          cwd: t.folder,
          wait: false,
          managed: {
            container: { kind: "service", name: alias, image, url: `${alias}:${service.ports[0] ?? ""}` },
            spawn: () => docker.attached(parts, safety, { cwd: t.folder }),
          },
        });
        this.forwarded.set(names.hostForward(service.id), wanted);
        started.push(service.id);
      }
      this.deps.changed?.();
    });
    return started;
  }

  /**
   * The owner removed or changed a service on this computer: its forwarders stop in every task, so
   * the old access ends at once. A session that still holds it starts a forwarder again with the
   * new ports when it restarts. Returns the tasks whose forwarder it stopped.
   */
  async hostForwardStop(id: string): Promise<string[]> {
    const alias = `${id}.host`;
    const stopped: string[] = [];
    for (const p of this.deps.processes.listAll()) {
      if (p.status !== "running" || p.container?.kind !== "service" || p.container.name !== alias) continue;
      await this.deps.processes.stop(p.task, p.id, "task");
      this.forwarded.delete(containerNames(p.task).hostForward(id));
      stopped.push(p.task);
    }
    this.deps.changed?.();
    return stopped;
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
  // Containers started with `docker run` or compose

  /**
   * The task's containers that scripts started (`docker run`, compose), running or ended, by the
   * names the script gave them. Services started with `service_start` are in `list`.
   */
  async scriptContainers(task: string): Promise<ScriptContainer[]> {
    const docker = this.docker;
    if (docker === undefined) return [];
    this.task(task);
    const names = containerNames(task);
    const owned = new Set(
      this.all(task).flatMap((p) =>
        p.container?.kind === "service" ? [names.service(p.container.name)] : [],
      ),
    );
    const rows = await this.lines(docker, [
      "ps",
      "-a",
      "--filter",
      `label=majhi.container=${TASK_RUN_KIND}`,
      "--filter",
      `label=majhi.task=${task}`,
      "--format",
      '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Label "majhi.compose"}}',
    ]);
    return rows.flatMap((row) => {
      const [name = "", image = "", status = "", compose = ""] = row.split("\t");
      if (owned.has(name) || !name.startsWith(names.containerPrefix)) return [];
      return [
        {
          name: name.slice(names.containerPrefix.length),
          image: showUserNames(task, image),
          status,
          compose: compose !== "",
        },
      ];
    });
  }

  /** The last lines of a script's container, by the name the script gave it. */
  async scriptLogs(
    task: string,
    name: string,
    lines: number,
  ): Promise<{ container: ScriptContainer; lines: string[] } | undefined> {
    const docker = this.need();
    const container = (await this.scriptContainers(task)).find((c) => c.name === name);
    if (container === undefined) return undefined;
    const out = await docker.exec(["logs", "--tail", String(lines), containerNames(task).service(name)]);
    return {
      container,
      lines: `${out.stdout}${out.stderr}`
        .split("\n")
        .filter((l) => l !== "")
        .slice(-lines),
    };
  }

  /** Removes a script's container, with its holder. */
  async scriptStop(task: string, name: string): Promise<ScriptContainer | undefined> {
    const docker = this.need();
    const container = (await this.scriptContainers(task)).find((c) => c.name === name);
    if (container === undefined) return undefined;
    await docker.exec(["rm", "-f", "-v", containerNames(task).service(name)]);
    await this.locked(task, () => this.reapHolders(docker, task));
    this.deps.changed?.();
    return container;
  }

  // ---------------------------------------------------------------------------
  // A task's own docker

  /**
   * A `docker` call from a script in this task's runner (a hand-off check, a test run), sent by the
   * shim with the run's token. `task-docker.ts` turns it into a call majhi allows or refuses. The
   * container is the task's: labelled with it, named with its prefix, in the network namespace of a
   * holder that joins the task's network behind netguard, with the limits of the settings, and
   * removed when the task stops. The script gets the exit code and output a real `docker` would
   * give. An image the owner has not allowed asks through `ask`, naming the container.
   */
  async taskDocker(
    task: string,
    request: TaskDockerRequest,
    options: { ask: AskImage; signal?: AbortSignal | undefined },
  ): Promise<TaskDockerResult> {
    const docker = this.need();
    const t = this.task(task);
    const settings = await this.deps.settings();
    await this.starting;
    const safety = this.safety(t);
    const refused = (message: string, code: TaskDockerErrorCode = "refused"): TaskDockerResult => {
      const shown = showUserNames(task, message);
      return {
        code: 125,
        stdout: "",
        stderr: `docker: [${code}] ${shown}\n`,
        error: { code, message: shown },
      };
    };
    const asked = async (err: ImageNotAllowed): Promise<TaskDockerResult> => {
      const answers = await Promise.all(
        [err.image, ...err.also].map((image) =>
          options.ask(image, err.service).catch(() => "pending" as const),
        ),
      );
      const answer = answers.every((a) => a === "allowed") ? "allowed" : "pending";
      return refused(
        answer === "allowed"
          ? `${err.message} Run the script again.`
          : `${err.message} majhi asked the owner in the room. Run the script again after the answer.`,
        "image_not_allowed",
      );
    };
    const context = async (cwd: string): Promise<TaskDockerContext> => ({
      safety,
      limits: limitsOf(settings),
      cwd,
      allowedImages: this.allowed(task, settings),
      builtImages: await this.builtImages(docker, task),
      ids: await this.ownIds(docker, task, request.argv),
      envFiles: await prefetchEnvFiles(request.argv, cwd, safety),
    });
    let plan: TaskDockerPlan;
    try {
      plan = translateTaskDocker(request.argv, await context(request.cwd));
    } catch (err) {
      if (err instanceof ImageNotAllowed) return asked(err);
      if (err instanceof ContainerRefused) return refused(err.message, err.refusal);
      if (err instanceof UserError) return refused(err.message);
      throw err;
    }
    // Calls that wait on docker (a wait, an exec, a build, a stack coming up) hold the server's attention:
    // a task has a few at a time.
    const waiting = this.calls.get(task) ?? 0;
    if (plan.kind !== "text" && waiting >= MAX_WAITING_CALLS) {
      return refused(
        `${task} already has ${waiting} docker calls waiting, the most it may. Wait for one to end.`,
        "limit_reached",
      );
    }
    if (plan.kind !== "text") this.calls.set(task, waiting + 1);
    try {
      switch (plan.kind) {
        case "text":
          return { code: 0, stdout: plan.stdout, stderr: "" };
        case "call": {
          if (plan.args[0] === "start") {
            await this.locked(task, () => this.checkStart(docker, safety, settings, plan.args));
          }
          const out = this.scriptResult(
            task,
            await docker.task(plan.args, safety, this.allowed(task, settings)),
          );
          // `rm` and `stop` end a container: its holder goes with it.
          await this.locked(task, () => this.reapHolders(docker, task));
          return out;
        }
        case "build":
          return await this.scriptBuild(docker, safety, settings, plan.args);
        case "run": {
          const out = await this.scriptRun(docker, safety, settings, plan, options.signal);
          return plan.notes.length === 0
            ? out
            : { ...out, stderr: `${plan.notes.map((n) => `docker: ${n}\n`).join("")}${out.stderr}` };
        }
        case "compose": {
          const host = this.composeHost(docker, safety, settings, request.cwd, options, task);
          const out = await composeCall(host, plan.invocation);
          this.rememberStack(task, plan.invocation, out.code === 0);
          return out;
        }
        default: {
          const unknown: never = plan;
          return refused(`The docker call ${JSON.stringify(unknown)} is not known.`);
        }
      }
    } catch (err) {
      if (err instanceof ImageNotAllowed) return asked(err);
      if (err instanceof ContainerRefused) return refused(err.message, err.refusal);
      if (err instanceof UserError) return refused(err.message);
      throw err;
    } finally {
      if (plan.kind !== "text") {
        const left = (this.calls.get(task) ?? 1) - 1;
        if (left > 0) this.calls.set(task, left);
        else this.calls.delete(task);
      }
    }
  }

  private scriptResult(task: string, out: TaskCallResult): TaskDockerResult {
    return {
      code: out.code ?? 124,
      stdout: showUserNames(task, out.stdout),
      stderr: showUserNames(task, out.code === null ? `${out.stderr}\ndocker: timed out\n` : out.stderr),
    };
  }

  private async scriptBuild(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
    args: string[],
  ): Promise<TaskDockerResult> {
    const task = safety.task;
    await this.assertBuildImages(
      docker,
      safety,
      settings,
      flagValues(args, "--file")[0] ?? "",
      flagValues(args, "--build-arg"),
    );
    await this.locked(task, async () => {
      this.assertOpen(task);
      if ([...this.builds.values()].reduce((n, count) => n + count, 0) >= settings.build_total) {
        throw new UserError(
          `The build limit (${settings.build_total}) is reached. Wait for a build to finish.`,
          409,
        );
      }
      this.builds.set(task, (this.builds.get(task) ?? 0) + 1);
      try {
        await this.ensureBuilder(docker, safety, settings);
      } catch (err) {
        void this.buildEnded(task);
        throw err;
      }
    });
    try {
      return this.scriptResult(task, await docker.task(args, safety, this.allowed(task, settings)));
    } finally {
      void this.buildEnded(task);
    }
  }

  /**
   * A script's container: its holder first (the guard is set before the container exists), then the
   * container in the holder's network namespace. The name is counted from the moment the call is
   * allowed until it returns, so parallel calls cannot overrun the limit and no sweep takes the
   * holder of a container that is still being pulled.
   */
  private async scriptRun(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
    plan: Extract<TaskDockerPlan, { kind: "run" }>,
    signal: AbortSignal | undefined,
  ): Promise<TaskDockerResult> {
    const task = safety.task;
    const active = this.scripted.get(task) ?? new Set<string>();
    this.scripted.set(task, active);
    try {
      await this.locked(task, async () => {
        this.assertOpen(task);
        // Check and reserve in one step across tasks, so parallel starts in different tasks cannot both pass.
        await this.global(async () => {
          await this.checkLimits(docker, task, settings);
          active.add(plan.name);
        });
        await this.ensureNetwork(docker, safety);
        for (const volume of plan.volumes) await this.ensureVolume(docker, safety, volume);
        await this.assertNamesFree(docker, task, plan.holder);
        await this.startHolder(docker, safety, settings, plan.holder);
      });
      const stop = () => void this.quietly(() => docker.exec(["rm", "-f", "-v", plan.name]));
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const out = await docker.task(plan.args, safety, this.allowed(task, settings));
        // A run that hit the timeout leaves its container: it goes now.
        if (out.code === null) stop();
        return this.scriptResult(task, out);
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    } finally {
      active.delete(plan.name);
      if (active.size === 0 && this.scripted.get(task) === active) this.scripted.delete(task);
      // The container ended (`--rm`), or never started: its holder goes. A detached one keeps it.
      await this.locked(task, () => this.reapHolders(docker, task));
    }
  }

  /**
   * The images a Dockerfile pulls (every FROM stage, `COPY --from`, `RUN --mount from=`, the `# syntax=`
   * frontend) must be ones the owner allowed or the task built. A build otherwise pulls what no one saw.
   * Throws `ImageNotAllowed` naming all of them.
   */
  private async assertBuildImages(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
    dockerfile: string,
    buildArgs: readonly string[],
  ): Promise<void> {
    const task = safety.task;
    // First, so a `BUILDKIT_SYNTAX` never gets as far as a Dockerfile read: it loads any image as the frontend.
    checkBuildArgs([...buildArgs]);
    const text = await readTaskFile(dockerfile, safety, "Dockerfile", "refused", { maxBytes: 256 * 1024 });
    const args = new Map(
      buildArgs.flatMap((a) => {
        const at = a.indexOf("=");
        return at === -1 ? [] : [[a.slice(0, at), a.slice(at + 1)] as const];
      }),
    );
    const built = await this.builtImages(docker, task);
    const allowed = this.allowed(task, settings);
    const missing = dockerfileImages(text, args).filter((ref) => {
      const local = localImage(task, ref);
      return !(local !== undefined && built.has(local)) && !allowed.some((image) => sameImage(image, ref));
    });
    const [first, ...more] = missing;
    if (first !== undefined) throw new ImageNotAllowed(first, undefined, more);
  }

  /**
   * `docker start`: a container that ended cannot start again, because it joined the network of its
   * holder and the holder went when it ended. A container that still has its holder counts under the
   * limits like any start. Everything else is the script's to run again.
   */
  private async checkStart(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
    args: readonly string[],
  ): Promise<void> {
    const task = safety.task;
    const names = containerNames(task);
    // A holder whose container ended goes first, so what is left is what can really start.
    await this.reapHolders(docker, task);
    for (const container of args.slice(1)) {
      const state = await this.stateOf(docker, container);
      if (state === undefined || state === "running") continue;
      const user = container.slice(names.containerPrefix.length);
      if ((await this.stateOf(docker, names.holder(user))) !== "running") {
        throw new ContainerRefused(
          `${user} ended and its network holder went with it, so it cannot start again. Run it again with docker run.`,
          "restart_not_available",
        );
      }
      await this.checkLimits(docker, task, settings, 0);
    }
  }

  /** `running`, `exited` and the like, or undefined when there is no such container. */
  private async stateOf(docker: ContainerDocker, container: string): Promise<string | undefined> {
    try {
      return (await docker.exec(["inspect", "--format", "{{.State.Status}}", container])).stdout.trim();
    } catch {
      return undefined;
    }
  }

  /** What compose needs from the service, so `compose-run.ts` holds no docker or lock logic of its own. */
  private composeHost(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
    cwd: string,
    options: { ask: AskImage; signal?: AbortSignal | undefined },
    task: string,
  ): ComposeHost {
    return {
      task,
      safety,
      perTask: settings.per_task,
      context: async (dir) => ({
        safety,
        limits: limitsOf(settings),
        cwd: dir,
        allowedImages: this.allowed(task, settings),
        builtImages: await this.builtImages(docker, task),
        ids: new Map(),
      }),
      ask: (image, service) => options.ask(image, service),
      checkLimits: (extra) => this.checkLimits(docker, task, settings, extra),
      build: (args) => this.scriptBuild(docker, safety, settings, args),
      checkBuild: (args) =>
        this.assertBuildImages(
          docker,
          safety,
          settings,
          flagValues(args, "--file")[0] ?? "",
          flagValues(args, "--build-arg"),
        ),
      launch: (plan) => this.scriptRun(docker, safety, settings, plan, options.signal),
      call: async (args) =>
        this.scriptResult(task, await docker.task(args, safety, this.allowed(task, settings))),
      read: async (args) => (await docker.exec(args)).stdout,
      removeVolumes: async (names) => {
        if (names.length > 0) await docker.exec(["volume", "rm", "-f", ...names]);
      },
      reap: async () => {
        await this.locked(task, () => this.reapHolders(docker, task));
      },
      cwd,
    };
  }

  /** A stack that came up runs again when the task does; a `down` of all of it forgets it. */
  private rememberStack(task: string, inv: ComposeInvocation, ok: boolean): void {
    if (!ok) return;
    if (inv.verb === "up") {
      const stacks = this.stacks.get(task) ?? new Map<string, ComposeInvocation>();
      stacks.set(`${inv.cwd}\0${inv.files.join("\0")}`, inv);
      this.stacks.set(task, stacks);
    } else if (inv.verb === "down" && inv.services.length === 0) {
      this.stacks.delete(task);
      this.parkedStacks.delete(task);
    }
  }

  /** The images a task may run: the owner's list for every workspace and the one for the task's workspace. */
  private allowed(task: string, settings: ContainersSettings): string[] {
    const org = this.task(task).org ?? "private";
    return [...settings.images, ...(settings.org_images[org] ?? [])];
  }

  /**
   * Refuses a container whose name or alias is one a running process already answers to on the task's
   * network (a dev server named `web`), and one whose name a container of the task already has: either
   * would take the other's traffic, or its holder.
   */
  private async assertNamesFree(
    docker: ContainerDocker,
    task: string,
    holder: { name: string; aliases: string[] },
  ): Promise<void> {
    const names = containerNames(task);
    const mine = new Set(holder.aliases.filter((a) => a !== names.service(holder.name)));
    for (const p of this.all(task)) {
      if (p.status === "running" && p.host !== undefined && mine.has(p.host)) {
        throw new ContainerRefused(
          `${p.host} is the name of ${p.id} (a running process) on this task's network. Pick another name.`,
          "name_reserved",
        );
      }
    }
    const existing = await this.lines(docker, [
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
      "--filter",
      `label=majhi.task=${task}`,
    ]);
    if (existing.includes(names.service(holder.name))) {
      throw new ContainerRefused(
        `${holder.name} already exists in ${task}. Remove it first with docker rm.`,
        "name_in_use",
      );
    }
  }

  /**
   * True when `name` may not be the network name of a process of the task: a name majhi keeps, or a
   * container of the task has it. The process then starts without a name on the network.
   */
  async hostNameTaken(task: string, name: string): Promise<boolean> {
    const docker = this.docker;
    if (reservedNameReason(name) !== undefined) return true;
    if (docker === undefined) return false;
    return (
      await this.lines(docker, ["ps", "-a", "--format", "{{.Names}}", "--filter", `label=majhi.task=${task}`])
    ).includes(containerNames(task).service(name));
  }

  /**
   * Starts the holder of one task container, and returns when its guard is set. A holder of the same
   * name that a crash or a restart left goes first.
   */
  private async startHolder(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
    holder: { name: string; aliases: string[] },
  ): Promise<void> {
    const image = this.deps.runnerImage;
    if (image === undefined) throw new UserError("majhi does not know the runner image.", 501);
    const subnets = this.taskSubnets(safety.task);
    if (subnets.length === 0)
      throw new UserError(`The network of ${safety.task} has no address range yet.`, 409);
    const names = containerNames(safety.task);
    await this.quietly(() => docker.exec(["rm", "-f", "-v", names.holder(holder.name)]));
    try {
      await docker.hold(
        taskHoldRunArgs(safety, limitsOf(settings), {
          name: holder.name,
          aliases: holder.aliases,
          taskSubnets: subnets,
          image,
        }),
        safety,
      );
    } catch (err) {
      if (err instanceof ContainerRefused) throw err;
      throw new UserError(`majhi could not start ${holder.name}'s network guard: ${errorMessage(err)}`);
    }
  }

  /** Removes a holder, quietly: its container ended or never ran. */
  private dropHolder(docker: ContainerDocker, task: string, name: string): void {
    void this.quietly(() => docker.exec(["rm", "-f", "-v", containerNames(task).holder(name)]));
  }

  /**
   * Removes the holders whose container is gone, by label. A container that is starting (a script's
   * call in flight, a service's process) keeps its holder. Idempotent: it removes what is stale and
   * nothing else, so any number of calls, after a crash too, end in the same state. Call it under the task's lock.
   */
  private async reapHolders(docker: ContainerDocker, task: string): Promise<string[]> {
    const names = containerNames(task);
    const labelled = (kind: string) => [
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
      "--filter",
      `label=majhi.container=${kind}`,
      "--filter",
      `label=majhi.task=${task}`,
    ];
    const reaped: string[] = [];
    await this.quietly(async () => {
      const holders = await this.lines(docker, labelled("taskhold"));
      if (holders.length === 0) return;
      // Running ones only: a holder whose container ended (and stays, without --rm) cannot be used again, a
      // container joined to a holder that is gone cannot start, so the holder goes.
      const apps = new Set(await this.lines(docker, ["ps", ...labelled(TASK_RUN_KIND).slice(2)]));
      const starting = this.scripted.get(task) ?? new Set<string>();
      const stale = holders.filter((holder) => {
        const user = holder.startsWith(names.holderPrefix) ? holder.slice(names.holderPrefix.length) : "";
        const app = names.service(user);
        return (
          user !== "" &&
          !apps.has(app) &&
          !starting.has(app) &&
          this.running(task, "service", user) === undefined
        );
      });
      if (stale.length > 0) await docker.exec(["rm", "-f", "-v", ...stale]);
      reaped.push(...stale);
    });
    return reaped;
  }

  /** Runs `fn` after every earlier call of `global`, so a check and the reservation that follows it are one step. */
  private global<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.globalTail.catch(() => undefined).then(fn);
    this.globalTail = run;
    return run;
  }

  /** Images this task built, as `repository:tag`. */
  private async builtImages(docker: ContainerDocker, task: string): Promise<Set<string>> {
    return new Set(
      await this.lines(docker, [
        "image",
        "ls",
        "--filter",
        "label=majhi.container=image",
        "--filter",
        `label=majhi.task=${task}`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]),
    );
  }

  /**
   * The container ids a script typed, kept only when the container is this task's own. An id of
   * another task's container (or of majhi's) is left out, so the script sees "no such container".
   */
  private async ownIds(
    docker: ContainerDocker,
    task: string,
    argv: readonly string[],
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const word of new Set(argv.filter((a) => TASK_CONTAINER_ID.test(a)))) {
      try {
        const row = (
          await docker.exec([
            "inspect",
            "--format",
            '{{.Name}} {{index .Config.Labels "majhi.task"}} {{index .Config.Labels "majhi.container"}}',
            word,
          ])
        ).stdout.trim();
        const [name, owner, kind] = row.split(" ");
        if (name !== undefined && owner === task && kind === TASK_RUN_KIND)
          found.set(word, name.replace(/^\//, ""));
      } catch {
        // Not a container: the word is left alone.
      }
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // The task stops running, and runs again

  /**
   * The task stopped running (review, paused, stopped): its services and preview stop, and
   * `taskRunning` starts them again the same way. Containers run with `--rm`, so stopping removes
   * them; named volumes keep their data. The network goes and the builder stops, as on `taskStopped`.
   */
  async taskPaused(task: string, options: { keepUnsaved?: boolean } = {}): Promise<{ kept: string[] }> {
    const docker = this.docker;
    if (docker === undefined) return { kept: [] };
    // Under the task's lock, so a `taskRunning` that comes meanwhile waits and sees all of it.
    return this.locked(task, async () => {
      const parked = this.parked.get(task) ?? [];
      const specs = this.specs.get(task);
      const running = this.all(task).filter(
        (p) => p.status === "running" && p.container !== undefined && p.container.kind !== "build",
      );
      // Stopping removes a container (`--rm`): a service with no named volume would lose its data,
      // like a database an agent filled. While the task only waits (review, majhi's pause), its
      // services keep running then; the owner's Stop still ends them.
      const kept = new Set<string>();
      if (options.keepUnsaved === true) {
        const unsaved = running
          .map((p) => specs?.get(p.container?.name ?? ""))
          .filter((s) => s?.kind === "service" && (s.input.volumes ?? []).length === 0)
          .map((s) => (s === undefined ? "" : nameOf(s)));
        for (const name of unsaved) kept.add(name);
      }
      for (const p of running) {
        const name = p.container?.name ?? "";
        if (kept.has(name)) continue;
        const spec = specs?.get(name);
        if (spec !== undefined && !parked.some((s) => nameOf(s) === name)) parked.push(spec);
      }
      if (parked.length > 0) this.parked.set(task, parked);
      for (const p of running) {
        if (!kept.has(p.container?.name ?? "")) await this.deps.processes.stop(task, p.id, "task");
      }
      if (kept.size === 0) {
        const stacks = this.stacks.get(task);
        if (stacks !== undefined) {
          this.parkedStacks.set(task, [...stacks.values()]);
          this.stacks.delete(task);
        }
        await this.removeTaskContainers(task);
      } else await this.stopBuilder(docker, containerNames(task).builder);
      return { kept: [...kept] };
    });
  }

  /**
   * The task runs again: what `taskPaused` stopped starts again, services first (a preview joins
   * their network). `except` is a name an agent starts anew now. Each failure is reported by name
   * and the rest still start.
   */
  async taskRunning(task: string, except?: string): Promise<Restarted> {
    const done: Restarted = { started: [], failed: [] };
    if (this.docker === undefined) return done;
    // After a `taskPaused` in flight. The starts below take the lock themselves.
    const parked = await this.locked(task, async () => {
      const found = this.parked.get(task);
      this.parked.delete(task);
      return found;
    });
    const order = (parked ?? [])
      .filter((s) => nameOf(s) !== except)
      .sort((a, b) => Number(a.kind === "preview") - Number(b.kind === "preview"));
    for (const spec of order) {
      const name = nameOf(spec);
      try {
        if (spec.kind === "service") await this.serviceStart(task, spec.agent, spec.input);
        else await this.previewRun(task, spec.agent, spec.input);
        done.started.push(name);
      } catch (err) {
        done.failed.push(`${name}: ${errorMessage(err)}`);
      }
    }
    // The compose stacks that stopped with the task come up again as they were asked for. They rely on
    // images already allowed, so nothing here asks the owner.
    const stacks = this.parkedStacks.get(task) ?? [];
    this.parkedStacks.delete(task);
    for (const inv of stacks) {
      const where = `compose in ${basename(inv.cwd)}`;
      try {
        const docker = this.need();
        const safety = this.safety(this.task(task));
        const host = this.composeHost(
          docker,
          safety,
          await this.deps.settings(),
          inv.cwd,
          { ask: async () => "pending" },
          task,
        );
        const out = await composeCall(host, inv);
        if (out.code === 0) {
          done.started.push(where);
          this.stacks.set(
            task,
            (this.stacks.get(task) ?? new Map()).set(`${inv.cwd}\0${inv.files.join("\0")}`, inv),
          );
        } else {
          done.failed.push(`${where}: ${out.error?.message ?? out.stderr.trim()}`);
        }
      } catch (err) {
        done.failed.push(`${where}: ${errorMessage(err)}`);
      }
    }
    return done;
  }

  // ---------------------------------------------------------------------------
  // Cleanup

  /**
   * The task stopped (stop, close, remove): its containers and network go. Volumes stay, so a
   * paused task keeps its test data. Call after the task's processes were stopped.
   */
  async taskStopped(task: string): Promise<void> {
    if (this.docker === undefined) return;
    await this.locked(task, () => this.removeTaskContainers(task));
  }

  /** The body of `taskStopped`, for a caller that holds the task's lock already. */
  private async removeTaskContainers(task: string): Promise<void> {
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
    // A runner of the task that is still up must not keep a range the next network may be given.
    await this.quietly(async () => {
      const runners = await this.lines(docker, [
        "ps",
        "-q",
        "--filter",
        RUNNER_LABEL,
        "--filter",
        `label=majhi.task=${task}`,
      ]);
      for (const id of runners) await docker.guard(id, [], this.deps.guardServer?.());
    });
    await this.quietly(() => this.removeNetwork(docker, names.network));
    await this.quietly(() => this.removeNetwork(docker, names.hostNetwork));
    for (const name of this.forwarded.keys())
      if (name.startsWith(`majhi-${names.key}-host-`)) this.forwarded.delete(name);
    // A paused task leaves nothing running: the builder stops, and the next build starts it again.
    await this.stopBuilder(docker, names.builder);
    this.networks.delete(task);
    this.subnets.delete(task);
    this.deps.changed?.();
  }

  /** The task is done or removed: everything of it goes, volumes, builder and preview image too. */
  async taskEnded(task: string): Promise<void> {
    // One step under the task's lock: a start that waits behind it finds the task closed and refuses.
    await this.locked(task, async () => {
      this.parked.delete(task);
      this.specs.delete(task);
      this.stacks.delete(task);
      this.parkedStacks.delete(task);
      this.guardedBuilders.delete(task);
      await this.removeTaskContainers(task);
      await this.removeTaskState(task);
    });
  }

  /** What stays of an ended task after its containers: volumes, builder, preview image and built images. */
  private async removeTaskState(task: string): Promise<void> {
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
    // What the task's scripts built: found by label, removed by id.
    await this.quietly(async () => {
      const images = await this.lines(docker, [
        "image",
        "ls",
        "-q",
        "--filter",
        "label=majhi.container=image",
        "--filter",
        `label=majhi.task=${task}`,
      ]);
      if (images.length > 0) await docker.exec(["image", "rm", "-f", ...new Set(images)]);
    });
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
    this.subnets.clear();
    this.deps.changed?.();
  }

  /**
   * The weekly prune (`prune.ts`): majhi's preview images that no container uses and the build
   * cache of the open tasks' builders, each older than a week. Runs when a week passed since the
   * last one. Never volumes, and nothing majhi did not label or name. Undefined when it was not due.
   */
  async pruneIfDue(now = new Date()): Promise<{ images: number; builders: number } | undefined> {
    const docker = this.docker;
    if (docker === undefined) return undefined;
    const home = this.deps.paths.majhiHome;
    const last = await lastPrune(home);
    if (last !== undefined && now.getTime() - last.getTime() < PRUNE_EVERY_MS) return undefined;
    await this.starting;
    let images = 0;
    await this.quietly(async () => {
      images = await pruneImages(docker, now);
    });
    let builders = 0;
    const existing = new Set<string>();
    await this.quietly(async () => {
      const names = await this.lines(docker, ["buildx", "ls", "--format", "{{.Name}}"]);
      for (const name of names) existing.add(name.replace(/\*$/, ""));
    });
    for (const task of this.deps.openTasks()) {
      const builder = containerNames(task).builder;
      if (!existing.has(builder)) continue;
      // Under the task's lock, and never while it builds: a prune starts the builder, and it stops again.
      await this.locked(task, async () => {
        if ((this.builds.get(task) ?? 0) > 0) return;
        await this.quietly(async () => {
          await pruneBuilderCache(docker, builder);
          builders++;
        });
        await this.stopBuilder(docker, builder);
      });
    }
    await savePrune(home, now);
    return { images, builders };
  }

  // ---------------------------------------------------------------------------
  // Pieces

  private need(): ContainerDocker {
    if (this.docker === undefined) throw new UserError(NOT_IN_DOCKER, 501);
    return this.docker;
  }

  /** A task that is done starts no container: a start that was waiting for the lock finds it closed. */
  private assertOpen(task: string): void {
    if (!this.deps.openTasks().includes(task)) {
      throw new ContainerRefused(`${task} is done, so it cannot start containers.`, "task_not_open");
    }
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
      ownPorts: this.deps.ownPorts?.() ?? [],
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

  /** True when this name is the preview or a service majhi started itself (a process), not a script's container. */
  has(task: string, name: string): boolean {
    return this.latest(task, name) !== undefined;
  }

  /** The newest container of this name: `preview` or a service. */
  private latest(task: string, name: string): ProcessInfo | undefined {
    const kind = name === "preview" ? "preview" : "service";
    const same = this.all(task).filter((p) => p.container?.kind === kind && p.container.name === name);
    return same.find((p) => p.status === "running") ?? same.at(-1);
  }

  /**
   * The docker names of the containers a task runs or is starting, whoever started them: docker's
   * own list (services, scripts' and compose's containers, previews), majhi's processes (one that
   * has not shown up in docker yet) and the calls of scripts in flight. One count, so a limit
   * means the same for `service_start`, `docker run` and compose.
   */
  private async containersOf(docker: ContainerDocker, task: string | undefined): Promise<Set<string>> {
    const found = new Set<string>();
    // Every state: a container that ended and was not removed still counts until `docker rm` takes it.
    for (const kind of [TASK_RUN_KIND, "preview"]) {
      for (const name of await this.lines(docker, [
        "ps",
        "-a",
        "--format",
        "{{.Names}}",
        "--filter",
        `label=majhi.container=${kind}`,
        ...(task === undefined ? [] : ["--filter", `label=majhi.task=${task}`]),
      ])) {
        found.add(name);
      }
    }
    // A holder counts as the container it belongs to, so one that outlived its container still takes its slot.
    for (const name of await this.lines(docker, [
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
      "--filter",
      "label=majhi.container=taskhold",
      ...(task === undefined ? [] : ["--filter", `label=majhi.task=${task}`]),
    ])) {
      const at = name.indexOf("-h-");
      if (at !== -1) found.add(`${name.slice(0, at)}-c-${name.slice(at + 3)}`);
    }
    const procs = task === undefined ? this.deps.processes.listAll() : this.all(task);
    for (const p of procs) {
      if (p.status !== "running" || p.container === undefined || p.container.kind === "build") continue;
      const names = containerNames(p.task);
      found.add(
        p.container.kind === "preview"
          ? names.previewApp
          : p.container.name.endsWith(".host")
            ? names.hostForward(p.container.name.slice(0, -".host".length))
            : names.service(p.container.name),
      );
    }
    for (const [, active] of task === undefined
      ? this.scripted
      : ([[task, this.scripted.get(task) ?? new Set<string>()]] as const)) {
      for (const name of active) found.add(name);
    }
    return found;
  }

  /** At most `per_task` containers in the task and `total` in all, counting `extra` more that are about to start. */
  private async checkLimits(
    docker: ContainerDocker,
    task: string,
    settings: ContainersSettings,
    extra = 1,
    pending = this.pendingStarts,
  ): Promise<void> {
    const mine = await this.containersOf(docker, task);
    if (mine.size + extra > settings.per_task) {
      throw new ContainerRefused(
        `${task} already runs ${mine.size} container${mine.size === 1 ? "" : "s"}${extra > 1 ? ` and this starts ${extra} more` : ""}, the most it may (${settings.per_task}): ${[...mine].map((n) => showUserNames(task, n)).join(", ")}. Remove one first.`,
        "limit_reached",
      );
    }
    const everywhere = await this.containersOf(docker, undefined);
    if (everywhere.size + extra + pending > settings.total) {
      throw new ContainerRefused(
        `The container limit across all tasks (${settings.total}) is reached. Stop an unused container first, or try again when one has ended.`,
        "limit_reached",
      );
    }
  }

  /** Reserve before any await so concurrent starts in different tasks cannot overrun the cap. */
  private async withContainerSlot<T>(
    docker: ContainerDocker,
    task: string,
    settings: ContainersSettings,
    start: () => Promise<T>,
  ): Promise<T> {
    // The starts in flight before this one: this one is counted by `extra`.
    const others = this.pendingStarts;
    this.pendingStarts++;
    try {
      await this.checkLimits(docker, task, settings, 1, others);
      return await start();
    } finally {
      this.pendingStarts--;
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

  /**
   * The task's builder, made on first use with the limits from the settings, and closed to private
   * destinations before any build runs on it (`guardBuilder`).
   */
  private async ensureBuilder(
    docker: ContainerDocker,
    safety: Safety,
    settings: ContainersSettings,
  ): Promise<void> {
    const names = containerNames(safety.task);
    let made = true;
    try {
      await docker.exec(["buildx", "inspect", names.builder]);
      made = false;
    } catch {
      // Not there yet.
    }
    if (made) {
      await docker.create(
        builderCreateArgs(safety, { cpus: settings.build_cpus, memory: settings.build_memory }),
        safety,
      );
    }
    await this.guardBuilder(docker, safety);
  }

  /**
   * The `RUN` steps of a build run in the builder's own network namespace, on the default bridge, so
   * they would reach the computer's gateway, the LAN and 169.254.169.254. A one-shot container in that
   * namespace sets the same rules as a holder (public internet only). A builder that was stopped starts
   * with a new namespace, so this runs for every start of it; it fails closed.
   */
  private async guardBuilder(docker: ContainerDocker, safety: Safety): Promise<void> {
    const image = this.deps.runnerImage;
    if (image === undefined) throw new UserError("majhi does not know the runner image.", 501);
    const task = safety.task;
    try {
      await docker.exec(["buildx", "inspect", "--bootstrap", containerNames(task).builder], {
        timeoutMs: 120_000,
      });
      const started = (
        await docker.exec(["inspect", "--format", "{{.Id}} {{.State.StartedAt}}", builderContainer(task)])
      ).stdout.trim();
      if (this.guardedBuilders.get(task) === started) return;
      await docker.guardBuilder(
        builderGuardRunArgs(safety, { image, id: randomBytes(4).toString("hex") }),
        safety,
      );
      this.guardedBuilders.set(task, started);
    } catch (err) {
      throw new UserError(
        `majhi could not close the builder's network, so nothing is built: ${errorMessage(err)}`,
      );
    }
  }

  /** The task's internal network, made once, with the task's running runners (and preview) joined to it. */
  private async ensureNetwork(docker: ContainerDocker, safety: Safety): Promise<void> {
    const task = safety.task;
    const names = containerNames(task);
    // A network that majhi remembers may be gone (removed by hand, or by a sweep): look before relying on it.
    if (this.networks.has(task)) {
      try {
        await docker.exec(["network", "inspect", names.network]);
        return;
      } catch {
        this.networks.delete(task);
      }
    }
    try {
      await docker.exec(["network", "inspect", names.network]);
    } catch {
      await docker.create(networkCreateArgs(safety), safety);
    }
    this.networks.add(task);
    const subnets = (
      await this.lines(docker, [
        "network",
        "inspect",
        "--format",
        "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
        names.network,
      ])
    )[0]
      ?.split(" ")
      .filter((cidr) => isIpv4Cidr(cidr));
    this.subnets.set(task, subnets ?? []);
    const runners = await this.lines(docker, [
      "ps",
      "-q",
      "--filter",
      RUNNER_LABEL,
      "--filter",
      `label=majhi.task=${task}`,
    ]);
    for (const id of runners) {
      try {
        await docker.connect(names.network, id);
      } catch (err) {
        // A preview that is not running, or a runner that just ended.
        if (!/No such container|is not running|already exists/i.test(errorMessage(err))) throw err;
        continue;
      }
      // It started before this network: its guard learns the one private range it may now reach.
      await this.quietly(() => docker.guard(id, this.taskSubnets(task), this.deps.guardServer?.()));
    }
  }

  /** The forwarders' own network, made once per task. Only forwarders join it. */
  private async ensureHostNetwork(docker: ContainerDocker, safety: Safety): Promise<void> {
    const name = containerNames(safety.task).hostNetwork;
    try {
      await docker.exec(["network", "inspect", name]);
    } catch {
      await docker.create(hostNetworkCreateArgs(safety), safety);
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

  private remember(task: string, name: string, spec: StartedSpec): void {
    const specs = this.specs.get(task) ?? new Map<string, StartedSpec>();
    specs.set(name, spec);
    this.specs.set(task, specs);
  }

  /** A preview build ended: the builder stops once no other build of the task runs. Its cache stays. */
  private async buildEnded(task: string): Promise<void> {
    const left = (this.builds.get(task) ?? 1) - 1;
    if (left > 0) {
      this.builds.set(task, left);
      return;
    }
    this.builds.delete(task);
    const docker = this.docker;
    if (docker === undefined) return;
    // Under the task's lock: a build that starts meanwhile is counted before this looks.
    await this.locked(task, async () => {
      if ((this.builds.get(task) ?? 0) === 0) await this.stopBuilder(docker, containerNames(task).builder);
    });
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

const nameOf = (spec: StartedSpec): string => (spec.kind === "service" ? spec.input.name : "preview");

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
