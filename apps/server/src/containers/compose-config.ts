import { basename, isAbsolute, resolve } from "node:path";
import { stringify } from "yaml";
import { refuse } from "./args.ts";
import { loadComposeDocument, shellWords } from "./compose.ts";
import type { ComposeInvocation } from "./compose-cli.ts";
import { isEnvName } from "./env-file.ts";
import type { TaskDockerContext } from "./task-docker.ts";

/**
 * `docker compose config` for a task: the repo's compose files merged, interpolated and written out in the
 * long form compose uses, so a test that parses the result (a deploy test of a prod file) reads what it
 * would read from compose. majhi writes it itself, from the files it already reads safely, because a real
 * `docker compose` would read whatever path a file names (`env_file`, `include`, a symlink) and interpolate
 * from majhi's own environment. Nothing starts and no docker call is made. Keys are written in the long form
 * for ports, volumes, depends_on, environment, command, healthcheck, build and env_file; everything else
 * is passed through as written. Not byte for byte what compose prints.
 */

type Doc = Record<string, unknown>;

const isRecord = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : String(v));

/** The variables the script's own environment hands to a `config`: names and sizes checked, majhi's own left out. */
export function shellVariables(env: Readonly<Record<string, string>> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!isEnvName(name) || name.startsWith("MAJHI_") || value.length > 8_192) continue;
    out.set(name, value);
    if (out.size >= 512) break;
  }
  return out;
}

/** Lowercase letters, digits, `-` and `_`, as compose names a project. */
function projectName(value: string): string {
  const keep = (c: string): boolean =>
    (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_" || c === "-";
  return [...value.toLowerCase()].filter(keep).join("") || "default";
}

/** `KEY=value` pairs, or a map, as a map: a number or a boolean is its text, a bare key is null. */
function environmentOf(value: unknown): Doc | undefined {
  if (Array.isArray(value)) {
    const out: Doc = {};
    for (const item of value) {
      const line = text(item);
      const at = line.indexOf("=");
      if (at === -1) out[line] = null;
      else out[line.slice(0, at)] = line.slice(at + 1);
    }
    return out;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === null ? null : text(v)]));
  }
  return undefined;
}

/** `8080:80/tcp`, `127.0.0.1:8080:80`, `80`: the long form. A range or an IPv6 address is left as written. */
function portOf(item: unknown): unknown {
  if (isRecord(item)) {
    return {
      mode: "ingress",
      ...item,
      ...(item.target === undefined ? {} : { target: Number(item.target) }),
      ...(item.published === undefined ? {} : { published: text(item.published) }),
    };
  }
  const line = text(item);
  const [spec = "", protocol = "tcp"] = line.split("/");
  if (spec.includes("[") || spec.includes("-")) return item;
  const parts = spec.split(":");
  const target = Number(parts.at(-1));
  if (!Number.isInteger(target) || parts.length > 3) return item;
  return {
    mode: "ingress",
    ...(parts.length === 3 ? { host_ip: parts[0] } : {}),
    target,
    ...(parts.length >= 2 ? { published: parts.at(-2) ?? "" } : {}),
    protocol,
  };
}

/** `./data:/data:ro`, `pgdata:/var/lib`, `/tmp`: the long form. */
function volumeOf(item: unknown, dir: string): unknown {
  if (isRecord(item)) {
    const source = typeof item.source === "string" ? item.source : undefined;
    return item.type === "bind" && source !== undefined ? { ...item, source: pathOf(source, dir) } : item;
  }
  const parts = text(item).split(":");
  const [source, target, mode] = parts;
  if (parts.length === 1) return { type: "volume", target: source };
  if (source === undefined || target === undefined || parts.length > 3) return item;
  const readOnly = mode?.split(",").includes("ro") === true;
  const bind = source.startsWith(".") || source.startsWith("/") || source.startsWith("~");
  return bind
    ? {
        type: "bind",
        source: pathOf(source, dir),
        target,
        ...(readOnly ? { read_only: true } : {}),
        bind: { create_host_path: true },
      }
    : { type: "volume", source, target, ...(readOnly ? { read_only: true } : {}), volume: {} };
}

const pathOf = (path: string, dir: string): string =>
  isAbsolute(path) || path.startsWith("~") ? path : resolve(dir, path);

function dependsOn(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((name) => [text(name), { condition: "service_started", required: true }]),
    );
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, v]) => [
      name,
      { condition: "service_started", required: true, ...(isRecord(v) ? v : {}) },
    ]),
  );
}

function commandOf(value: unknown): unknown {
  return typeof value === "string" ? shellWords(value) : value;
}

function healthcheckOf(value: unknown): unknown {
  if (!isRecord(value) || typeof value.test !== "string") return value;
  return { ...value, test: ["CMD-SHELL", value.test] };
}

function buildOf(value: unknown, dir: string): unknown {
  const build = typeof value === "string" ? { context: value } : value;
  if (!isRecord(build)) return value;
  const context = typeof build.context === "string" ? build.context : ".";
  const remote = context.includes("://") || context.startsWith("git@");
  return {
    ...build,
    context: remote ? context : pathOf(context, dir),
    ...(build.dockerfile === undefined && !remote ? { dockerfile: "Dockerfile" } : {}),
    ...(Array.isArray(build.args) ? { args: environmentOf(build.args) } : {}),
  };
}

