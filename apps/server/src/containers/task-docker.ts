import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  ContainerNameSchema,
  ContainerPathSchema,
  ImageRefSchema,
  sameImage,
  type TaskDockerErrorCode,
} from "@majhi/shared";
import {
  all,
  assertNoHostPaths,
  assertReadable,
  atMostOne,
  CAPS,
  ContainerRefused,
  checkKeyValues,
  checkLabels,
  checkLimits,
  type Flag,
  type FlagTable,
  is,
  type Limits,
  matches,
  one,
  PIDS_LIMIT,
  parseFlags,
  refuse,
  type Safety,
  shown,
  taskAliases,
} from "./args.ts";
import { type ComposeInvocation, parseCompose } from "./compose-cli.ts";
import type { EnvFileRead } from "./env-file.ts";
import { containerNames } from "./names.ts";
import { flag, has, type Parsed, parseFlagsOf, single, type UserTable, values } from "./user-flags.ts";

/**
 * The `docker` a task's own scripts call (a repo's hand-off check, a test run). A runner has no
 * Docker and never gets the socket. Its `docker` is a shim that sends the arguments to majhi
 * (`/mcp/docker`, bearer token of the run), and this file turns them into a call majhi allows:
 *
 * 1. `translateTaskDocker` reads what the script typed (`docker run -d --name web -v $PWD:/site nginx`)
 *    and builds the canonical call: names prefixed with the task, the task's labels, the network
 *    namespace of the container's holder (which joins the task's network behind netguard, see
 *    docs/design/task-network.md), majhi's limits and capabilities. Flags it does not know are refused.
 * 2. `assertTaskArgv` checks the canonical call against an allow list again. `DockerCli.task` runs it
 *    before every call, so whatever built the arguments, nothing unchecked reaches Docker.
 *
 * The rules: only containers whose name starts with this task's prefix and that carry its labels;
 * mounts are bind mounts inside the task folder or this task's named volumes; no published port
 * (a `-p` is dropped with a note: the container is reached by name inside the task),
 * no privileged flag, no pid, ipc, host network or socket; the image is the owner's allow list or
 * one this task built. Nothing here touches another task's containers, because every name is
 * prefixed with this task's key before it reaches Docker.
 */

/** The label kinds of the containers and images these calls make. Cleanup finds them by `majhi.task`. */
export const TASK_RUN_KIND = "taskrun";

/** The user's name for a container or an image: lowercase, short. */
const USER_NAME = /^[a-z0-9][a-z0-9_.-]{0,40}$/;
const LOCAL_IMAGE = /^([a-z0-9][a-z0-9_./-]{0,60})(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,40}))?$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const BUILT_TAG = /^[a-z0-9][a-z0-9_.-]{0,60}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,40}$/;
/** A mount source goes into a comma separated `--mount` value. */
const BAD_SOURCE = { test: (v: string) => [",", '"', "'", "\u0000", "\n", "\r"].some((c) => v.includes(c)) };
const MAX_MOUNTS = 16;
const MAX_COMMAND = 64;

/** What the call is checked against and built from. */
export interface TaskDockerContext {
  safety: Safety;
  limits: Limits;
  /** Where the script ran: relative paths start here. */
  cwd: string;
  /** Images this task built, as `<repository>:<tag>` with the task's prefix. */
  builtImages: ReadonlySet<string>;
  /** The images the owner allowed. */
  allowedImages: readonly string[];
  /** Container ids the script typed that really are this task's, by id to name. */
  ids: ReadonlyMap<string, string>;
  /** The env files the script named, read before translation (`prefetchEnvFiles`), by absolute path. */
  envFiles?: ReadonlyMap<string, EnvFileRead> | undefined;
}

/** The image is not on the owner's list and the task did not build it. The caller may ask the owner. */
export class ImageNotAllowed extends ContainerRefused {
  constructor(
    readonly image: string,
    /** The name of the container or compose service that wants it, for the owner's card. */
    readonly service?: string,
  ) {
    super(`${image} is not an image this task built or the owner allowed.`, "image_not_allowed");
  }
}

export const taskNames = containerNames;

/** What a run of the shim does with a translated call. */
export type TaskDockerPlan =
  | { kind: "text"; stdout: string }
  | {
      kind: "run";
      /** The container's own `docker run`, in its holder's network namespace. */
      args: string[];
      /** The container's docker name, `majhi-<key>-c-<name>`. */
      name: string;
      /** The names its holder answers to on the task network, the first being `<name>`. */
      holder: { name: string; aliases: string[] };
      detach: boolean;
      volumes: string[];
      /** Lines for the script's stderr: what majhi changed or ignored. */
      notes: string[];
    }
  | { kind: "build"; args: string[] }
  | { kind: "call"; args: string[] }
  | { kind: "compose"; invocation: ComposeInvocation };

/** Flags that would break out of the task, with the code a script reads and what to do instead. */
const REFUSED_FLAGS: Record<string, [TaskDockerErrorCode, string]> = {
  "--privileged": ["privileged", "A task's container is never privileged."],
  "--pid": ["namespace_not_allowed", "A task's container has its own process namespace."],
  "--ipc": ["namespace_not_allowed", "A task's container has its own IPC namespace."],
  "--uts": ["namespace_not_allowed", "A task's container has its own host name."],
  "--userns": ["namespace_not_allowed", "A task's container has the default user namespace."],
  "--cgroupns": ["namespace_not_allowed", "A task's container has the default cgroup namespace."],
  "--cgroup-parent": ["namespace_not_allowed", "A task's container has the default cgroup."],
  "--device": ["device_not_allowed", "A task's container gets no host device."],
  "--device-cgroup-rule": ["device_not_allowed", "A task's container gets no host device."],
  "--gpus": ["device_not_allowed", "A task's container gets no host device."],
  "--cap-add": ["capability_not_allowed", "majhi sets the capabilities of a task's container."],
  "--cap-drop": ["capability_not_allowed", "majhi sets the capabilities of a task's container."],
  "--security-opt": ["capability_not_allowed", "majhi sets the security options of a task's container."],
  "--sysctl": ["capability_not_allowed", "A task's container takes no sysctl."],
  "--volumes-from": ["mount_outside", "Mount the folder or the named volume itself with -v."],
  "--add-host": [
    "host_network",
    "A task's container reaches the others by name, and nothing of the computer.",
  ],
  "--dns": ["host_network", "A task's container uses the task network's name service."],
  "--mac-address": ["host_network", "A task's container takes no network address of its own."],
  "--ip": ["host_network", "A task's container takes no network address of its own."],
  "--link": ["network_not_allowed", "Containers of a task reach each other by name already."],
};

