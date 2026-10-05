import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runMounts } from "@majhi/acp";
import {
  BuildTargetSchema,
  type ContainerKind,
  ContainerNameSchema,
  ContainerPathSchema,
  hostPortsIssue,
  IdSchema,
  ImageRefSchema,
  MAJHI_OWN_PORTS,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import { containerNames } from "./names.ts";

/**
 * The docker calls majhi makes for agents (PRV-53), as arguments. Agents never get the Docker
 * socket. They send values (an image, a port, a volume name), majhi checks each with zod, builds
 * the arguments here, and `assertSafe` then checks the arguments themselves against an allow list:
 * a flag that is not listed is refused, whoever put it there. Every builder ends with `assertSafe`,
 * and `DockerCli` scans every argument of every call for host paths once more.
 *
 * The rules, in short: no bind mount of any kind (only `type=volume`, named for this task or
 * anonymous), never the socket, `~/.majhi`, the secrets key or `~/.ssh`, no privileged flags, every
 * container drops all capabilities but five and has limits and labels, and builds only read the
 * task folder, on the task's own builder.
 */

/** A call majhi would make was refused. The message says why, for the agent. */
export class ContainerRefused extends UserError {}

export const refuse = (message: string): never => {
  throw new ContainerRefused(message);
};

/** A docker call split the way docker parses it: words, flags, then what follows. */
export interface DockerParts {
  /** The command words, like `["run"]` or `["buildx", "build"]`. */
  verb: string[];
  /** Every flag, each as a flag and then its value. Only `--flag value`, never `--flag=value`. */
  flags: string[];
  /** The first word after the flags: the image of a run, the context of a build, the name of a network. */
  image: string | undefined;
  /** The container's own command after the image. Docker does not parse it as flags. */
  command: string[];
}

export const dockerArgv = (parts: DockerParts): string[] => [
  ...parts.verb,
  ...parts.flags,
  ...(parts.image === undefined ? [] : [parts.image]),
  ...parts.command,
];

/** Variables the docker CLI reads for itself: a container's own value for one of these stays on the line. */
const CLI_OWNED = new Set([
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
]);

/**
 * Moves each `--env NAME=value` of a run off the command line: the flag becomes `--env NAME`, which
 * the docker CLI fills from its own environment, and the value goes in `env` for that one CLI
 * process. A password a service or a database check holds then shows in no process list.
 */
export function envByName(parts: DockerParts): { parts: DockerParts; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const flags = [...parts.flags];
  for (let i = 0; i < flags.length - 1; i++) {
    if (flags[i] !== "--env") continue;
    const pair = flags[i + 1] ?? "";
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at);
    if (CLI_OWNED.has(name)) continue;
    env[name] = pair.slice(at + 1);
    flags[i + 1] = name;
  }
  return { parts: { ...parts, flags }, env };
}

/** Host places that no docker argument may name. */
export interface HostPaths {
  /** majhi's config folder. */
  majhiHome: string;
  /** The owner's home, for `.ssh`. */
  hostHome: string;
  /** More files that must stay out, like the secrets key file. */
  protectedPaths: string[];
}

/** What a task's docker calls are checked against. */
export interface Safety extends HostPaths {
  /** The task key, like `PRV-53`. */
  task: string;
  /** The network runners are on. Previews join it. */
  runnerNetwork: string;
  /** The task folder. Builds read only from inside it. */
  taskFolder: string;
  /** Ports majhi itself listens on, besides its default: no forwarder may name one. */
  ownPorts?: readonly number[] | undefined;
}

export interface Limits {
  /** CPUs per container (or for the builder). */
  cpus: number;
  /** Memory per container (or for the builder), like `2g`. */
  memory: string;
}

/** What the capabilities of a container may be: what official images need to drop to their own user. */
export const CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"];

export const PIDS_LIMIT = 512;

// ---------------------------------------------------------------------------
// Scanning for host paths

function pathForms(path: string): string[] {
  const forms = [resolve(path)];
  try {
    const real = realpathSync(path);
    if (real !== forms[0]) forms.push(real);
  } catch {
    // Missing: only the path itself can appear.
  }
  return forms;
}