function envFilesOf(value: unknown, dir: string): unknown {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) =>
    isRecord(item)
      ? { required: true, ...item, path: pathOf(text(item.path), dir) }
      : { path: pathOf(text(item), dir), required: true },
  );
}

function serviceOf(raw: unknown, dir: string): unknown {
  if (!isRecord(raw)) return raw;
  const out: Doc = { ...raw };
  const environment = environmentOf(raw.environment);
  if (environment !== undefined) out.environment = environment;
  if (Array.isArray(raw.ports)) out.ports = raw.ports.map(portOf);
  if (Array.isArray(raw.volumes)) out.volumes = raw.volumes.map((v) => volumeOf(v, dir));
  if (raw.depends_on !== undefined) out.depends_on = dependsOn(raw.depends_on);
  if (raw.command !== undefined) out.command = commandOf(raw.command);
  if (raw.entrypoint !== undefined) out.entrypoint = commandOf(raw.entrypoint);
  if (raw.healthcheck !== undefined) out.healthcheck = healthcheckOf(raw.healthcheck);
  if (raw.build !== undefined) out.build = buildOf(raw.build, dir);
  if (raw.env_file !== undefined) out.env_file = envFilesOf(raw.env_file, dir);
  if (Array.isArray(raw.labels)) out.labels = environmentOf(raw.labels);
  if (Array.isArray(raw.networks))
    out.networks = Object.fromEntries(raw.networks.map((n) => [text(n), null]));
  else if (raw.networks === undefined) out.networks = { default: null };
  return out;
}

/** A top-level volume or network: its real name is the project's prefix and its key, unless it is external or named. */
function namedResource(project: string, key: string, value: unknown): unknown {
  const config = isRecord(value) ? value : {};
  if (config.external === true || isRecord(config.external)) {
    const external = isRecord(config.external) ? config.external : {};
    return { ...config, name: text(config.name ?? external.name ?? key), external: true };
  }
  return { ...config, name: text(config.name ?? `${project}_${key}`) };
}

/** Keys of a map in order, so the same files give the same text. Lists keep their order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sorted(value[k])]),
  );
}

/** The document `docker compose config` prints, with the project's name. */
export function normalizeCompose(document: Doc, dir: string, project: string): Doc {
  const services = isRecord(document.services) ? document.services : {};
  const out: Doc = { ...document, name: project };
  out.services = Object.fromEntries(Object.entries(services).map(([name, s]) => [name, serviceOf(s, dir)]));
  const networks = isRecord(document.networks) ? document.networks : {};
  out.networks = Object.fromEntries([
    ...Object.entries({ default: null, ...networks }).map(([key, v]) => [
      key,
      namedResource(project, key, v),
    ]),
  ]);
  if (isRecord(document.volumes)) {
    out.volumes = Object.fromEntries(
      Object.entries(document.volumes).map(([key, v]) => [key, namedResource(project, key, v)]),
    );
  }
  return out;
}

/** What `docker compose config` prints for the invocation. Refuses (`compose_*`) like every other compose call. */
export async function composeConfigText(
  inv: ComposeInvocation,
  ctx: TaskDockerContext,
  shell: ReadonlyMap<string, string>,
): Promise<string> {
  const { dir, document, vars } = await loadComposeDocument(inv, ctx, shell);
  const project = projectName(
    inv.projectName ??
      vars.get("COMPOSE_PROJECT_NAME") ??
      (typeof document.name === "string" ? document.name : basename(dir)),
  );
  const whole = normalizeCompose(document, dir, project);
  const services = isRecord(whole.services) ? whole.services : {};
  for (const wanted of inv.services) {
    if (!(wanted in services)) {
      return refuse(
        `There is no service ${wanted} in the compose file. Services: ${Object.keys(services).join(", ")}.`,
        "compose_invalid",
      );
    }
  }
  const chosen =
    inv.services.length === 0
      ? services
      : Object.fromEntries(Object.entries(services).filter(([name]) => inv.services.includes(name)));
  const names = (list: Iterable<string>): string => [...list].map((n) => `${n}\n`).join("");
  const profiles = new Set(inv.profiles);
  const active = Object.entries(chosen).filter(([, s]) => {
    const own = isRecord(s) && Array.isArray(s.profiles) ? s.profiles.map(text) : [];
    return inv.services.length > 0 || own.length === 0 || own.some((p) => profiles.has(p));
  });
  switch (inv.list) {
    case "services":
      return names(active.map(([name]) => name));
    case "volumes":
      return names(isRecord(whole.volumes) ? Object.keys(whole.volumes) : []);
    case "images":
      return names(
        active.map(([name, s]) =>
          isRecord(s) && typeof s.image === "string" ? s.image : `${project}-${name}`,
        ),
      );
    case "profiles":
      return names(
        new Set(
          active.flatMap(([, s]) => (isRecord(s) && Array.isArray(s.profiles) ? s.profiles.map(text) : [])),
        ),
      );
    default:
      break;
  }
  if (inv.quiet) return "";
  const shown = sorted({ ...whole, services: Object.fromEntries(active) });
  return inv.format === "json" ? `${JSON.stringify(shown, null, 2)}\n` : stringify(shown, { lineWidth: 0 });
}
