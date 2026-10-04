import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ContainerNameSchema, ContainerPathSchema, ImageRefSchema, sameImage } from "@majhi/shared";
import {
  all,
  assertNoHostPaths,
  assertReadable,
  atMostOne,
  CAPS,
  checkKeyValues,
  checkLabels,
  checkLimits,
  ContainerRefused,
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
} from "./args.ts";
import { containerNames } from "./names.ts";

/**
 * The `docker` a task's own scripts call (a repo's hand-off check, a test run). A runner has no
 * Docker and never gets the socket. Its `docker` is a shim that sends the arguments to majhi
 * (`/mcp/docker`, bearer token of the run), and this file turns them into a call majhi allows:
 *
 * 1. `translateTaskDocker` reads what the script typed (`docker run -d --name web -v $PWD:/site nginx`)
 *    and builds the canonical call: names prefixed with the task, the task's labels, the task's
 *    internal network, majhi's limits and capabilities. Flags it does not know are refused.
 * 2. `assertTaskArgv` checks the canonical call against an allow list again. `DockerCli.task` runs it
 *    before every call, so whatever built the arguments, nothing unchecked reaches Docker.
 *
 * The rules: only containers whose name starts with this task's prefix and that carry its labels;
 * mounts are bind mounts inside the task folder or this task's named volumes; no published port,
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
const BAD_SOURCE = /[,"'\u0000\n\r]/;
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
}

/** The image is not on the owner's list and the task did not build it. The caller may ask the owner. */
export class ImageNotAllowed extends ContainerRefused {
  constructor(readonly image: string) {
    super(
      `${image} is not an image this task built or the owner allowed.`,
    );
  }
}

export function taskNames(task: string) {
  const names = containerNames(task);
  return {
    ...names,
    containerPrefix: `majhi-${names.key}-c-`,
    imagePrefix: `majhi-${names.key}-img-`,
  };
}

/** What a run of the shim does with a translated call. */
export type TaskDockerPlan =
  | { kind: "text"; stdout: string }
  | { kind: "run"; args: string[]; name: string; detach: boolean; volumes: string[] }
  | { kind: "build"; args: string[] }
  | { kind: "call"; args: string[] };

// ---------------------------------------------------------------------------
// Reading what the script typed

interface UserFlag {
  /** The long name without dashes, like `detach`. */
  to: string;
  takes: boolean;
}
type UserTable = Record<string, UserFlag>;
interface Parsed {
  flags: { to: string; value: string }[];
  rest: string[];
}

const flag = (to: string, takes = false): UserFlag => ({ to, takes });

/** `-it`, `-e A=1`, `-eA=1`, `--env A=1`, `--env=A=1`. Stops at the first word that is not a flag, or at `--`. */
function parseUser(argv: readonly string[], table: UserTable): Parsed {
  const flags: Parsed["flags"] = [];
  const unknown = (name: string): never =>
    refuse(`The docker flag ${shown(name)} is not allowed in a task.`);
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (token === "--") {
      i++;
      break;
    }
    if (!token.startsWith("-") || token === "-") break;
    i++;
    if (token.startsWith("--")) {
      const at = token.indexOf("=");
      const name = at === -1 ? token : token.slice(0, at);
      const spec = Object.hasOwn(table, name) ? table[name] : undefined;
      if (spec === undefined) return unknown(name);
      if (!spec.takes) {
        if (at !== -1) refuse(`The docker flag ${name} takes no value.`);
        flags.push({ to: spec.to, value: "" });
        continue;
      }
      let value: string | undefined;
      if (at !== -1) value = token.slice(at + 1);
      else {
        value = argv[i];
        i++;
      }
      if (value === undefined) return refuse(`The docker flag ${name} needs a value.`);
      flags.push({ to: spec.to, value });
      continue;
    }
    // Short flags, possibly joined: `-it`, `-eNAME=1`.
    for (let c = 1; c < token.length; c++) {
      const name = `-${token[c]}`;
      const spec = Object.hasOwn(table, name) ? table[name] : undefined;
      if (spec === undefined) return unknown(name);
      if (!spec.takes) {
        flags.push({ to: spec.to, value: "" });
        continue;
      }
      let value = token.slice(c + 1);
      if (value === "") {
        const next = argv[i];
        if (next === undefined) return refuse(`The docker flag ${name} needs a value.`);
        value = next;
        i++;
      }
      flags.push({ to: spec.to, value });
      break;
    }
  }
  return { flags, rest: argv.slice(i) };
}