/** Throws when an argument holds the Docker socket, majhi's config folder, the secrets key or `~/.ssh`. */
export function assertNoHostPaths(args: readonly string[], host: HostPaths): void {
  const banned: { fragment: string; name: string }[] = [
    { fragment: "docker.sock", name: "the Docker socket" },
    ...pathForms(host.majhiHome).map((fragment) => ({ fragment, name: "majhi's config folder" })),
    ...host.protectedPaths
      .filter(Boolean)
      .flatMap((p) => pathForms(p).map((fragment) => ({ fragment, name: "the secrets key" }))),
    ...pathForms(join(host.hostHome, ".ssh")).map((fragment) => ({ fragment, name: "~/.ssh" })),
  ];
  for (const arg of args) {
    for (const { fragment, name } of banned) {
      if (fragment !== "" && arg.includes(fragment)) refuse(`A container cannot use ${name}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing flags against an allow list

/** Flag name to whether it takes a value. */
export type FlagTable = Record<string, boolean>;
export interface Flag {
  name: string;
  value: string;
}

export function parseFlags(flags: readonly string[], table: FlagTable): Flag[] {
  const out: Flag[] = [];
  for (let i = 0; i < flags.length; i++) {
    const name = flags[i] ?? "";
    const takesValue = Object.hasOwn(table, name) ? table[name] : undefined;
    if (takesValue === undefined) return refuse(`The docker flag ${shown(name)} is not allowed.`);
    if (!takesValue) {
      out.push({ name, value: "" });
      continue;
    }
    i++;
    const value = flags[i];
    if (value === undefined) return refuse(`The docker flag ${name} needs a value.`);
    out.push({ name, value });
  }
  return out;
}

export const shown = (text: string) => (text.length > 40 ? `${text.slice(0, 37)}...` : text);

export const all = (flags: Flag[], name: string): string[] =>
  flags.filter((f) => f.name === name).map((f) => f.value);

export function one(flags: Flag[], name: string): string {
  const values = all(flags, name);
  if (values.length !== 1) return refuse(`Exactly one ${name} is needed.`);
  return values[0] ?? "";
}

export function atMostOne(flags: Flag[], name: string): string | undefined {
  const values = all(flags, name);
  if (values.length > 1) return refuse(`${name} can be given once.`);
  return values[0];
}

export function is(flags: Flag[], name: string): boolean {
  return flags.some((f) => f.name === name);
}

const LABEL_KEY = /^majhi\.[a-z][a-z.-]{0,40}$/;
const LABEL_VALUE = /^[A-Za-z0-9._-]{1,100}$/;

/** `majhi.*` labels only. Returns them by key. */
function labelsOf(flags: Flag[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const spec of all(flags, "--label")) {
    const at = spec.indexOf("=");
    const key = at === -1 ? spec : spec.slice(0, at);
    const value = at === -1 ? "" : spec.slice(at + 1);
    if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value))
      return refuse(`The label ${shown(spec)} is not allowed.`);
    if (labels.has(key)) return refuse(`The label ${key} is given twice.`);
    labels.set(key, value);
  }
  return labels;
}

export function checkLabels(flags: Flag[], s: Safety, kinds: string[]): string {
  const labels = labelsOf(flags);
  const kind = labels.get("majhi.container") ?? "";
  if (!kinds.includes(kind)) return refuse(`The label majhi.container must be ${kinds.join(" or ")}.`);
  if (labels.get("majhi.task") !== s.task) return refuse(`The label majhi.task must be ${s.task}.`);
  return kind;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** `NAME=value` pairs. A bare `NAME` would make the CLI pass on a value of majhi's own environment. */
export function checkKeyValues(specs: string[], max: number, maxValue: number, what: string): void {
  if (specs.length > max) refuse(`At most ${max} ${what}.`);
  for (const spec of specs) {
    const at = spec.indexOf("=");
    if (at === -1 || !ENV_NAME.test(spec.slice(0, at))) refuse(`Use NAME=value for ${what}.`);
    const value = spec.slice(at + 1);
    if (value.length > maxValue || value.includes("\u0000"))
      refuse(`A value of ${what} is too long or holds NUL.`);
  }
}

export const matches = (schema: { safeParse(v: unknown): { success: boolean } }, value: string): boolean =>
  schema.safeParse(value).success;

export function checkLimits(flags: Flag[]): void {
  const memory = one(flags, "--memory");
  if (!/^[1-9][0-9]{0,3}[mg]$/.test(memory)) refuse(`The memory limit ${shown(memory)} is not allowed.`);
  const cpus = one(flags, "--cpus");
  if (!/^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(cpus) || Number(cpus) < 0.25 || Number(cpus) > 16) {
    refuse(`The CPU limit ${shown(cpus)} is not allowed.`);
  }
}

// ---------------------------------------------------------------------------
// docker run

const RUN_FLAGS: FlagTable = {
  "--rm": false,
  "--name": true,
  "--label": true,
  "--network": true,
  "--cap-drop": true,
  "--cap-add": true,
  "--security-opt": true,
  "--pids-limit": true,
  "--memory": true,
  "--cpus": true,
  "--publish": true,
  "--mount": true,
  "--env": true,
  "--pull": true,
  "--read-only": false,
  "--tmpfs": true,
  "--add-host": true,
};

const PUBLISH = /^127\.0\.0\.1::([1-9][0-9]{0,4})$/;
const ANONYMOUS_MOUNT = /^type=volume,target=([^,]+)$/;
const NAMED_MOUNT = /^type=volume,source=([^,]+),target=([^,]+)$/;
const DBCHECK_NAME = /^majhi-dbcheck-[a-z0-9]{8,16}$/;
const DBCHECK_TMPFS = "/tmp:rw,noexec,nosuid,size=16m";
const SERVICE_NETWORK = /^name=([^,]+),alias=([^,]+)$/;
/** The only name a forwarder resolves the computer by: Docker Desktop and OrbStack know it, and Linux gets it from this flag. */
export const HOST_TARGET = "host.docker.internal";
/** Where a forwarder runs from: the script in the runner image (docker/portforward.mjs). */
export const HOST_FORWARD_SCRIPT = "/usr/local/lib/majhi/portforward.mjs";

/** Where a script run sees the programs majhi installed and checked for its workspace. */
export const TOOLS_TARGET = "/majhi-tools";
const TOOLS_MOUNT = /^type=bind,source=([^,]+),target=\/majhi-tools,readonly$/;
const TOOLS_ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** True for the one bind mount a check may have: `<majhi home>/tool-installs/<org>/bin`, read-only. */
function isToolsMount(mount: string, s: Safety): boolean {
  const source = TOOLS_MOUNT.exec(mount)?.[1];
  if (source === undefined) return false;
  const prefix = `${join(s.majhiHome, "tool-installs")}${sep}`;
  if (!source.startsWith(prefix) || !source.endsWith(`${sep}bin`)) return false;
  const org = source.slice(prefix.length, source.length - `${sep}bin`.length);
  return TOOLS_ORG.test(org);
}

function checkRun(parts: DockerParts, s: Safety): void {
  const names = containerNames(s.task);
  const flags = parseFlags(parts.flags, RUN_FLAGS);

  // Every container: no capabilities but the few, no new privileges, limits, removal and labels.
  if (!is(flags, "--rm")) refuse("A container must run with --rm.");
  if (one(flags, "--cap-drop") !== "ALL") refuse("A container must drop all capabilities.");
  // A forwarder adds only NET_BIND_SERVICE and a preview's holder only NET_ADMIN, which their own checks
  // hold to; every other container, the usual few.
  const labelled = all(flags, "--label");
  const forwarder = labelled.includes("majhi.container=hostfwd");
  const holder = labelled.includes("majhi.container=previewhold");
  for (const cap of all(flags, "--cap-add")) {
    if (
      !CAPS.includes(cap) &&
      !(forwarder && cap === "NET_BIND_SERVICE") &&
      !(holder && cap === "NET_ADMIN")
    ) {
      refuse(`The capability ${shown(cap)} is not allowed.`);
    }
  }
  const options = all(flags, "--security-opt");
  if (options.length !== 1 || options[0] !== "no-new-privileges") {
    refuse("A container must run with --security-opt no-new-privileges, and nothing else.");
  }
  const pids = one(flags, "--pids-limit");
  if (!/^[1-9][0-9]{0,2}$/.test(pids) || Number(pids) > PIDS_LIMIT)
    refuse(`The process limit ${pids} is not allowed.`);
  checkLimits(flags);
  const kind = checkLabels(flags, s, ["preview", "previewhold", "service", "dbcheck", "hostfwd"]);
  const name = one(flags, "--name");
  checkKeyValues(all(flags, "--env"), 32, 4_000, "environment variables");
  if (parts.command.length > 32 || parts.command.some((a) => a.length > 2_000 || a.includes("\u0000"))) {
    refuse("The container's command is too long or holds NUL.");
  }
  const image = parts.image ?? "";
  if (!matches(ImageRefSchema, image)) refuse(`The image ${shown(image)} is not allowed.`);

  const networks = all(flags, "--network");
  const mounts = all(flags, "--mount");
  const publishes = all(flags, "--publish");
  const pull = atMostOne(flags, "--pull");

  if (kind === "dbcheck") {
    // A database watch's client: a throwaway container on the default network (it must reach the
    // database), a read-only root, one scratch folder in memory, no mount, no published port.
    if (!DBCHECK_NAME.test(name)) refuse("A database check container is named majhi-dbcheck-<id>.");
    if (!is(flags, "--read-only")) refuse("A database check runs with a read-only root.");
    if (all(flags, "--tmpfs").join() !== DBCHECK_TMPFS)
      refuse("A database check has one scratch folder, /tmp in memory.");
    if (publishes.length > 0 || pull !== undefined)
      refuse("A database check has no published port or pull flag.");
    // `--network none`: a script that reads nothing from the network gets no network at all.
    if (networks.length > 1 || (networks[0] !== undefined && networks[0] !== "none")) {
      refuse("A database check may only be given --network none.");
    }
    // One read-only folder of programs majhi installed and checked, for the workspace's own scripts.
    if (mounts.length > 1) refuse("A database check has at most one mount, the checked programs.");
    const mount = mounts[0];
    if (mount !== undefined && !isToolsMount(mount, s)) {
      refuse(
        `The mount ${shown(mount)} is not allowed. A check mounts only majhi's checked programs, read-only.`,
      );
    }
    return;
  }
  // Naming an address for the container is how it would reach something of the computer: a forwarder only, and only the one name.
  if (kind === "previewhold") {
    checkPreviewHold(parts, flags, s, { name, networks, mounts, publishes, pull });
    return;
  }
  if (kind !== "hostfwd" && is(flags, "--add-host")) refuse("The docker flag --add-host is not allowed.");
  if (kind === "hostfwd") {
    checkHostForward(parts, flags, s, { name, networks, mounts, publishes, pull });
    return;
  }
  if (kind === "preview") {
    if (name !== names.previewApp) refuse(`The preview container must be named ${names.previewApp}.`);
    if (image !== names.previewImage) refuse(`A preview runs ${names.previewImage}, not ${shown(image)}.`);
    // The image is the one majhi built. A missing one must not be pulled from a registry.
    if (pull !== "never") refuse("A preview must run with --pull never.");
    // The preview shares the network of its holder (the guarded container that owns the port): no network
    // of its own, so it cannot join the runner network or reach anything the holder's rules refuse.
    if (networks.length !== 1 || networks[0] !== `container:${names.previewContainer}`) {
      refuse(`A preview runs in the network of ${names.previewContainer}, and no other.`);
    }
    if (publishes.length > 0) refuse("A preview's port is published by its holder.");
    // The throwaway folder: one anonymous volume.
    if (mounts.length > 1) refuse("A preview has one throwaway folder and no other mount.");
    for (const mount of mounts) {
      const target = ANONYMOUS_MOUNT.exec(mount)?.[1];
      if (target === undefined || !matches(ContainerPathSchema, target))
        refuse(`The mount ${shown(mount)} is not allowed.`);
    }
    return;
  }

  // A service: the task's own network only, nothing published, only the task's named volumes.
  const prefix = `majhi-${names.key}-`;
  const service = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (!matches(ContainerNameSchema, service) || service === "preview") {
    refuse(`A service container must be named ${prefix}<name>.`);
  }
  if (pull !== undefined) refuse("A service cannot set --pull.");
  if (publishes.length > 0)
    refuse("A service port is never published. Runners reach it through the task network.");
  const joined = SERVICE_NETWORK.exec(networks[0] ?? "");
  if (networks.length !== 1 || joined === null || joined[1] !== names.network || joined[2] !== service) {
    refuse(`A service joins ${names.network} as ${service}, and no other network.`);
  }
  if (mounts.length > 4) refuse("A service has at most 4 volumes.");
  for (const mount of mounts) {
    const match = NAMED_MOUNT.exec(mount);
    const source = match?.[1] ?? "";
    const target = match?.[2] ?? "";
    const volume = source.startsWith(names.volumePrefix) ? source.slice(names.volumePrefix.length) : "";
    if (!matches(ContainerNameSchema, volume) || !matches(ContainerPathSchema, target)) {
      refuse(
        `The mount ${shown(mount)} is not allowed. A service mounts only volumes named ${names.volumePrefix}<name>.`,
      );
    }
  }
}