function refuseFlag(name: string): never {
  const known = Object.hasOwn(REFUSED_FLAGS, name) ? REFUSED_FLAGS[name] : undefined;
  if (known !== undefined)
    return refuse(`The docker flag ${name} is not allowed in a task. ${known[1]}`, known[0]);
  return refuse(`The docker flag ${shown(name)} is not allowed in a task.`, "flag_not_allowed");
}

const parseUser = (argv: readonly string[], table: UserTable): Parsed =>
  parseFlagsOf(argv, table, refuseFlag);

// ---------------------------------------------------------------------------
// Names and images

function containerOperand(arg: string, ctx: TaskDockerContext): string {
  const names = taskNames(ctx.safety.task);
  const byId = ctx.ids.get(arg);
  if (byId !== undefined) return byId;
  if (USER_NAME.test(arg)) return `${names.containerPrefix}${arg}`;
  return refuse(`There is no container ${shown(arg)} in this task.`);
}

/** `acme/web:1` to `majhi-<key>-img-acme--web:1`, or undefined when it is not shaped like a local name. */
export function localImage(task: string, ref: string): string | undefined {
  const match = LOCAL_IMAGE.exec(ref);
  if (match === null) return undefined;
  const name = (match[1] ?? "").replaceAll("/", "--");
  return `${taskNames(task).imagePrefix}${name}:${match[2] ?? "latest"}`;
}

function runImage(ref: string, ctx: TaskDockerContext, service: string | undefined): string {
  if (!matches(ImageRefSchema, ref)) return refuse(`The image ${shown(ref)} is not allowed.`);
  const local = localImage(ctx.safety.task, ref);
  if (local !== undefined && ctx.builtImages.has(local)) return local;
  if (ctx.allowedImages.some((image) => sameImage(image, ref))) return ref;
  throw new ImageNotAllowed(ref, service);
}

// ---------------------------------------------------------------------------
// docker run

const RUN_USER: UserTable = {
  "-i": flag("interactive"),
  "--interactive": flag("interactive"),
  "-t": flag("tty"),
  "--tty": flag("tty"),
  "-d": flag("detach"),
  "--detach": flag("detach"),
  "--rm": flag("rm"),
  "--name": flag("name", true),
  "-e": flag("env", true),
  "--env": flag("env", true),
  "--env-file": flag("env-file", true),
  "-v": flag("volume", true),
  "--volume": flag("volume", true),
  "--tmpfs": flag("tmpfs", true),
  "-w": flag("workdir", true),
  "--workdir": flag("workdir", true),
  "--entrypoint": flag("entrypoint", true),
  "--read-only": flag("read-only"),
  "-u": flag("user", true),
  "--user": flag("user", true),
  "--platform": flag("platform", true),
  "--shm-size": flag("shm-size", true),
  "--health-cmd": flag("health-cmd", true),
  "--health-interval": flag("health-interval", true),
  "--health-timeout": flag("health-timeout", true),
  "--health-retries": flag("health-retries", true),
  "--health-start-period": flag("health-start-period", true),
  "--network": flag("network", true),
  "--net": flag("network", true),
  "--network-alias": flag("alias", true),
  "--net-alias": flag("alias", true),
  "-p": flag("publish", true),
  "--publish": flag("publish", true),
  // Accepted and ignored: majhi sets the limits, the restart policy and the name service.
  "-m": flag("memory", true),
  "--memory": flag("memory", true),
  "--cpus": flag("cpus", true),
  "--restart": flag("restart", true),
  "--init": flag("init"),
  "--pull": flag("pull", true),
  "-h": flag("hostname", true),
  "--hostname": flag("hostname", true),
  "-l": flag("label", true),
  "--label": flag("label", true),
  "--stop-timeout": flag("stop-timeout", true),
};

export interface Mount {
  arg: string;
  volume?: string;
}

/** `pg_data` and `PgData` are the volume `pg-data`: lowercase, `_` and `.` become `-`. Undefined when no name is left. */
export function volumeKey(source: string): string | undefined {
  const key = source.toLowerCase().replaceAll("_", "-").replaceAll(".", "-");
  return matches(ContainerNameSchema, key) ? key : undefined;
}

/** What `-v` (or a compose `volumes:` entry) names: a folder of the task, a volume of the task, or an anonymous volume. */
export function mountOf(spec: string, ctx: TaskDockerContext, from: string = ctx.cwd): Mount {
  const names = taskNames(ctx.safety.task);
  const parts = spec.split(":");
  if (parts.length > 3) return refuse(`The volume ${shown(spec)} is not allowed.`);
  const [source, target, opts] = parts.length === 1 ? [undefined, parts[0], undefined] : parts;
  const mode = opts ?? "rw";
  if (mode !== "ro" && mode !== "rw") return refuse(`The volume option ${shown(mode)} is not allowed.`);
  const readonly = mode === "ro" ? ",readonly" : "";
  if (!matches(ContainerPathSchema, target ?? ""))
    return refuse(`The mount path ${shown(target ?? "")} is not allowed.`);
  if (source === undefined) return { arg: `type=volume,target=${target}${readonly}` };
  if (source.startsWith("/") || source.startsWith(".")) {
    if (source.includes("docker.sock"))
      return refuse("A container cannot use the Docker socket.", "socket_mount");
    if (BAD_SOURCE.test(source)) return refuse(`The mount source ${shown(source)} is not allowed.`);
    return { arg: `type=bind,source=${resolve(from, source)},target=${target}${readonly}` };
  }
  const key = volumeKey(source);
  if (key === undefined) {
    return refuse(
      `The volume ${shown(source)} is not allowed. Use a folder of the task or a name like data.`,
    );
  }
  return { arg: `type=volume,source=${names.volume(key)},target=${target}${readonly}`, volume: key };
}