const values = (p: Parsed, to: string): string[] => p.flags.filter((f) => f.to === to).map((f) => f.value);
const has = (p: Parsed, to: string): boolean => p.flags.some((f) => f.to === to);
function single(p: Parsed, to: string): string | undefined {
  const found = values(p, to);
  if (found.length > 1) return refuse(`--${to} can be given once.`);
  return found[0];
}

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

function runImage(ref: string, ctx: TaskDockerContext): string {
  if (!matches(ImageRefSchema, ref)) return refuse(`The image ${shown(ref)} is not allowed.`);
  const local = localImage(ctx.safety.task, ref);
  if (local !== undefined && ctx.builtImages.has(local)) return local;
  if (ctx.allowedImages.some((image) => sameImage(image, ref))) return ref;
  throw new ImageNotAllowed(ref);
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
  "-v": flag("volume", true),
  "--volume": flag("volume", true),
  "-w": flag("workdir", true),
  "--workdir": flag("workdir", true),
  "--entrypoint": flag("entrypoint", true),
  "--read-only": flag("read-only"),
  // Accepted and ignored: majhi sets the limits.
  "-m": flag("memory", true),
  "--memory": flag("memory", true),
  "--cpus": flag("cpus", true),
};

interface Mount {
  arg: string;
  volume?: string;
}

function mountOf(spec: string, ctx: TaskDockerContext): Mount {
  const names = taskNames(ctx.safety.task);
  const parts = spec.split(":");
  if (parts.length > 3) return refuse(`The volume ${shown(spec)} is not allowed.`);
  const [source, target, opts] = parts.length === 1 ? [undefined, parts[0], undefined] : parts;
  const mode = opts ?? "rw";
  if (mode !== "ro" && mode !== "rw") return refuse(`The volume option ${shown(mode)} is not allowed.`);
  const readonly = mode === "ro" ? ",readonly" : "";
  if (!matches(ContainerPathSchema, target ?? "")) return refuse(`The mount path ${shown(target ?? "")} is not allowed.`);
  if (source === undefined) return { arg: `type=volume,target=${target}${readonly}` };
  if (source.startsWith("/") || source.startsWith(".")) {
    if (BAD_SOURCE.test(source)) return refuse(`The mount source ${shown(source)} is not allowed.`);
    return { arg: `type=bind,source=${resolve(ctx.cwd, source)},target=${target}${readonly}` };
  }
  if (!matches(ContainerNameSchema, source)) {
    return refuse(`The volume ${shown(source)} is not allowed. Use a folder of the task or a name like data.`);
  }
  return { arg: `type=volume,source=${names.volume(source)},target=${target}${readonly}`, volume: source };
}