/** Where a holder runs netguard from: the script in the runner image (docker/netguard.mjs). */
export const GUARD_SCRIPT = "/usr/local/lib/majhi/netguard.mjs";

/**
 * The holder of a preview (SPEC 6): the one container of a preview with the runner networks and the
 * published port. It starts netguard, which closes every private network but the task's, and then
 * only waits; the preview runs in its network namespace and holds no NET_ADMIN to undo the rules.
 * Runner image, read-only, no mount, only NET_ADMIN.
 */
function checkPreviewHold(
  parts: DockerParts,
  flags: Flag[],
  s: Safety,
  found: {
    name: string;
    networks: string[];
    mounts: string[];
    publishes: string[];
    pull: string | undefined;
  },
): void {
  const names = containerNames(s.task);
  if (found.name !== names.previewContainer)
    refuse(`The preview's holder must be named ${names.previewContainer}.`);
  if (found.pull !== "never") refuse("A preview's holder must run with --pull never.");
  if (found.mounts.length > 0) refuse("A preview's holder has no mount.");
  if (!is(flags, "--read-only")) refuse("A preview's holder runs with a read-only root.");
  if (all(flags, "--cap-add").join() !== "NET_ADMIN") refuse("A preview's holder adds NET_ADMIN, nothing else.");
  if (all(flags, "--env").length > 0) refuse("A preview's holder takes no environment.");
  if (is(flags, "--add-host") || is(flags, "--tmpfs")) refuse("A preview's holder takes no host name or scratch folder.");
  const allowed = [s.runnerNetwork, names.network];
  const [first, second, ...more] = found.networks;
  if (
    first !== s.runnerNetwork ||
    (second !== undefined && second !== names.network) ||
    more.length > 0 ||
    found.networks.some((n) => !allowed.includes(n))
  ) {
    refuse(`A preview's holder joins ${s.runnerNetwork}, and ${names.network} when the task has services.`);
  }
  const published = PUBLISH.exec(found.publishes[0] ?? "")?.[1];
  if (found.publishes.length !== 1 || published === undefined || Number(published) > 65_535) {
    refuse("A preview publishes one port, as 127.0.0.1::<port>.");
  }
  // The command is the guard script, holding, and the task network's subnets it may reach: nothing else.
  const [node, script, hold, ...rest] = parts.command;
  if (node !== "node" || script !== GUARD_SCRIPT || hold !== "--hold")
    refuse("A preview's holder runs only majhi's network guard.");
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== "--allow" || !isIpv4Cidr(rest[i + 1] ?? ""))
      refuse("A preview's holder may be told only the task network's subnets.");
  }
  if (!matches(ImageRefSchema, parts.image ?? "")) refuse("A preview's holder runs majhi's runner image.");
}