export interface Health {
  cmd: string;
  interval?: string | undefined;
  timeout?: string | undefined;
  retries?: string | undefined;
  startPeriod?: string | undefined;
}

/** A container of the task, as the script or a compose file described it. `buildRunPlan` checks and builds the call. */
export interface RunSpec {
  /** The user's name for it: its docker name is `majhi-<key>-c-<name>` and it is reached as `<name>`. */
  name: string;
  /** More names the task network answers to. */
  aliases: readonly string[];
  /** The script gave no `--name`: the name is made up, so an approval card does not show it. */
  anonymous?: boolean | undefined;
  /** As typed: a local image of the task, or one the owner allowed. */
  image: string;
  rm: boolean;
  detach: boolean;
  readOnly: boolean;
  /** `NAME=value`. */
  env: readonly string[];
  mounts: readonly Mount[];
  workdir?: string | undefined;
  entrypoint?: string | undefined;
  user?: string | undefined;
  platform?: string | undefined;
  shmSize?: string | undefined;
  health?: Health | undefined;
  command: readonly string[];
  /** The compose service it belongs to, kept as a label so `compose ps` and `down` find it. */
  compose?: string | undefined;
}

const USER_SPEC = /^([a-z_][a-z0-9_.-]{0,31}|[0-9]{1,10})(:([a-z_][a-z0-9_.-]{0,31}|[0-9]{1,10}))?$/;
const PLATFORM = /^[a-z0-9]{3,10}\/[a-z0-9]{3,10}(\/[a-z0-9]{2,10})?$/;
const SHM = /^[1-9][0-9]{0,3}[mg]$/;
const DURATION = /^[0-9]{1,5}(ms|s|m|h)$/;
const RETRIES = /^[0-9]{1,3}$/;
const MAX_ENV = 128;

function checkHealth(health: Health | undefined): void {
  if (health === undefined) return;
  if (health.cmd.length === 0 || health.cmd.length > 2_000 || health.cmd.includes("\u0000"))
    refuse("The health check command is empty, too long or holds NUL.");
  for (const [value, pattern, what] of [
    [health.interval, DURATION, "--health-interval"],
    [health.timeout, DURATION, "--health-timeout"],
    [health.startPeriod, DURATION, "--health-start-period"],
    [health.retries, RETRIES, "--health-retries"],
  ] as const) {
    if (value !== undefined && !pattern.test(value)) refuse(`The value of ${what} is not allowed.`);
  }
}

/**
 * The checked call for one container: its `docker run` in its holder's network namespace, and the
 * names its holder answers to. Everything the script or compose file chose passes here, and
 * `assertTaskArgv` checks the result again.
 */
export function buildRunPlan(
  spec: RunSpec,
  ctx: TaskDockerContext,
  notes: readonly string[] = [],
): Extract<TaskDockerPlan, { kind: "run" }> {
  const names = taskNames(ctx.safety.task);
  if (!USER_NAME.test(spec.name)) return refuse(`The container name ${shown(spec.name)} is not allowed.`);
  if (spec.mounts.length > MAX_MOUNTS) return refuse(`At most ${MAX_MOUNTS} volumes.`);
  if (spec.user !== undefined && !USER_SPEC.test(spec.user))
    return refuse(`The user ${shown(spec.user)} is not allowed.`);
  if (spec.platform !== undefined && !PLATFORM.test(spec.platform))
    return refuse(`The platform ${shown(spec.platform)} is not allowed.`);
  if (spec.shmSize !== undefined && !SHM.test(spec.shmSize))
    return refuse(`The --shm-size ${shown(spec.shmSize)} is not allowed.`);
  checkHealth(spec.health);
  const image = runImage(spec.image, ctx, spec.anonymous === true ? undefined : spec.name);
  const aliases = taskAliases(ctx.safety.task, spec.name, spec.aliases);
  const container = names.service(spec.name);
  const args = [
    "run",
    ...(spec.rm ? ["--rm"] : []),
    ...(spec.detach ? ["--detach"] : []),
    "--name",
    container,
    "--label",
    `majhi.container=${TASK_RUN_KIND}`,
    "--label",
    `majhi.task=${ctx.safety.task}`,
    ...(spec.compose === undefined ? [] : ["--label", `majhi.compose=${spec.compose}`]),
    "--cap-drop",
    "ALL",
    ...CAPS.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(PIDS_LIMIT),
    "--memory",
    ctx.limits.memory,
    "--cpus",
    String(ctx.limits.cpus),
    "--network",
    `container:${names.holder(spec.name)}`,
    ...(spec.readOnly ? ["--read-only"] : []),
    ...(spec.user === undefined ? [] : ["--user", spec.user]),
    ...(spec.platform === undefined ? [] : ["--platform", spec.platform]),
    ...(spec.shmSize === undefined ? [] : ["--shm-size", spec.shmSize]),
    ...(spec.health === undefined
      ? []
      : [
          "--health-cmd",
          spec.health.cmd,
          ...(spec.health.interval === undefined ? [] : ["--health-interval", spec.health.interval]),
          ...(spec.health.timeout === undefined ? [] : ["--health-timeout", spec.health.timeout]),
          ...(spec.health.retries === undefined ? [] : ["--health-retries", spec.health.retries]),
          ...(spec.health.startPeriod === undefined
            ? []
            : ["--health-start-period", spec.health.startPeriod]),
        ]),
    ...spec.mounts.flatMap((m) => ["--mount", m.arg]),
    ...spec.env.flatMap((e) => ["--env", e]),
    ...(spec.workdir === undefined ? [] : ["--workdir", spec.workdir]),
    ...(spec.entrypoint === undefined ? [] : ["--entrypoint", spec.entrypoint]),
    image,
    ...spec.command,
  ];
  assertTaskArgv(args, ctx.safety, ctx.allowedImages);
  return {
    kind: "run",
    args,
    name: container,
    holder: { name: spec.name, aliases },
    detach: spec.detach,
    volumes: spec.mounts.flatMap((m) => (m.volume === undefined ? [] : [m.volume])),
    notes: [...notes],
  };
}

