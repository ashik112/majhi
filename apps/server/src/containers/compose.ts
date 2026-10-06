import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TaskDockerErrorCode } from "@majhi/shared";
import { parse } from "yaml";
import { z } from "zod";
import { formatIssues } from "../errors.ts";
import { assertReadable, ContainerRefused, refuse, shown } from "./args.ts";
import type { ComposeInvocation } from "./compose-cli.ts";
import { isEnvName, readEnvFile } from "./env-file.ts";
import {
  type Health,
  localImage,
  type Mount,
  mountOf,
  type RunSpec,
  type TaskDockerContext,
  volumeKey,
} from "./task-docker.ts";

/**
 * A repo's own compose file, read as the plan of a few task containers (docs/design/task-network.md).
 * The file is data: majhi reads it, checks every key against an allow list, and turns each service
 * into the same `RunSpec` a script's `docker run` becomes. Nothing in a file can name a host path,
 * the Docker socket, a privileged mode, a device, the host network or a file outside the task folder:
 * such a key is refused with a `compose_*` code the script can read.
 */

/** The default file names of a project directory, in docker compose's order, and the override each takes. */
const FILE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;
const OVERRIDES: Record<string, string> = {
  "compose.yaml": "compose.override.yaml",
  "compose.yml": "compose.override.yml",
  "docker-compose.yaml": "docker-compose.override.yaml",
  "docker-compose.yml": "docker-compose.override.yml",
};
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SERVICES = 24;

// ---------------------------------------------------------------------------
// What a service may say

/** Keys that widen what a container may do, by the code a script reads. Never accepted, whatever the value. */
const REFUSED_KEYS: Record<string, [TaskDockerErrorCode, string]> = {
  privileged: ["compose_privileged", "A task's container is never privileged."],
  cap_add: ["compose_privileged", "majhi sets the capabilities of a task's container."],
  cap_drop: ["compose_privileged", "majhi sets the capabilities of a task's container."],
  security_opt: ["compose_privileged", "majhi sets the security options of a task's container."],
  sysctls: ["compose_privileged", "A task's container takes no sysctl."],
  pid: ["compose_privileged", "A task's container has its own process namespace."],
  ipc: ["compose_privileged", "A task's container has its own IPC namespace."],
  uts: ["compose_privileged", "A task's container has its own host name."],
  userns_mode: ["compose_privileged", "A task's container has the default user namespace."],
  cgroup: ["compose_privileged", "A task's container has the default cgroup."],
  cgroup_parent: ["compose_privileged", "A task's container has the default cgroup."],
  network_mode: [
    "compose_host_network",
    "Every container of a task is on the task's one network; none is on the host's.",
  ],
  devices: ["compose_device", "A task's container gets no host device."],
  device_cgroup_rules: ["compose_device", "A task's container gets no host device."],
  gpus: ["compose_device", "A task's container gets no host device."],
  volumes_from: ["compose_mount_outside", "List the folder or the named volume itself under volumes."],
  extra_hosts: [
    "compose_host_network",
    "A task's container reaches the others by service name, and nothing of the computer.",
  ],
  dns: ["compose_host_network", "A task's container uses the task network's name service."],
  dns_search: ["compose_host_network", "A task's container uses the task network's name service."],
  dns_opt: ["compose_host_network", "A task's container uses the task network's name service."],
  mac_address: ["compose_host_network", "A task's container takes no network address of its own."],
  links: ["compose_unsupported_key", "Services reach each other by name already."],
  external_links: ["compose_host_network", "A task's container reaches only the containers of the task."],
  secrets: ["compose_unsupported_key", "Secrets are not available in a task. Put values in environment."],
  configs: ["compose_unsupported_key", "Configs are not available in a task. Mount the file under volumes."],
  extends: ["compose_unsupported_key", "extends is not available in a task."],
  scale: ["compose_unsupported_key", "One container per service in a task."],
};