function translateRun(argv: readonly string[], ctx: TaskDockerContext): TaskDockerPlan {
  const names = taskNames(ctx.safety.task);
  const parsed = parseUser(argv, RUN_USER);
  const [imageRef, ...command] = parsed.rest;
  if (imageRef === undefined) return refuse("docker run needs an image.");
  if (command.length > MAX_COMMAND || command.some((a) => a.length > 4_000 || a.includes("\u0000"))) {
    return refuse("The container's command is too long or holds NUL.");
  }
  const userName = single(parsed, "name") ?? `r${randomBytes(4).toString("hex")}`;
  if (!USER_NAME.test(userName)) return refuse(`The container name ${shown(userName)} is not allowed.`);
  const mounts = values(parsed, "volume").map((spec) => mountOf(spec, ctx));
  if (mounts.length > MAX_MOUNTS) return refuse(`At most ${MAX_MOUNTS} volumes.`);
  const env = values(parsed, "env");
  const workdir = single(parsed, "workdir");
  const entrypoint = single(parsed, "entrypoint");
  const image = runImage(imageRef, ctx);
  const detach = has(parsed, "detach");
  const args = [
    "run",
    ...(has(parsed, "rm") ? ["--rm"] : []),
    ...(detach ? ["--detach"] : []),
    "--name",
    `${names.containerPrefix}${userName}`,
    "--label",
    `majhi.container=${TASK_RUN_KIND}`,
    "--label",
    `majhi.task=${ctx.safety.task}`,
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
    `name=${names.network},alias=${userName}`,
    ...(has(parsed, "read-only") ? ["--read-only"] : []),
    ...mounts.flatMap((m) => ["--mount", m.arg]),
    ...env.flatMap((e) => ["--env", e]),
    ...(workdir === undefined ? [] : ["--workdir", workdir]),
    ...(entrypoint === undefined ? [] : ["--entrypoint", entrypoint]),
    image,
    ...command,
  ];
  assertTaskArgv(args, ctx.safety, ctx.allowedImages);
  return {
    kind: "run",
    args,
    name: `${names.containerPrefix}${userName}`,
    detach,
    volumes: mounts.flatMap((m) => (m.volume === undefined ? [] : [m.volume])),
  };
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
      if (container === undefined || command.length === 0) return refuse("docker exec needs a container and a command.");
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
      return refuse(`docker ${shown(verb)} is not available in a task.`);
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
      return { kind: "text", stdout: "majhi runs the containers of this task. Docker commands go to majhi.\n" };
    case "pull":
      return { kind: "text", stdout: "docker run pulls the image when it starts.\n" };
    case "compose":
      return refuse(
        "docker compose is not available in a task. Start each container with docker run: they share the task's network and reach each other by --name.",
      );
    default:
      return translateOther(first, rest, ctx);
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

/** One `--mount` of a task: a bind mount inside the task folder, or a volume of the task. */
function checkMount(spec: string, s: Safety): void {
  const names = taskNames(s.task);
  const bind = /^type=bind,source=([^,]+),target=([^,]+)(,readonly)?$/.exec(spec);
  if (bind !== null) {
    const [, source = "", target = ""] = bind;
    if (!MOUNT_TARGET(target)) refuse(`The mount ${shown(spec)} is not allowed.`);
    // The task folder, symlinks followed, and never a `.git` folder: a repo's hooks and config stay out of a container's reach.
    assertReadable(source, s, "mount source");
    if (source.split("/").includes(".git")) refuse("A container cannot mount a .git folder.");
    return;
  }
  const named = /^type=volume,source=([^,]+),target=([^,]+)(,readonly)?$/.exec(spec);
  if (named !== null) {
    const [, source = "", target = ""] = named;
    const volume = source.startsWith(names.volumePrefix) ? source.slice(names.volumePrefix.length) : "";
    if (!matches(ContainerNameSchema, volume) || !MOUNT_TARGET(target)) {
      refuse(`The mount ${shown(spec)} is not allowed. A container mounts only volumes named ${names.volumePrefix}<name>.`);
    }
    return;
  }
  const anonymous = /^type=volume,target=([^,]+)(,readonly)?$/.exec(spec);
  if (anonymous === null || !MOUNT_TARGET(anonymous[1] ?? "")) refuse(`The mount ${shown(spec)} is not allowed.`);
}

function checkOwnContainer(name: string, s: Safety): void {
  const prefix = taskNames(s.task).containerPrefix;
  if (!name.startsWith(prefix) || !USER_NAME.test(name.slice(prefix.length))) {
    refuse(`${shown(name)} is not a container of ${s.task}.`);
  }
}

function checkRun(args: readonly string[], s: Safety, allowedImages: readonly string[]): void {
  const names = taskNames(s.task);
  const { flags: raw, rest } = split(args.slice(1), RUN_FLAGS);
  const flags: Flag[] = parseFlags(raw, RUN_FLAGS);
  const name = one(flags, "--name");
  checkOwnContainer(name, s);
  const userName = name.slice(names.containerPrefix.length);
  checkLabels(flags, s, [TASK_RUN_KIND]);
  if (one(flags, "--cap-drop") !== "ALL") refuse("A container must drop all capabilities.");
  for (const cap of all(flags, "--cap-add")) {
    if (!CAPS.includes(cap)) refuse(`The capability ${shown(cap)} is not allowed.`);
  }
  const options = all(flags, "--security-opt");
  if (options.length !== 1 || options[0] !== "no-new-privileges") {
    refuse("A container must run with --security-opt no-new-privileges, and nothing else.");
  }
  const pids = one(flags, "--pids-limit");
  if (!/^[1-9][0-9]{0,2}$/.test(pids) || Number(pids) > PIDS_LIMIT) refuse(`The process limit ${pids} is not allowed.`);
  checkLimits(flags);
  if (one(flags, "--network") !== `name=${names.network},alias=${userName}`) {
    refuse(`A container joins ${names.network} as ${userName}, and no other network.`);
  }
  const mounts = all(flags, "--mount");
  if (mounts.length > MAX_MOUNTS) refuse(`At most ${MAX_MOUNTS} volumes.`);
  for (const mount of mounts) checkMount(mount, s);
  checkKeyValues(all(flags, "--env"), 32, 4_000, "environment variables");
  const workdir = atMostOne(flags, "--workdir");
  if (workdir !== undefined && !matches(ContainerPathSchema, workdir)) refuse(`The folder ${shown(workdir)} is not allowed.`);
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
    throw new ImageNotAllowed(image);
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
      if (!value.startsWith(names.containerPrefix) || !/^[a-z0-9_.-]*$/.test(value.slice(names.containerPrefix.length))) {
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
      return checkRun(args, s, allowedImages);
    case "buildx":
      if (args[1] !== "build") return refuse("Only docker buildx build is available in a task.");
      return checkBuild(args, s);
    case "exec": {
      const { flags, rest } = split(args.slice(1), EXEC_FLAGS);
      const parsed = parseFlags(flags, EXEC_FLAGS);
      checkKeyValues(all(parsed, "--env"), 32, 4_000, "environment variables");
      const workdir = atMostOne(parsed, "--workdir");
      if (workdir !== undefined && !matches(ContainerPathSchema, workdir)) refuse(`The folder ${shown(workdir)} is not allowed.`);
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
      return checkOwnContainer(rest[0] ?? "", s);
    }
    case "ps":
      return checkPs(args, s);
    case "rm":
      return checkOperands(args, s, RM_FLAGS);
    case "stop": {
      const { flags } = split(args.slice(1), STOP_FLAGS);
      const time = atMostOne(parseFlags(flags, STOP_FLAGS), "--time");
      if (time !== undefined && !/^[0-9]{1,3}$/.test(time)) refuse("The --time value is not allowed.");
      return checkOperands(args, s, STOP_FLAGS);
    }
    case "start":
    case "wait":
      return checkOperands(args, s, NO_FLAGS_TABLE);
    case "inspect": {
      const { flags } = split(args.slice(1), INSPECT_FLAGS);
      checkFormat(parseFlags(flags, INSPECT_FLAGS));
      return checkOperands(args, s, INSPECT_FLAGS);
    }
    default:
      return refuse(`The docker command ${shown(args[0] ?? "")} is not allowed in a task.`);
  }
}

export { CONTAINER_ID as TASK_CONTAINER_ID };