/** The container port of a `-p` value: `8080:80`, `127.0.0.1:5432:5432/tcp` and `80` all name one. */
function publishedTarget(spec: string): string {
  const bare = spec.split("/")[0] ?? "";
  return bare.split(":").at(-1) ?? bare;
}

function translateRun(argv: readonly string[], ctx: TaskDockerContext): TaskDockerPlan {
  const parsed = parseUser(argv, RUN_USER);
  const [imageRef, ...command] = parsed.rest;
  if (imageRef === undefined) return refuse("docker run needs an image.");
  if (command.length > MAX_COMMAND || command.some((a) => a.length > 4_000 || a.includes("\u0000"))) {
    return refuse("The container's command is too long or holds NUL.");
  }
  const typedName = single(parsed, "name");
  const userName = typedName ?? `r${randomBytes(4).toString("hex")}`;
  if (!USER_NAME.test(userName)) return refuse(`The container name ${shown(userName)} is not allowed.`);
  const notes: string[] = [];
  const names = taskNames(ctx.safety.task);
  for (const network of values(parsed, "network")) {
    if (network === "host") {
      return refuse(
        "A task's container is never on the host network. It reaches the others of the task by name, and the public internet.",
        "host_network",
      );
    }
    if (network === "none" || network.startsWith("container:") || network.startsWith("ns:")) {
      return refuse(
        `--network ${shown(network)} is not allowed. A task's containers share one network, ${names.network}.`,
        "network_not_allowed",
      );
    }
  }
  if (has(parsed, "network"))
    notes.push(
      `--network is the task's own network, ${names.network}: every container of this task is on it.`,
    );
  const published = values(parsed, "publish");
  if (published.length > 0) {
    notes.push(
      `Nothing is published on the computer. From this task, reach it at ${[...new Set(published.map(publishedTarget))].map((port) => `${userName}:${port}`).join(", ")}.`,
    );
  }
  const envFiles = values(parsed, "env-file").flatMap((file) => {
    const read = ctx.envFiles?.get(resolve(ctx.cwd, file));
    if (read === undefined)
      return refuse(`The env file ${shown(file)} could not be read.`, "env_file_outside");
    if ("refused" in read) throw read.refused;
    return read.pairs;
  });
  const health = single(parsed, "health-cmd");
  const spec: RunSpec = {
    name: userName,
    anonymous: typedName === undefined,
    aliases: values(parsed, "alias"),
    image: imageRef,
    rm: has(parsed, "rm"),
    detach: has(parsed, "detach"),
    readOnly: has(parsed, "read-only"),
    env: [...envFiles, ...values(parsed, "env")],
    mounts: [
      ...values(parsed, "volume").map((v) => mountOf(v, ctx)),
      ...values(parsed, "tmpfs").map((target): Mount => {
        if (!matches(ContainerPathSchema, target))
          return refuse(`The mount path ${shown(target)} is not allowed.`);
        return { arg: `type=tmpfs,target=${target}` };
      }),
    ],
    workdir: single(parsed, "workdir"),
    entrypoint: single(parsed, "entrypoint"),
    user: single(parsed, "user"),
    platform: single(parsed, "platform"),
    shmSize: single(parsed, "shm-size"),
    health:
      health === undefined
        ? undefined
        : {
            cmd: health,
            interval: single(parsed, "health-interval"),
            timeout: single(parsed, "health-timeout"),
            retries: single(parsed, "health-retries"),
            startPeriod: single(parsed, "health-start-period"),
          },
    command,
  };
  return buildRunPlan(spec, ctx, notes);
}

// ---------------------------------------------------------------------------
// docker build

const BUILD_USER: UserTable = {
  "-t": flag("tag", true),
  "--tag": flag("tag", true),
  "-f": flag("file", true),
  "--file": flag("file", true),
  "--build-arg": flag("build-arg", true),
  "--target": flag("target", true),
  "--no-cache": flag("no-cache"),
  // Accepted and ignored.
  "--pull": flag("pull"),
  "-q": flag("quiet"),
  "--quiet": flag("quiet"),
  "--progress": flag("progress", true),
};

function translateBuild(argv: readonly string[], ctx: TaskDockerContext): TaskDockerPlan {
  const names = taskNames(ctx.safety.task);
  const parsed = parseUser(argv, BUILD_USER);
  const [context, ...extra] = parsed.rest;
  if (context === undefined || extra.length > 0) return refuse("docker build needs one folder to build.");
  if (context === "-" || /^[a-z]+:\/\//.test(context) || context.includes("@")) {
    return refuse("A build reads a folder of the task, not a URL or stdin.");
  }
  const tag = single(parsed, "tag");
  const real = tag === undefined ? undefined : localImage(ctx.safety.task, tag);
  if (real === undefined) return refuse("Name the image with -t, like -t web:test.");
  const root = resolve(ctx.cwd, context);
  const file = single(parsed, "file");
  const target = single(parsed, "target");
  const args = [
    "buildx",
    "build",
    "--builder",
    names.builder,
    "--load",
    "--progress",
    "plain",
    "--tag",
    real,
    "--file",
    file === undefined ? resolve(root, "Dockerfile") : resolve(ctx.cwd, file),
    ...(target === undefined ? [] : ["--target", target]),
    ...values(parsed, "build-arg").flatMap((a) => ["--build-arg", a]),
    ...(has(parsed, "no-cache") ? ["--no-cache"] : []),
    "--label",
    "majhi.container=image",
    "--label",
    `majhi.task=${ctx.safety.task}`,
    root,
  ];
  assertTaskArgv(args, ctx.safety, ctx.allowedImages);
  return { kind: "build", args };
}