/**
 * A forwarder of a service on the owner's computer (SPEC 5.14): the one container majhi starts that
 * can reach the computer. It joins the task's network under `<id>.host` and its own network that no
 * runner joins, listens on the declared ports only, forwards each to the same port of the computer,
 * and has no capability but binding low ports, no mount and no published port.
 */
function checkHostForward(
  parts: DockerParts,
  flags: Flag[],
  s: Safety,
  found: {
    name: string;
    networks: string[];
    mounts: string[];
    publishes: string[];
    pull: string | undefined;
  },
): void {
  const names = containerNames(s.task);
  const prefix = `majhi-${names.key}-host-`;
  const id = found.name.startsWith(prefix) ? found.name.slice(prefix.length) : "";
  if (!matches(IdSchema, id)) refuse(`A forwarder is named ${prefix}<connection>.`);
  if (found.pull !== "never") refuse("A forwarder must run with --pull never.");
  if (found.mounts.length > 0 || found.publishes.length > 0)
    refuse("A forwarder has no mount and publishes no port.");
  if (!is(flags, "--read-only")) refuse("A forwarder runs with a read-only root.");
  if (all(flags, "--cap-add").some((cap) => cap !== "NET_BIND_SERVICE"))
    refuse("A forwarder may add only NET_BIND_SERVICE.");
  if (all(flags, "--env").length > 0) refuse("A forwarder takes no environment.");
  // The task's network under its alias, then the forwarder's own: nothing else, so no runner can reach it by address.
  const [joined, own, ...more] = found.networks;
  const task = SERVICE_NETWORK.exec(joined ?? "");
  if (
    task === null ||
    task[1] !== names.network ||
    task[2] !== `${id}.host` ||
    own !== names.hostNetwork ||
    more.length > 0
  ) {
    refuse(
      `A forwarder joins ${names.network} as ${id}.host and ${names.hostNetwork}, and no other network.`,
    );
  }
  if (all(flags, "--add-host").some((h) => h !== `${HOST_TARGET}:host-gateway`))
    refuse(`A forwarder may only name ${HOST_TARGET}.`);
  // The command is the script, the task network's subnet it accepts connections from, and the ports: nothing else.
  const [node, script, fromFlag, from, ...ports] = parts.command;
  if (node !== "node" || script !== HOST_FORWARD_SCRIPT || fromFlag !== "--from")
    refuse("A forwarder runs only majhi's forwarding script.");
  if (!isIpv4Cidr(from ?? "")) refuse("A forwarder accepts connections from the task network's subnet.");
  const reserved = [...MAJHI_OWN_PORTS, ...(s.ownPorts ?? [])];
  const issue = hostPortsIssue("A forwarder's ports", ports.join(" "));
  if (issue !== undefined || ports.some((p) => reserved.includes(Number(p)))) {
    refuse(issue ?? "A forwarder may not name a port majhi listens on.");
  }
  if (ports.some((p) => String(Number(p)) !== p)) refuse("A forwarder's ports are plain numbers.");
  if (!matches(ImageRefSchema, parts.image ?? "")) refuse("A forwarder runs majhi's runner image.");
}