/** Keys read and turned into the container. */
const TRANSLATED_KEYS = [
  "image",
  "build",
  "command",
  "entrypoint",
  "environment",
  "env_file",
  "volumes",
  "ports",
  "expose",
  "depends_on",
  "healthcheck",
  "working_dir",
  "user",
  "platform",
  "shm_size",
  "read_only",
  "tmpfs",
  "container_name",
  "networks",
  "profiles",
] as const;

/** Keys that change nothing here: majhi sets limits, restart policy and logging, and a task has one network. */
const IGNORED_KEYS = [
  "labels",
  "annotations",
  "hostname",
  "domainname",
  "restart",
  "stdin_open",
  "tty",
  "init",
  "stop_grace_period",
  "stop_signal",
  "pull_policy",
  "logging",
  "deploy",
  "mem_limit",
  "mem_reservation",
  "memswap_limit",
  "cpus",
  "cpu_shares",
  "cpu_quota",
  "cpu_period",
  "cpuset",
  "pids_limit",
  "oom_score_adj",
  "oom_kill_disable",
  "isolation",
  "runtime",
  "ulimits",
  "storage_opt",
  "group_add",
  "container_name_prefix",
  "attach",
  "x-",
] as const;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const StringList = z.union([z.string(), z.array(Scalar)]);
const EnvMap = z.union([z.record(z.string(), z.union([Scalar, z.null()])), z.array(z.string())]);

const BuildSchema = z.union([
  z.string(),
  z.strictObject({
    context: z.string().default("."),
    dockerfile: z.string().optional(),
    args: EnvMap.optional(),
    target: z.string().optional(),
    labels: z.unknown().optional(),
    tags: z.unknown().optional(),
  }),
]);

const DependsSchema = z.union([
  z.array(z.string()),
  z.record(
    z.string(),
    z.strictObject({
      condition: z
        .enum(["service_started", "service_healthy", "service_completed_successfully"])
        .default("service_started"),
      required: z.boolean().optional(),
      restart: z.boolean().optional(),
    }),
  ),
]);

const PortSchema = z.union([
  z.number(),
  z.string(),
  z.strictObject({
    target: z.number(),
    published: z.union([z.string(), z.number()]).optional(),
    protocol: z.string().optional(),
    mode: z.string().optional(),
    host_ip: z.string().optional(),
    name: z.string().optional(),
    app_protocol: z.string().optional(),
  }),
]);

const VolumeSchema = z.union([
  z.string(),
  z.strictObject({
    type: z.enum(["bind", "volume", "tmpfs"]),
    source: z.string().optional(),
    target: z.string(),
    read_only: z.boolean().optional(),
    bind: z.unknown().optional(),
    volume: z.unknown().optional(),
    tmpfs: z.unknown().optional(),
    consistency: z.string().optional(),
  }),
]);

const HealthSchema = z.strictObject({
  test: z.union([z.string(), z.array(z.string())]).optional(),
  interval: z.string().optional(),
  timeout: z.string().optional(),
  retries: z.number().int().optional(),
  start_period: z.string().optional(),
  start_interval: z.string().optional(),
  disable: z.boolean().optional(),
});

const NetworksSchema = z.union([
  z.array(z.string()),
  z.record(
    z.string(),
    z.union([z.null(), z.strictObject({ aliases: z.array(z.string()).optional() }).passthrough()]),
  ),
]);

const ServiceSchema = z.strictObject({
  image: z.string().optional(),
  build: BuildSchema.optional(),
  command: StringList.optional(),
  entrypoint: StringList.optional(),
  environment: EnvMap.optional(),
  env_file: z
    .union([
      z.string(),
      z.array(z.union([z.string(), z.strictObject({ path: z.string(), required: z.boolean().optional() })])),
    ])
    .optional(),
  volumes: z.array(VolumeSchema).optional(),
  ports: z.array(PortSchema).optional(),
  expose: z.array(Scalar).optional(),
  depends_on: DependsSchema.optional(),
  healthcheck: HealthSchema.optional(),
  working_dir: z.string().optional(),
  user: z.union([z.string(), z.number()]).optional(),
  platform: z.string().optional(),
  shm_size: z.union([z.string(), z.number()]).optional(),
  read_only: z.boolean().optional(),
  tmpfs: StringList.optional(),
  container_name: z.string().optional(),
  networks: NetworksSchema.optional(),
  profiles: z.array(z.string()).optional(),
  ...Object.fromEntries(IGNORED_KEYS.filter((k) => k !== "x-").map((k) => [k, z.unknown().optional()])),
});
type ServiceFile = z.infer<typeof ServiceSchema>;