// ---------------------------------------------------------------------------
// The rest: exec, logs, ps, rm, stop, start, wait, inspect

const EXEC_USER: UserTable = {
  "-i": flag("interactive"),
  "-t": flag("tty"),
  "-e": flag("env", true),
  "--env": flag("env", true),
  "-w": flag("workdir", true),
  "--workdir": flag("workdir", true),
};
const LOGS_USER: UserTable = {
  "--tail": flag("tail", true),
  "-n": flag("tail", true),
  "-t": flag("timestamps"),
  "--timestamps": flag("timestamps"),
  "--since": flag("since", true),
};
const PS_USER: UserTable = {
  "-a": flag("all"),
  "--all": flag("all"),
  "-q": flag("quiet"),
  "--quiet": flag("quiet"),
  "--filter": flag("filter", true),
  "-f": flag("filter", true),
  "--format": flag("format", true),
};
const RM_USER: UserTable = {
  "-f": flag("force"),
  "--force": flag("force"),
  "-v": flag("volumes"),
  "--volumes": flag("volumes"),
};
const STOP_USER: UserTable = { "-t": flag("time", true), "--time": flag("time", true) };
const INSPECT_USER: UserTable = { "-f": flag("format", true), "--format": flag("format", true) };
const NO_FLAGS: UserTable = {};

const FORMAT = /^[\x20-\x7e]{1,200}$/;
const SINCE = /^[0-9]{1,6}[smh]?$/;
const COUNT = /^([0-9]{1,6}|all)$/;

function operands(rest: readonly string[], ctx: TaskDockerContext, verb: string): string[] {
  if (rest.length === 0) return refuse(`docker ${verb} needs a container.`);
  if (rest.length > 20) return refuse("At most 20 containers in one call.");
  return rest.map((c) => containerOperand(c, ctx));
}

function translateOther(verb: string, argv: readonly string[], ctx: TaskDockerContext): TaskDockerPlan {
  const names = taskNames(ctx.safety.task);
  switch (verb) {
    case "exec": {
      const p = parseUser(argv, EXEC_USER);
      const [container, ...command] = p.rest;
      if (container === undefined || command.length === 0)
        return refuse("docker exec needs a container and a command.");
      if (command.length > MAX_COMMAND) return refuse("The command is too long.");
      const workdir = single(p, "workdir");
      const args = [
        "exec",
        ...values(p, "env").flatMap((e) => ["--env", e]),
        ...(workdir === undefined ? [] : ["--workdir", workdir]),
        containerOperand(container, ctx),
        ...command,
      ];
      assertTaskArgv(args, ctx.safety, ctx.allowedImages);
      return { kind: "call", args };
    }
    case "logs": {
      const p = parseUser(argv, LOGS_USER);
      if (p.rest.length !== 1) return refuse("docker logs reads one container.");
      const tail = single(p, "tail");
      const since = single(p, "since");
      const args = [
        "logs",
        ...(has(p, "timestamps") ? ["--timestamps"] : []),
        ...(tail === undefined ? [] : ["--tail", tail]),
        ...(since === undefined ? [] : ["--since", since]),
        containerOperand(p.rest[0] ?? "", ctx),
      ];
      assertTaskArgv(args, ctx.safety, ctx.allowedImages);
      return { kind: "call", args };
    }
    case "ps": {
      const p = parseUser(argv, PS_USER);
      if (p.rest.length > 0) return refuse("docker ps takes flags only.");
      const format = single(p, "format");
      const args = [
        "ps",
        ...(has(p, "all") ? ["-a"] : []),
        ...(has(p, "quiet") ? ["-q"] : []),
        "--filter",
        `label=majhi.container=${TASK_RUN_KIND}`,
        "--filter",
        `label=majhi.task=${ctx.safety.task}`,
        ...values(p, "filter").flatMap((f) => {
          const [key, ...rest] = f.split("=");
          const value = rest.join("=");
          if (key === "name") return ["--filter", `name=${names.containerPrefix}${value}`];
          if (key === "status") return ["--filter", `status=${value}`];
          return refuse(`The ps filter ${shown(f)} is not allowed.`);
        }),
        ...(format === undefined ? [] : ["--format", format]),
      ];
      assertTaskArgv(args, ctx.safety, ctx.allowedImages);
      return { kind: "call", args };
    }
    case "rm": {
      const p = parseUser(argv, RM_USER);
      const args = [
        "rm",
        ...(has(p, "force") ? ["-f"] : []),
        ...(has(p, "volumes") ? ["-v"] : []),
        ...operands(p.rest, ctx, verb),
      ];
      assertTaskArgv(args, ctx.safety, ctx.allowedImages);
      return { kind: "call", args };
    }
    case "stop": {
      const p = parseUser(argv, STOP_USER);
      const time = single(p, "time");
      const args = ["stop", ...(time === undefined ? [] : ["--time", time]), ...operands(p.rest, ctx, verb)];
      assertTaskArgv(args, ctx.safety, ctx.allowedImages);
      return { kind: "call", args };
    }
    case "start":
    case "wait": {
      const p = parseUser(argv, NO_FLAGS);
      const args = [verb, ...operands(p.rest, ctx, verb)];
      assertTaskArgv(args, ctx.safety, ctx.allowedImages);
      return { kind: "call", args };
    }
    case "inspect": {
      const p = parseUser(argv, INSPECT_USER);
      const format = single(p, "format");
      const args = [
        "inspect",
        ...(format === undefined ? [] : ["--format", format]),
        ...operands(p.rest, ctx, verb),
      ];
      assertTaskArgv(args, ctx.safety, ctx.allowedImages);
      return { kind: "call", args };
    }
    default:
      return refuse(`docker ${shown(verb)} is not available in a task.`, "command_not_available");
  }
}