/** An IPv4 subnet like `192.168.171.0/24`: four octets and a prefix of 8 to 32. */
export function isIpv4Cidr(text: string): boolean {
  const [address = "", bits = "", ...rest] = text.split("/");
  const octets = address.split(".");
  const prefix = Number(bits);
  const whole = (v: string, max: number) => v !== "" && String(Number(v)) === v && Number(v) <= max;
  return (
    rest.length === 0 &&
    octets.length === 4 &&
    octets.every((o) => whole(o, 255)) &&
    whole(bits, 32) &&
    prefix >= 8
  );
}

// ---------------------------------------------------------------------------
// Paths of a build

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * A path a build reads: absolute, inside the task folder with its symlinks followed, and not
 * holding or inside majhi's config folder, the secrets key or the socket (the refusals of a runner's mounts).
 */
export function assertReadable(path: string, s: Safety, what: string): void {
  if (!isAbsolute(path)) refuse(`The ${what} must be an absolute path.`);
  const roots = pathForms(s.taskFolder);
  for (const form of pathForms(path)) {
    if (!roots.some((root) => inside(form, root))) refuse(`The ${what} must be inside the task folder.`);
  }
  try {
    runMounts(
      { command: { command: "build", args: [] }, env: {}, cwd: path },
      {
        image: "",
        network: "",
        cliEnv: {},
        majhiHome: s.majhiHome,
        protectedPaths: s.protectedPaths,
      },
    );
  } catch (err) {
    refuse(`The ${what} is not allowed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// docker buildx build, buildx create, network create, volume create

const BUILD_FLAGS: FlagTable = {
  "--builder": true,
  "--load": false,
  "--progress": true,
  "--tag": true,
  "--file": true,
  "--target": true,
  "--build-arg": true,
  "--label": true,
};

function checkBuild(parts: DockerParts, s: Safety): void {
  const names = containerNames(s.task);
  const flags = parseFlags(parts.flags, BUILD_FLAGS);
  // Never the default builder: a build shares its cache folders with every other build on it.
  if (one(flags, "--builder") !== names.builder)
    refuse(`A preview builds on its own builder, ${names.builder}.`);
  if (!is(flags, "--load")) refuse("A preview build must use --load.");
  if (one(flags, "--progress") !== "plain") refuse("A preview build must use --progress plain.");
  if (one(flags, "--tag") !== names.previewImage) refuse(`A preview build is tagged ${names.previewImage}.`);
  const target = atMostOne(flags, "--target");
  if (target !== undefined && !matches(BuildTargetSchema, target))
    refuse(`The build target ${shown(target)} is not allowed.`);
  checkKeyValues(all(flags, "--build-arg"), 32, 1_000, "build arguments");
  checkLabels(flags, s, ["image"]);
  if (parts.command.length > 0) refuse("A build takes no arguments after its context.");
  assertReadable(one(flags, "--file"), s, "Dockerfile");
  assertReadable(parts.image ?? "", s, "build context");
}

const BUILDER_FLAGS: FlagTable = { "--name": true, "--driver": true, "--driver-opt": true };
const DRIVER_OPTS: Record<string, RegExp> = {
  memory: /^[1-9][0-9]{0,3}[mg]$/,
  "memory-swap": /^[1-9][0-9]{0,3}[mg]$/,
  "cpu-period": /^100000$/,
  "cpu-quota": /^[1-9][0-9]{4,6}$/,
};

function checkBuilderCreate(parts: DockerParts, s: Safety): void {
  const flags = parseFlags(parts.flags, BUILDER_FLAGS);
  if (one(flags, "--name") !== containerNames(s.task).builder) refuse("The builder must be the task's own.");
  if (one(flags, "--driver") !== "docker-container")
    refuse("The builder must use the docker-container driver.");
  for (const opt of all(flags, "--driver-opt")) {
    const at = opt.indexOf("=");
    const key = at === -1 ? "" : opt.slice(0, at);
    const pattern = Object.hasOwn(DRIVER_OPTS, key) ? DRIVER_OPTS[key] : undefined;
    if (pattern === undefined || !pattern.test(opt.slice(at + 1)))
      refuse(`The builder option ${shown(opt)} is not allowed.`);
  }
  if (parts.image !== undefined || parts.command.length > 0) refuse("A builder is created by flags only.");
}

const NETWORK_FLAGS: FlagTable = { "--internal": false, "--driver": true, "--label": true };

function checkNetworkCreate(parts: DockerParts, s: Safety): void {
  const flags = parseFlags(parts.flags, NETWORK_FLAGS);
  // A forwarder's own network is the one network with a route out, and only forwarders join it.
  if (parts.image === containerNames(s.task).hostNetwork) {
    if (is(flags, "--internal") || one(flags, "--driver") !== "bridge" || parts.command.length > 0)
      refuse("The forwarder network is a plain bridge.");
    checkLabels(flags, s, ["network"]);
    return;
  }
  // Internal: no route out, so a service cannot reach the internet or the host.
  if (!is(flags, "--internal")) refuse("The task network must be --internal.");
  if (one(flags, "--driver") !== "bridge") refuse("The task network must use the bridge driver.");
  checkLabels(flags, s, ["network"]);
  if (parts.image !== containerNames(s.task).network || parts.command.length > 0) {
    refuse(`The task network is named ${containerNames(s.task).network}.`);
  }
}

function checkVolumeCreate(parts: DockerParts, s: Safety): void {
  const names = containerNames(s.task);
  // No --opt, no --driver: a volume with driver options can point at any folder of the host.
  const flags = parseFlags(parts.flags, { "--label": true });
  checkLabels(flags, s, ["volume"]);
  const name = parts.image ?? "";
  const volume = name.startsWith(names.volumePrefix) ? name.slice(names.volumePrefix.length) : "";
  if (!matches(ContainerNameSchema, volume) || parts.command.length > 0) {
    refuse(`A volume is named ${names.volumePrefix}<name>.`);
  }
}

const CHECKS: Record<string, ((parts: DockerParts, s: Safety) => void) | undefined> = {
  run: checkRun,
  "buildx build": checkBuild,
  "buildx create": checkBuilderCreate,
  "network create": checkNetworkCreate,
  "volume create": checkVolumeCreate,
};

/** Throws `ContainerRefused` unless the call is one of the few majhi makes, with only the flags it may have. */
export function assertSafe(parts: DockerParts, s: Safety): void {
  // The one mount of checked programs lies inside majhi's folder on purpose. Its form is checked here,
  // and `checkRun` allows it only for a database check, so the scan skips just that flag value.
  const scanned = { ...parts, flags: parts.flags.filter((f) => !isToolsMount(f, s)) };
  assertNoHostPaths(dockerArgv(scanned), s);
  const check = CHECKS[parts.verb.join(" ")];
  if (check === undefined) refuse(`The docker command ${shown(parts.verb.join(" "))} is not allowed.`);
  else check(parts, s);
}

// ---------------------------------------------------------------------------
// Builders

const labelFlags = (
  kind: ContainerKind | "dbcheck" | "hostfwd" | "previewhold" | "image" | "network" | "volume",
  task: string,
): string[] => ["--label", `majhi.container=${kind}`, "--label", `majhi.task=${task}`];

function safe(parts: DockerParts, s: Safety): DockerParts {
  assertSafe(parts, s);
  return parts;
}

/** The flags every container has. */
function containerFlags(
  kind: "preview" | "service" | "dbcheck" | "hostfwd",
  name: string,
  limits: Limits,
  s: Safety,
): string[] {
  return [
    "--rm",
    "--name",
    name,
    ...labelFlags(kind, s.task),
    "--cap-drop",
    "ALL",
    ...CAPS.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(PIDS_LIMIT),
    "--memory",
    limits.memory,
    "--cpus",
    String(limits.cpus),
  ];
}

const envFlags = (env: Record<string, string> | undefined): string[] =>
  Object.entries(env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);

/** The task's own BuildKit builder, with its limits. `docker buildx create` without `--use`: the default builder stays. */
export function builderCreateArgs(s: Safety, limits: Limits): DockerParts {
  const period = 100_000;
  return safe(
    {
      verb: ["buildx", "create"],
      flags: [
        "--name",
        containerNames(s.task).builder,
        "--driver",
        "docker-container",
        "--driver-opt",
        `memory=${limits.memory}`,
        "--driver-opt",
        `memory-swap=${limits.memory}`,
        "--driver-opt",
        `cpu-period=${period}`,
        "--driver-opt",
        `cpu-quota=${Math.round(limits.cpus * period)}`,
      ],
      image: undefined,
      command: [],
    },
    s,
  );
}

export interface BuildSpec {
  /** The folder to build, absolute, inside the task folder. */
  context: string;
  /** The Dockerfile, relative to the context (or absolute), inside the task folder. */
  dockerfile: string;
  target?: string | undefined;
  buildArgs?: Record<string, string> | undefined;
}

/** `docker buildx build` of the task's preview image, on the task's builder, loaded into the local image store. */
export function buildArgs(s: Safety, spec: BuildSpec): DockerParts {
  const names = containerNames(s.task);
  return safe(
    {
      verb: ["buildx", "build"],
      flags: [
        "--builder",
        names.builder,
        "--load",
        "--progress",
        "plain",
        "--tag",
        names.previewImage,
        "--file",
        resolve(spec.context, spec.dockerfile),
        ...(spec.target === undefined ? [] : ["--target", spec.target]),
        ...Object.entries(spec.buildArgs ?? {}).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
        ...labelFlags("image", s.task),
      ],
      image: resolve(spec.context),
      command: [],
    },
    s,
  );
}

export interface PreviewRunSpec {
  env?: Record<string, string> | undefined;
  command?: string[] | undefined;
  /** The throwaway folder in the container. */
  scratch: string;
}

export interface PreviewHoldSpec {
  port: number;
  /** The task network's subnets when it exists: the holder joins it and lets the preview reach it. */
  taskSubnets?: readonly string[] | undefined;
  /** The runner image, which holds netguard. */
  image: string;
}

/**
 * The holder of a preview: on the runner network (and the task's), the one port on 127.0.0.1 for the
 * owner, and the network guard. It is named like the preview always was, so the server reaches it the
 * same way; the preview app runs in its network namespace (`previewRunArgs`).
 */
export function previewHoldRunArgs(s: Safety, limits: Limits, spec: PreviewHoldSpec): DockerParts {
  const names = containerNames(s.task);
  const joined = spec.taskSubnets !== undefined;
  return safe(
    {
      verb: ["run"],
      flags: [
        "--rm",
        "--name",
        names.previewContainer,
        ...labelFlags("previewhold", s.task),
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "64m",
        "--cpus",
        String(Math.min(limits.cpus, 0.5)),
        "--read-only",
        "--pull",
        "never",
        "--network",
        s.runnerNetwork,
        ...(joined ? ["--network", names.network] : []),
        "--publish",
        `127.0.0.1::${spec.port}`,
      ],
      image: spec.image,
      command: ["node", GUARD_SCRIPT, "--hold", ...(spec.taskSubnets ?? []).flatMap((c) => ["--allow", c])],
    },
    s,
  );
}

/** The preview: the task's own image in its holder's network, one throwaway folder. */
export function previewRunArgs(s: Safety, limits: Limits, spec: PreviewRunSpec): DockerParts {
  const names = containerNames(s.task);
  return safe(
    {
      verb: ["run"],
      flags: [
        ...containerFlags("preview", names.previewApp, limits, s),
        "--pull",
        "never",
        "--network",
        `container:${names.previewContainer}`,
        "--mount",
        `type=volume,target=${spec.scratch}`,
        ...envFlags(spec.env),
      ],
      image: names.previewImage,
      command: spec.command ?? [],
    },
    s,
  );
}

export interface ServiceRunSpec {
  name: string;
  image: string;
  env?: Record<string, string> | undefined;
  command?: string[] | undefined;
  volumes?: { name: string; path: string }[] | undefined;
}

/** A service: only on the task's internal network under its own name, no published port, only the task's volumes. */
export function serviceRunArgs(s: Safety, limits: Limits, spec: ServiceRunSpec): DockerParts {
  const names = containerNames(s.task);
  return safe(
    {
      verb: ["run"],
      flags: [
        ...containerFlags("service", names.service(spec.name), limits, s),
        "--network",
        `name=${names.network},alias=${spec.name}`,
        ...(spec.volumes ?? []).flatMap((v) => [
          "--mount",
          `type=volume,source=${names.volume(v.name)},target=${v.path}`,
        ]),
        ...envFlags(spec.env),
      ],
      image: spec.image,
      command: spec.command ?? [],
    },
    s,
  );
}

export interface HostForwardSpec {
  /** The connection id: the forwarder is `<id>.host` on the task's network. */
  id: string;
  ports: readonly number[];
  /**
   * The task network's subnet, like `192.168.171.0/24`. The forwarder answers only peers inside it: on some
   * runtimes (OrbStack) a container reaches another network's addresses, and another task's runner must not use this one.
   */
  from: string;
  /** The runner image, which holds the forwarding script. */
  image: string;
}

/** The forwarder of a service on the owner's computer. See `checkHostForward`. */
export function hostForwardRunArgs(s: Safety, limits: Limits, spec: HostForwardSpec): DockerParts {
  const names = containerNames(s.task);
  return safe(
    {
      verb: ["run"],
      flags: [
        "--rm",
        "--name",
        names.hostForward(spec.id),
        ...labelFlags("hostfwd", s.task),
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_BIND_SERVICE",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "64m",
        "--cpus",
        String(Math.min(limits.cpus, 0.5)),
        "--read-only",
        "--pull",
        "never",
        "--network",
        `name=${names.network},alias=${spec.id}.host`,
        "--network",
        names.hostNetwork,
        "--add-host",
        `${HOST_TARGET}:host-gateway`,
      ],
      image: spec.image,
      command: ["node", HOST_FORWARD_SCRIPT, "--from", spec.from, ...spec.ports.map(String)],
    },
    s,
  );
}

/** The forwarder's own network: a plain bridge with a route out. Only forwarders join it. */
export function hostNetworkCreateArgs(s: Safety): DockerParts {
  return safe(
    {
      verb: ["network", "create"],
      flags: ["--driver", "bridge", ...labelFlags("network", s.task)],
      image: containerNames(s.task).hostNetwork,
      command: [],
    },
    s,
  );
}

/** The task's network: internal, so a service has no route out. */
export function networkCreateArgs(s: Safety): DockerParts {
  return safe(
    {
      verb: ["network", "create"],
      flags: ["--internal", "--driver", "bridge", ...labelFlags("network", s.task)],
      image: containerNames(s.task).network,
      command: [],
    },
    s,
  );
}

/** A named volume of the task, labelled, with the default driver and no options. */
export function volumeCreateArgs(s: Safety, name: string): DockerParts {
  return safe(
    {
      verb: ["volume", "create"],
      flags: labelFlags("volume", s.task),
      image: containerNames(s.task).volume(name),
      command: [],
    },
    s,
  );
}

/** The task key the labels of a database check carry: a watch belongs to no task. */
export const DBCHECK_TASK = "WATCH-1";

/** `docker run` of a database watch's client. The environment is the connection's values, for this one run. */
export function dbCheckRunArgs(
  name: string,
  image: string,
  command: readonly string[],
  env: Record<string, string>,
  limits: Limits,
  s: Safety,
  options: { toolsBin?: string | undefined; offline?: boolean | undefined } = {},
): DockerParts {
  return safe(
    {
      verb: ["run"],
      flags: [
        ...containerFlags("dbcheck", name, limits, s),
        "--read-only",
        "--tmpfs",
        DBCHECK_TMPFS,
        ...(options.offline === true ? ["--network", "none"] : []),
        ...(options.toolsBin === undefined
          ? []
          : ["--mount", `type=bind,source=${options.toolsBin},target=${TOOLS_TARGET},readonly`]),
        ...envFlags(env),
      ],
      image,
      command: [...command],
    },
    s,
  );
}