const TopLevelSchema = z.strictObject({
  name: z.string().optional(),
  version: z.unknown().optional(),
  services: z.record(z.string(), z.unknown()),
  volumes: z.record(z.string(), z.union([z.null(), z.record(z.string(), z.unknown())])).optional(),
  networks: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Reading, interpolating and merging the files

function inside(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The compose files of an invocation: the `-f` files, or the default names found from the folder upward, never above the task folder. */
export function composeFiles(
  inv: ComposeInvocation,
  ctx: TaskDockerContext,
): { files: string[]; dir: string } {
  const folder = resolve(ctx.safety.taskFolder);
  if (inv.files.length > 0) {
    const files = inv.files.map((f) => resolve(inv.cwd, f));
    for (const file of files) {
      assertReadable(file, ctx.safety, "compose file", "compose_mount_outside");
      if (!existsSync(file))
        return refuse(`The compose file ${shown(basename(file))} does not exist.`, "compose_file_not_found");
    }
    return {
      files,
      dir:
        inv.projectDirectory === undefined
          ? dirname(files[0] ?? inv.cwd)
          : resolve(inv.cwd, inv.projectDirectory),
    };
  }
  let dir = resolve(inv.projectDirectory === undefined ? inv.cwd : resolve(inv.cwd, inv.projectDirectory));
  for (;;) {
    if (!inside(dir, folder)) break;
    for (const name of FILE_NAMES) {
      const base = join(dir, name);
      if (!existsSync(base)) continue;
      assertReadable(base, ctx.safety, "compose file", "compose_mount_outside");
      const override = join(dir, OVERRIDES[name] ?? "");
      return {
        files: existsSync(override) ? [base, override] : [base],
        dir: inv.projectDirectory === undefined ? dir : resolve(inv.cwd, inv.projectDirectory),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return refuse(
    `There is no compose file (${FILE_NAMES.join(", ")}) in ${shown(inv.cwd)} or above it in the task folder.`,
    "compose_file_not_found",
  );
}

function readYaml(file: string, ctx: TaskDockerContext): unknown {
  assertReadable(file, ctx.safety, "compose file", "compose_mount_outside");
  if (statSync(file).size > MAX_FILE_BYTES)
    return refuse(`${shown(basename(file))} is too big for a compose file.`, "compose_invalid");
  try {
    // `merge` reads `<<:` merge keys, which real compose files use for shared service settings.
    return parse(readFileSync(file, "utf8"), { merge: true, maxAliasCount: 200 });
  } catch (err) {
    return refuse(
      `${shown(basename(file))} is not valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      "compose_invalid",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys whose lists add up across files instead of replacing each other. */
const ADDITIVE = new Set(["ports", "volumes", "expose", "env_file", "profiles", "tmpfs"]);

/** A later file over an earlier one: maps merge, lists of ports, volumes and the like add up, anything else is replaced. */
export function mergeCompose(base: unknown, over: unknown, key = ""): unknown {
  if (isRecord(base) && isRecord(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeCompose(base[k], v, k) : v;
    return out;
  }
  if (Array.isArray(base) && Array.isArray(over) && ADDITIVE.has(key)) return [...base, ...over];
  return over;
}

function isNameChar(c: string | undefined): boolean {
  return c !== undefined && (isEnvName(c) || (c >= "0" && c <= "9"));
}

/** `${VAR}`, `${VAR:-x}`, `${VAR-x}`, `${VAR:+x}`, `${VAR:?why}`, `$VAR` and `$$`, from `vars` only. */
export function interpolate(text: string, vars: ReadonlyMap<string, string>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== "$") {
      out += c;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === "$") {
      out += "$";
      i += 2;
    } else if (next === "{") {
      let depth = 1;
      let end = i + 2;
      while (end < text.length && depth > 0) {
        if (text[end] === "{" && text[end - 1] === "$") depth++;
        else if (text[end] === "}") depth--;
        end++;
      }
      if (depth !== 0)
        return refuse(`The variable reference ${shown(text.slice(i))} is not closed.`, "compose_invalid");
      out += expand(text.slice(i + 2, end - 1), vars);
      i = end;
    } else if (next !== undefined && isEnvName(next)) {
      let end = i + 1;
      while (isNameChar(text[end])) end++;
      out += vars.get(text.slice(i + 1, end)) ?? "";
      i = end;
    } else {
      out += "$";
      i++;
    }
  }
  return out;
}

function expand(expr: string, vars: ReadonlyMap<string, string>): string {
  let end = 0;
  while (isNameChar(expr[end])) end++;
  const name = expr.slice(0, end);
  if (!isEnvName(name))
    return refuse(`The variable reference \${${shown(expr)}} is not allowed.`, "compose_invalid");
  const rest = expr.slice(end);
  const value = vars.get(name);
  const set = value !== undefined;
  const filled = set && value !== "";
  if (rest === "") return value ?? "";
  const colon = rest.startsWith(":");
  const op = colon ? rest[1] : rest[0];
  const arg = rest.slice(colon ? 2 : 1);
  const present = colon ? filled : set;
  switch (op) {
    case "-":
      return present ? (value ?? "") : interpolate(arg, vars);
    case "+":
      return present ? interpolate(arg, vars) : "";
    case "?":
      if (present) return value ?? "";
      return refuse(
        `The variable ${name} is required${arg === "" ? "" : `: ${shown(interpolate(arg, vars))}`}.`,
        "compose_invalid",
      );
    default:
      return refuse(`The variable reference \${${shown(expr)}} is not allowed.`, "compose_invalid");
  }
}

/** Every string value of the document, interpolated. Keys stay as written. */
function interpolateAll(value: unknown, vars: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((v) => interpolateAll(v, vars));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateAll(v, vars)]));
  return value;
}

/** The variables a compose file may read: `.env` of the project directory, or `--env-file`, both inside the task folder. Never an environment. */
function variables(inv: ComposeInvocation, dir: string, ctx: TaskDockerContext): Map<string, string> {
  const vars = new Map<string, string>();
  const path = inv.envFile === undefined ? join(dir, ".env") : resolve(inv.cwd, inv.envFile);
  if (inv.envFile === undefined && !existsSync(path)) return vars;
  for (const pair of readEnvFile(path, inv.cwd, ctx.safety, "compose_env_file_outside")) {
    const at = pair.indexOf("=");
    vars.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Turning a service into a container

/** A dependency of a service and what it waits for. */
export interface ComposeDependency {
  service: string;
  condition: "started" | "healthy" | "completed";
}

/** What `docker compose build` of a service would build: the context and Dockerfile are inside the task folder. */
export interface ComposeBuild {
  /** The local image name the build is tagged with, and the service's image. */
  tag: string;
  context: string;
  dockerfile: string;
  target?: string | undefined;
  args: string[];
}

export interface ComposeService {
  /** The service's name, lowercase: the container is `majhi-<key>-c-<name>` and it is reached as `<name>`. */
  name: string;
  spec: RunSpec;
  build?: ComposeBuild | undefined;
  dependsOn: ComposeDependency[];
  /** Container ports it declares (`ports`, `expose`), for what `up` tells the script. */
  ports: string[];
  hasHealthcheck: boolean;
}

export interface ComposeProject {
  dir: string;
  files: string[];
  /** In start order: a service comes after the ones it depends on. */
  services: ComposeService[];
  /** Named volumes the files declare, by the name the task keeps them under. */
  volumes: string[];
  notes: string[];
}

/** Compose's durations (`10s`, `1m30s`, `500ms`) as the whole seconds docker's flags take. */
export function durationSeconds(text: string): string {
  let total = 0;
  let digits = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (c >= "0" && c <= "9") {
      digits += c;
      i++;
      continue;
    }
    const unit = text.startsWith("ms", i) ? "ms" : c;
    const n = Number(digits);
    if (digits === "" || !["ms", "s", "m", "h"].includes(unit)) {
      return refuse(
        `The duration ${shown(text)} is not allowed. Use 10s, 1m30s or 500ms.`,
        "compose_invalid",
      );
    }
    total += unit === "ms" ? n / 1000 : unit === "s" ? n : unit === "m" ? n * 60 : n * 3600;
    digits = "";
    i += unit.length;
  }
  if (digits !== "") total += Number(digits);
  return `${Math.max(1, Math.round(total))}s`;
}

/** A command string split into words the way a shell would: quotes group, a backslash escapes. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (started || word !== "") words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
    }
  }
  if (started || word !== "") words.push(word);
  return words;
}

const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

function words(value: z.infer<typeof StringList> | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? shellWords(value) : value.map(String);
}

function envPairs(value: z.infer<typeof EnvMap> | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter((e) => e.includes("="));
  return Object.entries(value).flatMap(([k, v]) => (v === null ? [] : [`${k}=${String(v)}`]));
}

function healthOf(h: ServiceFile["healthcheck"]): Health | undefined {
  if (h === undefined || h.disable === true) return undefined;
  const test = h.test;
  if (test === undefined) return undefined;
  let cmd: string;
  if (typeof test === "string") cmd = test;
  else if (test[0] === "NONE") return undefined;
  else if (test[0] === "CMD-SHELL") cmd = test.slice(1).join(" ");
  else if (test[0] === "CMD") cmd = test.slice(1).map(shellQuote).join(" ");
  else cmd = test.map(shellQuote).join(" ");
  return {
    cmd,
    interval: h.interval === undefined ? undefined : durationSeconds(h.interval),
    timeout: h.timeout === undefined ? undefined : durationSeconds(h.timeout),
    startPeriod: h.start_period === undefined ? undefined : durationSeconds(h.start_period),
    retries: h.retries === undefined ? undefined : String(h.retries),
  };
}

/** `shm_size: 256m`, `1gb` or a number of bytes, as docker's `--shm-size` takes it. */
function shmOf(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return `${Math.max(1, Math.ceil(value / 1_048_576))}m`;
  const text = value.toLowerCase();
  return text.endsWith("b") ? text.slice(0, -1) : text;
}

/** A port entry's container port: `8080:80`, `127.0.0.1:5432:5432/tcp`, `80`, or `{target: 80}`. */
function containerPort(entry: z.infer<typeof PortSchema>): string {
  if (typeof entry === "number") return String(entry);
  if (typeof entry !== "string") return String(entry.target);
  const bare = entry.split("/")[0] ?? "";
  return bare.split(":").at(-1) ?? bare;
}

/** The mounts of a service: folders of the task (relative to the compose file's directory), named volumes of the task, memory folders. */
function mountsOf(
  service: string,
  file: ServiceFile,
  dir: string,
  declared: ReadonlySet<string>,
  ctx: TaskDockerContext,
): Mount[] {
  const mounts: Mount[] = [];
  for (const entry of file.volumes ?? []) {
    if (typeof entry === "string") {
      mounts.push(composeMount(service, entry, dir, declared, ctx, false));
    } else if (entry.type === "tmpfs") {
      mounts.push({ arg: `type=tmpfs,target=${entry.target}` });
    } else if ((entry.source ?? "") === "") {
      mounts.push(mountOf(entry.target, ctx, dir));
    } else {
      const spec = `${entry.source}:${entry.target}${entry.read_only === true ? ":ro" : ""}`;
      mounts.push(composeMount(service, spec, dir, declared, ctx, entry.type === "bind"));
    }
  }
  for (const target of typeof file.tmpfs === "string" ? [file.tmpfs] : (file.tmpfs ?? []).map(String)) {
    mounts.push({ arg: `type=tmpfs,target=${target.split(":")[0] ?? target}` });
  }
  return mounts;
}

/** Makes the folder a short-form bind names, as docker's `-v` does, once its nearest existing parent is known to be inside the task folder. */
function makeFolder(path: string, ctx: TaskDockerContext, service: string): void {
  let parent = dirname(path);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  const real = realpathSync(parent);
  const folder = realpathSync(ctx.safety.taskFolder);
  if (!inside(real, folder)) {
    refuse(`${service}: the volume ${shown(path)} is outside the task folder.`, "compose_mount_outside");
  }
  mkdirSync(path, { recursive: true });
}

function composeMount(
  service: string,
  spec: string,
  dir: string,
  declared: ReadonlySet<string>,
  ctx: TaskDockerContext,
  bind: boolean,
): Mount {
  const source = spec.split(":")[0] ?? "";
  const isPath = bind || source.startsWith("/") || source.startsWith(".") || source.startsWith("~");
  if (source.includes("docker.sock")) {
    return refuse(`${service}: a container cannot use the Docker socket.`, "compose_socket_mount");
  }
  if (isPath) {
    if (source.startsWith("~")) {
      return refuse(
        `${service}: the volume ${shown(source)} is outside the task folder.`,
        "compose_mount_outside",
      );
    }
    const absolute = resolve(dir, source);
    assertReadable(absolute, ctx.safety, `volume source of ${service}`, "compose_mount_outside");
    // Docker's own `-v` makes a missing folder; the long form and `docker run --mount` do not.
    if (!existsSync(absolute)) makeFolder(absolute, ctx, service);
    return mountOf(`${absolute}:${spec.split(":").slice(1).join(":")}`, ctx, dir);
  }
  if (!declared.has(volumeKey(source) ?? "")) {
    return refuse(
      `${service}: the volume ${shown(source)} is not declared under volumes.`,
      "compose_invalid",
    );
  }
  return mountOf(spec, ctx, dir);
}

function dependsOf(file: ServiceFile): ComposeDependency[] {
  const depends = file.depends_on;
  if (depends === undefined) return [];
  if (Array.isArray(depends))
    return depends.map((service) => ({ service: service.toLowerCase(), condition: "started" as const }));
  return Object.entries(depends).map(([service, d]) => ({
    service: service.toLowerCase(),
    condition:
      d.condition === "service_healthy"
        ? ("healthy" as const)
        : d.condition === "service_completed_successfully"
          ? ("completed" as const)
          : ("started" as const),
  }));
}

function aliasesOf(file: ServiceFile): string[] {
  const networks = file.networks;
  const found: string[] = [];
  if (isRecord(networks)) {
    for (const entry of Object.values(networks)) {
      if (isRecord(entry) && Array.isArray(entry.aliases)) found.push(...entry.aliases.map(String));
    }
  }
  if (file.container_name !== undefined) found.push(file.container_name);
  return found.map((a) => a.toLowerCase());
}

/** Checks one service's keys against the allow list. A refused key names the service and the key. */
function checkKeys(name: string, raw: unknown): asserts raw is Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ContainerRefused(`The service ${shown(name)} must be a map of settings.`, "compose_invalid");
  }
  for (const key of Object.keys(raw)) {
    const refused = Object.hasOwn(REFUSED_KEYS, key) ? REFUSED_KEYS[key] : undefined;
    if (refused !== undefined) refuse(`${name}: ${key} is not allowed. ${refused[1]}`, refused[0]);
    const known =
      (TRANSLATED_KEYS as readonly string[]).includes(key) ||
      (IGNORED_KEYS as readonly string[]).includes(key) ||
      key.startsWith("x-");
    if (!known) refuse(`${name}: ${key} is not supported in a task.`, "compose_unsupported_key");
  }
}

function parseService(name: string, raw: unknown): ServiceFile {
  checkKeys(name, raw);
  const stripped = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("x-")));
  const parsed = ServiceSchema.safeParse(stripped);
  if (parsed.success) return parsed.data;
  const unrecognized = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
  return refuse(
    `${name}: ${formatIssues(parsed.error).join("; ")}`,
    unrecognized ? "compose_unsupported_key" : "compose_invalid",
  );
}

/** Start order: a service after the ones it depends on. A cycle or a missing service is refused. */
function ordered(services: ComposeService[]): ComposeService[] {
  const by = new Map(services.map((s) => [s.name, s]));
  const out: ComposeService[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (s: ComposeService, path: string[]) => {
    if (state.get(s.name) === "done") return;
    if (state.get(s.name) === "visiting") {
      return refuse(`depends_on loops: ${[...path, s.name].join(" -> ")}.`, "compose_invalid");
    }
    state.set(s.name, "visiting");
    for (const d of s.dependsOn) {
      const dep = by.get(d.service);
      if (dep === undefined)
        return refuse(`${s.name} depends on ${d.service}, which is not a service here.`, "compose_invalid");
      visit(dep, [...path, s.name]);
    }
    state.set(s.name, "done");
    out.push(s);
  };
  for (const s of services) visit(s, []);
  return out;
}

/**
 * Reads the compose files of the invocation and plans its services: checked, in start order, limited
 * to the ones named (and what they depend on) and to the active profiles. Throws `ContainerRefused`
 * with a `compose_*` code for anything the allow list does not cover.
 */
export function loadCompose(inv: ComposeInvocation, ctx: TaskDockerContext): ComposeProject {
  const { files, dir } = composeFiles(inv, ctx);
  assertReadable(dir, ctx.safety, "project directory", "compose_mount_outside");
  const vars = variables(inv, dir, ctx);
  let merged: unknown;
  for (const file of files) merged = mergeCompose(merged, interpolateAll(readYaml(file, ctx), vars));
  const document = isRecord(merged)
    ? Object.fromEntries(Object.entries(merged).filter(([k]) => !k.startsWith("x-")))
    : merged;
  const top = TopLevelSchema.safeParse(document);
  if (!top.success) {
    const unrecognized = top.error.issues.some((i) => i.code === "unrecognized_keys");
    return refuse(
      `The compose file is not supported: ${formatIssues(top.error).join("; ")}`,
      unrecognized ? "compose_unsupported_key" : "compose_invalid",
    );
  }
  const names = Object.keys(top.data.services);
  if (names.length === 0) return refuse("The compose file has no services.", "compose_invalid");
  if (names.length > MAX_SERVICES) return refuse(`At most ${MAX_SERVICES} services.`, "compose_invalid");
  const declared = new Set<string>();
  for (const [volume, config] of Object.entries(top.data.volumes ?? {})) {
    if (config !== null) {
      for (const key of Object.keys(config)) {
        if (key === "driver_opts") {
          return refuse(
            `volumes.${volume}: driver_opts can point a volume at any folder of the computer.`,
            "compose_mount_outside",
          );
        }
        if (key !== "name" && key !== "labels" && !key.startsWith("x-")) {
          return refuse(`volumes.${volume}: ${key} is not supported in a task.`, "compose_unsupported_key");
        }
      }
    }
    const key = volumeKey(volume);
    if (key === undefined)
      return refuse(`The volume name ${shown(volume)} is not allowed.`, "compose_invalid");
    declared.add(key);
  }
  const notes: string[] = [];
  const all: ComposeService[] = [];
  const seen = new Set<string>();
  const profileOf = new Map<string, string[]>();
  for (const [rawName, raw] of Object.entries(top.data.services)) {
    const name = rawName.toLowerCase();
    if (seen.has(name))
      return refuse(`The services ${shown(rawName)} and another share the name ${name}.`, "compose_invalid");
    seen.add(name);
    const file = parseService(rawName, raw);
    profileOf.set(name, file.profiles ?? []);
    all.push(serviceOf(name, file, dir, declared, ctx, notes));
  }
  const requested = new Set(inv.services.map((s) => s.toLowerCase()));
  for (const wanted of requested) {
    if (!seen.has(wanted))
      return refuse(
        `There is no service ${shown(wanted)} in the compose file. Services: ${[...seen].join(", ")}.`,
        "compose_invalid",
      );
  }
  const active = new Set(inv.profiles);
  const enabled = all.filter((s) => {
    const profiles = profileOf.get(s.name) ?? [];
    return requested.has(s.name) || profiles.length === 0 || profiles.some((p) => active.has(p));
  });
  const by = new Map(all.map((s) => [s.name, s]));
  // What the named services need comes with them, unless the script said --no-deps.
  const wanted = new Set<string>();
  const want = (s: ComposeService) => {
    if (wanted.has(s.name)) return;
    wanted.add(s.name);
    if (inv.noDeps && requested.size > 0) return;
    for (const d of s.dependsOn) {
      const dep = by.get(d.service);
      if (dep !== undefined) want(dep);
    }
  };
  for (const s of enabled.filter((e) => requested.size === 0 || requested.has(e.name))) want(s);
  const chosen = ordered(all).filter((s) => wanted.has(s.name));
  return { dir, files, services: chosen, volumes: [...declared], notes };
}

function serviceOf(
  name: string,
  file: ServiceFile,
  dir: string,
  declared: ReadonlySet<string>,
  ctx: TaskDockerContext,
  notes: string[],
): ComposeService {
  const ignored = Object.keys(file).filter(
    (k) =>
      (IGNORED_KEYS as readonly string[]).includes(k) && (file as Record<string, unknown>)[k] !== undefined,
  );
  if (ignored.length > 0)
    notes.push(`${name}: ${ignored.join(", ")} ignored. majhi sets limits, restarts and logging.`);
  let build: ComposeBuild | undefined;
  let image = file.image;
  if (file.build !== undefined) {
    const b =
      typeof file.build === "string"
        ? { context: file.build, dockerfile: undefined, args: undefined, target: undefined }
        : file.build;
    const context = resolve(dir, b.context);
    assertReadable(context, ctx.safety, `build context of ${name}`, "compose_build_outside");
    const dockerfile = resolve(context, b.dockerfile ?? "Dockerfile");
    assertReadable(dockerfile, ctx.safety, `Dockerfile of ${name}`, "compose_build_outside");
    // The image keeps the name the file gives it when that is a name a task may build; otherwise the service's.
    const tag =
      image !== undefined && localImage(ctx.safety.task, image) !== undefined && !image.includes("/")
        ? image
        : name;
    build = { tag, context, dockerfile, target: b.target, args: envPairs(b.args) };
    image = tag;
  }
  if (image === undefined) return refuse(`${name} has neither image nor build.`, "compose_invalid");
  const envFiles = (typeof file.env_file === "string" ? [file.env_file] : (file.env_file ?? [])).flatMap(
    (e) => {
      const path = typeof e === "string" ? e : e.path;
      const optional = typeof e !== "string" && e.required === false;
      const absolute = resolve(dir, path);
      if (optional && !existsSync(absolute)) return [];
      return readEnvFile(absolute, dir, ctx.safety, "compose_env_file_outside");
    },
  );
  const health = healthOf(file.healthcheck);
  const spec: RunSpec = {
    name,
    aliases: aliasesOf(file),
    image,
    rm: false,
    detach: true,
    readOnly: file.read_only === true,
    env: [...envFiles, ...envPairs(file.environment)],
    mounts: mountsOf(name, file, dir, declared, ctx),
    workdir: file.working_dir,
    entrypoint: (words(file.entrypoint) ?? [])[0],
    user: file.user === undefined ? undefined : String(file.user),
    platform: file.platform,
    shmSize: shmOf(file.shm_size),
    health,
    command: [...(words(file.entrypoint)?.slice(1) ?? []), ...(words(file.command) ?? [])],
    compose: name,
  };
  return {
    name,
    spec,
    build,
    dependsOn: dependsOf(file),
    ports: [...(file.ports ?? []).map(containerPort), ...(file.expose ?? []).map(String)],
    hasHealthcheck: health !== undefined,
  };
}