/**
 * What a task's script typed after `docker`, as the call majhi makes. Throws `ContainerRefused`
 * (with the reason, for the script's stderr) for anything outside the short list.
 */
export function translateTaskDocker(argv: readonly string[], ctx: TaskDockerContext): TaskDockerPlan {
  const [first, ...rest] = argv;
  if (first === undefined) return refuse("docker needs a command.");
  switch (first) {
    case "run":
      return translateRun(rest, ctx);
    case "build":
      return translateBuild(rest, ctx);
    case "buildx":
      if (rest[0] === "build") return translateBuild(rest.slice(1), ctx);
      return refuse("Only docker buildx build is available in a task.");
    case "container":
      return rest[0] === undefined
        ? refuse("docker container needs a command.")
        : translateTaskDocker(rest[0] === "ls" ? ["ps", ...rest.slice(1)] : rest, ctx);
    case "version":
    case "info":
      return {
        kind: "text",
        stdout: "majhi runs the containers of this task. Docker commands go to majhi.\n",
      };
    case "pull":
      return { kind: "text", stdout: "docker run pulls the image when it starts.\n" };
    case "compose":
      return { kind: "compose", invocation: parseCompose(rest, ctx.cwd) };
    case "network":
      return networkText(rest, ctx);
    default:
      return translateOther(first, rest, ctx);
  }
}

/**
 * `docker network ...`: a task has one network, which every container of it is on, so a script's own
 * `network create` and `--network` mean that one. Nothing is made and nothing can join another.
 */
function networkText(rest: readonly string[], ctx: TaskDockerContext): TaskDockerPlan {
  const names = taskNames(ctx.safety.task);
  const [verb, ...more] = rest;
  const one = `The containers of ${ctx.safety.task} share one network, ${names.network}. They reach each other by name.\n`;
  switch (verb) {
    case "create":
      return {
        kind: "text",
        stdout: `${more.filter((a) => !a.startsWith("-")).at(-1) ?? names.network}\n${one}`,
      };
    case "ls":
      return { kind: "text", stdout: `${names.network}\n` };
    case "rm":
    case "connect":
    case "disconnect":
    case "inspect":
      return { kind: "text", stdout: one };
    default:
      return refuse(
        `docker network ${shown(verb ?? "")} is not available in a task. ${one.trim()}`,
        "command_not_available",
      );
  }
}

/** Takes the task's prefixes off what comes back, so the script sees the names it typed. */
export function showUserNames(task: string, text: string): string {
  const names = taskNames(task);
  return text.replaceAll(names.containerPrefix, "").replaceAll(names.imagePrefix, "");
}

// ---------------------------------------------------------------------------
// The allow list for the canonical call

const RUN_FLAGS: FlagTable = {
  "--rm": false,
  "--detach": false,
  "--name": true,
  "--label": true,
  "--cap-drop": true,
  "--cap-add": true,
  "--security-opt": true,
  "--pids-limit": true,
  "--memory": true,
  "--cpus": true,
  "--network": true,
  "--read-only": false,
  "--user": true,
  "--platform": true,
  "--shm-size": true,
  "--health-cmd": true,
  "--health-interval": true,
  "--health-timeout": true,
  "--health-retries": true,
  "--health-start-period": true,
  "--mount": true,
  "--env": true,
  "--workdir": true,
  "--entrypoint": true,
};
const BUILD_FLAGS: FlagTable = {
  "--builder": true,
  "--load": false,
  "--progress": true,
  "--tag": true,
  "--file": true,
  "--target": true,
  "--build-arg": true,
  "--no-cache": false,
  "--label": true,
};
const EXEC_FLAGS: FlagTable = { "--env": true, "--workdir": true };
const LOGS_FLAGS: FlagTable = { "--timestamps": false, "--tail": true, "--since": true };
const PS_FLAGS: FlagTable = { "-a": false, "-q": false, "--filter": true, "--format": true };
const RM_FLAGS: FlagTable = { "-f": false, "-v": false };
const STOP_FLAGS: FlagTable = { "--time": true };
const NO_FLAGS_TABLE: FlagTable = {};
const INSPECT_FLAGS: FlagTable = { "--format": true };

/** Flags, then the rest. A flag that is not in the table is refused; a value is taken whatever it looks like. */
function split(args: readonly string[], table: FlagTable): { flags: string[]; rest: string[] } {
  const flags: string[] = [];
  let i = 0;
  while (i < args.length && (args[i] ?? "").startsWith("-")) {
    const name = args[i] ?? "";
    const takes = Object.hasOwn(table, name) ? table[name] : undefined;
    if (takes === undefined) return refuse(`The docker flag ${shown(name)} is not allowed.`);
    flags.push(name);
    i++;
    if (takes) {
      const value = args[i];
      if (value === undefined) return refuse(`The docker flag ${name} needs a value.`);
      flags.push(value);
      i++;
    }
  }
  return { flags, rest: args.slice(i) };
}

const MOUNT_TARGET = (target: string) => matches(ContainerPathSchema, target);

/** One `--mount` of a task: a bind mount inside the task folder, a volume of the task, or a memory folder. */
function checkMount(spec: string, s: Safety): void {
  const names = taskNames(s.task);
  const bind = /^type=bind,source=([^,]+),target=([^,]+)(,readonly)?$/.exec(spec);
  if (bind !== null) {
    const [, source = "", target = ""] = bind;
    if (!MOUNT_TARGET(target)) refuse(`The mount ${shown(spec)} is not allowed.`);
    if (source.includes("docker.sock")) refuse("A container cannot use the Docker socket.", "socket_mount");
    // The task folder, symlinks followed, and never a `.git` folder: a repo's hooks and config stay out of a container's reach.
    assertReadable(source, s, "mount source", "mount_outside");
    if (source.split("/").includes(".git"))
      refuse("A container cannot mount a .git folder.", "mount_outside");
    return;
  }
  const named = /^type=volume,source=([^,]+),target=([^,]+)(,readonly)?$/.exec(spec);
  if (named !== null) {
    const [, source = "", target = ""] = named;
    const volume = source.startsWith(names.volumePrefix) ? source.slice(names.volumePrefix.length) : "";
    if (!matches(ContainerNameSchema, volume) || !MOUNT_TARGET(target)) {
      refuse(
        `The mount ${shown(spec)} is not allowed. A container mounts only volumes named ${names.volumePrefix}<name>.`,
        "mount_outside",
      );
    }
    return;
  }
  const anonymous = /^type=(volume|tmpfs),target=([^,]+)(,readonly)?$/.exec(spec);
  if (anonymous === null || !MOUNT_TARGET(anonymous[2] ?? ""))
    refuse(`The mount ${shown(spec)} is not allowed.`);
}

function checkOwnContainer(name: string, s: Safety): void {
  const prefix = taskNames(s.task).containerPrefix;
  if (!name.startsWith(prefix) || !USER_NAME.test(name.slice(prefix.length))) {
    refuse(`${shown(name)} is not a container of ${s.task}.`);
  }
}

/** The `majhi.*` labels a task container may carry: its kind, its task and, in compose, its service. */
const TASK_LABEL_KEYS = new Set(["majhi.container", "majhi.task", "majhi.compose"]);

function checkRun(args: readonly string[], s: Safety, allowedImages: readonly string[]): void {
  const names = taskNames(s.task);
  const { flags: raw, rest } = split(args.slice(1), RUN_FLAGS);
  const flags: Flag[] = parseFlags(raw, RUN_FLAGS);
  const name = one(flags, "--name");
  checkOwnContainer(name, s);
  const userName = name.slice(names.containerPrefix.length);
  checkLabels(flags, s, [TASK_RUN_KIND]);
  for (const label of all(flags, "--label")) {
    if (!TASK_LABEL_KEYS.has(label.split("=")[0] ?? "")) refuse(`The label ${shown(label)} is not allowed.`);
  }
  if (one(flags, "--cap-drop") !== "ALL") refuse("A container must drop all capabilities.");
  for (const cap of all(flags, "--cap-add")) {
    if (!CAPS.includes(cap)) refuse(`The capability ${shown(cap)} is not allowed.`, "capability_not_allowed");
  }
  const options = all(flags, "--security-opt");
  if (options.length !== 1 || options[0] !== "no-new-privileges") {
    refuse(
      "A container must run with --security-opt no-new-privileges, and nothing else.",
      "capability_not_allowed",
    );
  }
  const pids = one(flags, "--pids-limit");
  if (!/^[1-9][0-9]{0,2}$/.test(pids) || Number(pids) > PIDS_LIMIT)
    refuse(`The process limit ${pids} is not allowed.`);
  checkLimits(flags);
  if (one(flags, "--network") !== `container:${names.holder(userName)}`) {
    refuse(
      `A container runs in the network of ${names.holder(userName)}, and no other.`,
      "network_not_allowed",
    );
  }
  const user = atMostOne(flags, "--user");
  if (user !== undefined && !USER_SPEC.test(user)) refuse(`The user ${shown(user)} is not allowed.`);
  const platform = atMostOne(flags, "--platform");
  if (platform !== undefined && !PLATFORM.test(platform))
    refuse(`The platform ${shown(platform)} is not allowed.`);
  const shm = atMostOne(flags, "--shm-size");
  if (shm !== undefined && !SHM.test(shm)) refuse(`The --shm-size ${shown(shm)} is not allowed.`);
  const healthCmd = atMostOne(flags, "--health-cmd");
  if (healthCmd !== undefined) {
    checkHealth({
      cmd: healthCmd,
      interval: atMostOne(flags, "--health-interval"),
      timeout: atMostOne(flags, "--health-timeout"),
      retries: atMostOne(flags, "--health-retries"),
      startPeriod: atMostOne(flags, "--health-start-period"),
    });
  } else if (flags.some((f) => f.name.startsWith("--health-"))) {
    refuse("A health check needs --health-cmd.");
  }
  const mounts = all(flags, "--mount");
  if (mounts.length > MAX_MOUNTS) refuse(`At most ${MAX_MOUNTS} volumes.`);
  for (const mount of mounts) checkMount(mount, s);
  checkKeyValues(all(flags, "--env"), MAX_ENV, 4_000, "environment variables");
  const workdir = atMostOne(flags, "--workdir");
  if (workdir !== undefined && !matches(ContainerPathSchema, workdir))
    refuse(`The folder ${shown(workdir)} is not allowed.`);
  const entrypoint = atMostOne(flags, "--entrypoint");
  if (entrypoint !== undefined && (entrypoint.length > 2_000 || entrypoint.includes("\u0000"))) {
    refuse("The entrypoint is too long or holds NUL.");
  }
  const [image = "", ...command] = rest;
  if (image === "") refuse("docker run needs an image.");
  if (command.length > MAX_COMMAND || command.some((a) => a.length > 4_000 || a.includes("\u0000"))) {
    refuse("The container's command is too long or holds NUL.");
  }
  if (!matches(ImageRefSchema, image)) refuse(`The image ${shown(image)} is not allowed.`);
  if (image.startsWith("majhi-")) {
    // Only an image this task built. Never another task's, the preview's or majhi's own.
    if (!image.startsWith(names.imagePrefix)) refuse(`The image ${shown(image)} is not this task's.`);
  } else if (!allowedImages.some((allowed) => sameImage(allowed, image))) {
    throw new ImageNotAllowed(image, userName);
  }
}

function checkBuild(args: readonly string[], s: Safety): void {
  const names = taskNames(s.task);
  const { flags: raw, rest } = split(args.slice(2), BUILD_FLAGS);
  const flags = parseFlags(raw, BUILD_FLAGS);
  if (one(flags, "--builder") !== names.builder) refuse(`A build runs on its own builder, ${names.builder}.`);
  if (!is(flags, "--load")) refuse("A build must use --load.");
  if (one(flags, "--progress") !== "plain") refuse("A build must use --progress plain.");
  const tag = one(flags, "--tag");
  if (!tag.startsWith(names.imagePrefix) || !BUILT_TAG.test(tag.slice(names.imagePrefix.length))) {
    refuse(`A build is tagged ${names.imagePrefix}<name>.`);
  }
  checkKeyValues(all(flags, "--build-arg"), 32, 1_000, "build arguments");
  checkLabels(flags, s, ["image"]);
  if (rest.length !== 1) refuse("A build takes one folder.");
  assertReadable(one(flags, "--file"), s, "Dockerfile");
  assertReadable(rest[0] ?? "", s, "build context");
}

function checkOperands(args: readonly string[], s: Safety, table: FlagTable): void {
  const { rest } = split(args.slice(1), table);
  if (rest.length === 0) refuse("A container is needed.");
  for (const name of rest) checkOwnContainer(name, s);
}

function checkFormat(flags: Flag[]): void {
  const format = atMostOne(flags, "--format");
  if (format !== undefined && !FORMAT.test(format)) refuse("The --format value is not allowed.");
}

function checkPs(args: readonly string[], s: Safety): void {
  const names = taskNames(s.task);
  const { flags: raw, rest } = split(args.slice(1), PS_FLAGS);
  if (rest.length > 0) refuse("docker ps takes flags only.");
  const flags = parseFlags(raw, PS_FLAGS);
  const filters = all(flags, "--filter");
  if (
    !filters.includes(`label=majhi.container=${TASK_RUN_KIND}`) ||
    !filters.includes(`label=majhi.task=${s.task}`)
  ) {
    refuse("docker ps lists the containers of the task only.");
  }
  for (const f of filters) {
    if (f.startsWith("label=")) {
      if (f !== `label=majhi.container=${TASK_RUN_KIND}` && f !== `label=majhi.task=${s.task}`) {
        refuse(`The ps filter ${shown(f)} is not allowed.`);
      }
    } else if (f.startsWith("name=")) {
      const value = f.slice("name=".length);
      if (
        !value.startsWith(names.containerPrefix) ||
        !/^[a-z0-9_.-]*$/.test(value.slice(names.containerPrefix.length))
      ) {
        refuse(`The ps filter ${shown(f)} is not allowed.`);
      }
    } else if (!/^status=(running|exited|created|paused)$/.test(f)) {
      refuse(`The ps filter ${shown(f)} is not allowed.`);
    }
  }
  checkFormat(flags);
}

/**
 * Throws `ContainerRefused` unless the call is one a task's script may make, with only the flags
 * it may have. `allowedImages` is the owner's list. Runs before every call that reaches Docker.
 */
export function assertTaskArgv(args: readonly string[], s: Safety, allowedImages: readonly string[]): void {
  assertNoHostPaths(args, s);
  switch (args[0]) {
    case "run":
      checkRun(args, s, allowedImages);
      return;
    case "buildx":
      if (args[1] !== "build") {
        refuse("Only docker buildx build is available in a task.");
        return;
      }
      checkBuild(args, s);
      return;
    case "exec": {
      const { flags, rest } = split(args.slice(1), EXEC_FLAGS);
      const parsed = parseFlags(flags, EXEC_FLAGS);
      checkKeyValues(all(parsed, "--env"), 32, 4_000, "environment variables");
      const workdir = atMostOne(parsed, "--workdir");
      if (workdir !== undefined && !matches(ContainerPathSchema, workdir))
        refuse(`The folder ${shown(workdir)} is not allowed.`);
      if (rest.length < 2) refuse("docker exec needs a container and a command.");
      checkOwnContainer(rest[0] ?? "", s);
      return;
    }
    case "logs": {
      const { flags, rest } = split(args.slice(1), LOGS_FLAGS);
      const parsed = parseFlags(flags, LOGS_FLAGS);
      const tail = atMostOne(parsed, "--tail");
      if (tail !== undefined && !COUNT.test(tail)) refuse("The --tail value is not allowed.");
      const since = atMostOne(parsed, "--since");
      if (since !== undefined && !SINCE.test(since)) refuse("The --since value is not allowed.");
      if (rest.length !== 1) refuse("docker logs reads one container.");
      checkOwnContainer(rest[0] ?? "", s);
      return;
    }
    case "ps":
      checkPs(args, s);
      return;
    case "rm":
      checkOperands(args, s, RM_FLAGS);
      return;
    case "stop": {
      const { flags } = split(args.slice(1), STOP_FLAGS);
      const time = atMostOne(parseFlags(flags, STOP_FLAGS), "--time");
      if (time !== undefined && !/^[0-9]{1,3}$/.test(time)) refuse("The --time value is not allowed.");
      checkOperands(args, s, STOP_FLAGS);
      return;
    }
    case "start":
    case "wait":
      checkOperands(args, s, NO_FLAGS_TABLE);
      return;
    case "inspect": {
      const { flags } = split(args.slice(1), INSPECT_FLAGS);
      checkFormat(parseFlags(flags, INSPECT_FLAGS));
      checkOperands(args, s, INSPECT_FLAGS);
      return;
    }
    default:
      refuse(`The docker command ${shown(args[0] ?? "")} is not allowed in a task.`);
      return;
  }
}

export { CONTAINER_ID as TASK_CONTAINER_ID };
