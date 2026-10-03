import { detectSecrets, type McpPreview } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type {
  RegistryArgument,
  RegistryKeyValue,
  RegistryPackage,
  RegistryRemote,
  RegistryServer,
  RegistryValue,
} from "./registry.ts";

/** One header or variable of the server to create. A secret never has a value here. */
export interface DraftEntry {
  name: string;
  kind: "secret" | "text";
  required: boolean;
  description?: string;
  value?: string;
}

/** A text value the owner still gives, or has given. */
export interface DraftInput {
  name: string;
  description?: string;
  required: boolean;
  value?: string;
  choices?: string[];
}

/** What an install will create, before the owner confirms. */
export interface Draft {
  source: McpPreview["source"];
  title: string;
  description: string;
  /** What the connection id is made from. */
  idBase: string;
  transport: "remote" | "local";
  protocol?: "http" | "sse";
  url?: string;
  command?: string;
  headers: DraftEntry[];
  env: DraftEntry[];
  inputs: DraftInput[];
  warnings: string[];
}

const SECRET_NAME = /key|token|secret|pass(?:word|wd)?$|pwd|auth|credential|bearer|cookie/i;
const PLACEHOLDER = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^>]*>|\{[^}]*\}|your[-_ ].*|x{3,})$/i;
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const PINNED_VERSION = /^[0-9][0-9A-Za-z.+_-]*$/;

/** A word of a shell command line, quoted when it holds anything a shell would read. */
export function shellWord(word: string): string {
  return PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function isPlaceholder(value: string): boolean {
  return value.trim() === "" || PLACEHOLDER.test(value.trim());
}

// ---------------------------------------------------------------------------
// From the registry

/** The text values of a registry server, taken from what the owner gave, a fixed value or a default. */
class Values {
  readonly inputs: DraftInput[] = [];

  constructor(private readonly given: Readonly<Record<string, string>>) {}

  /** The value of a named input, noting it for the preview when the registry leaves it to the owner. */
  take(name: string, spec: RegistryValue, required: boolean): string | undefined {
    if (spec.value !== undefined && spec.value !== null) return spec.value;
    const value = this.given[name] ?? spec.default ?? undefined;
    if (value !== undefined && spec.choices && !spec.choices.includes(value)) {
      throw new UserError(`${name} is one of ${spec.choices.join(", ")}.`);
    }
    if (!this.inputs.some((i) => i.name === name)) {
      this.inputs.push({
        name,
        required,
        ...(spec.description ? { description: spec.description } : {}),
        ...(value === undefined ? {} : { value }),
        ...(spec.choices ? { choices: spec.choices } : {}),
      });
    }
    return value;
  }

  /** `{name}` placeholders of a template, filled from the variables the registry declares. */
  fill(template: string, variables: Readonly<Record<string, RegistryValue>> | null | undefined): string {
    return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, key: string) => {
      const spec = variables?.[key];
      if (spec === undefined) return whole;
      if (spec.isSecret) {
        throw new UserError(
          `The registry puts the secret ${key} inside an address or an argument. majhi keeps secrets in headers and variables only.`,
        );
      }
      return this.take(key, spec, spec.isRequired ?? spec.default === undefined) ?? whole;
    });
  }
}

/** An entry of the registry's headers or environment variables as a draft entry. */
function entryFrom(item: RegistryKeyValue, values: Values, warnings: string[]): DraftEntry | undefined {
  const templated = item.value ? [...item.value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((m) => m[1]) : [];
  const secret =
    item.isSecret === true || templated.some((k) => item.variables?.[k ?? ""]?.isSecret === true);
  const description = [item.description, secret && item.value ? `Format: ${item.value}` : undefined]
    .filter((d): d is string => d !== undefined && d !== null && d !== "")
    .join(" ");
  if (secret) {
    const required = item.isRequired ?? true;
    if (!required) {
      warnings.push(
        `${item.name} is an optional secret, so it is not created. Add it on the Connections page if you need it.`,
      );
      return undefined;
    }
    return { name: item.name, kind: "secret", required, ...(description ? { description } : {}) };
  }
  const value =
    item.value !== undefined && item.value !== null
      ? values.fill(item.value, item.variables)
      : values.take(item.name, item, item.isRequired ?? false);
  if (value === undefined && item.isRequired !== true) return undefined;
  return {
    name: item.name,
    kind: "text",
    required: item.isRequired ?? false,
    ...(description ? { description } : {}),
    ...(value === undefined ? {} : { value }),
  };
}

function entries(
  list: readonly RegistryKeyValue[] | null | undefined,
  values: Values,
  warnings: string[],
): DraftEntry[] {
  return (list ?? []).flatMap((item) => {
    const entry = entryFrom(item, values, warnings);
    return entry === undefined ? [] : [entry];
  });
}

function argumentWords(args: readonly RegistryArgument[] | null | undefined, values: Values): string[] {
  const words: string[] = [];
  for (const arg of args ?? []) {
    const label = arg.name ?? arg.valueHint ?? "argument";
    if (arg.isSecret) {
      throw new UserError(`The argument ${label} is a secret. majhi does not pass secrets as arguments.`);
    }
    const value =
      arg.value !== undefined && arg.value !== null
        ? values.fill(arg.value, arg.variables)
        : values.take(label, arg, arg.isRequired ?? false);
    if (arg.type === "named" && arg.name) {
      if (arg.format === "boolean") {
        if (value === "true") words.push(arg.name);
      } else if (value !== undefined) {
        words.push(
          arg.name.endsWith("=") ? `${arg.name}${value}` : arg.name,
          ...(arg.name.endsWith("=") ? [] : [value]),
        );
      } else if (arg.isRequired) {
        words.push(arg.name);
      }
    } else if (value !== undefined) {
      words.push(value);
    }
  }
  return words;
}

/** The pinned name of a package, or why it cannot be pinned. */
function pinned(pkg: RegistryPackage): { spec: string; version: string } {
  const version = pkg.version ?? undefined;
  const refuse = (): never => {
    throw new UserError(
      `The registry lists ${pkg.identifier} without a pinned version, and majhi always pins one. Install it with a command that names a version.`,
    );
  };
  if (pkg.registryType === "oci") {
    const tag = /:([^:/@]+)$/.exec(pkg.identifier)?.[1];
    const digest = pkg.identifier.includes("@sha256:");
    const found = digest ? "sha256" : (tag ?? version);
    if (found === undefined || found === "latest") return refuse();
    const spec = digest || tag !== undefined ? pkg.identifier : `${pkg.identifier}:${found}`;
    return { spec, version: found };
  }
  if (version === undefined || !PINNED_VERSION.test(version)) return refuse();
  return {
    spec: pkg.registryType === "pypi" ? `${pkg.identifier}==${version}` : `${pkg.identifier}@${version}`,
    version,
  };
}

function runtimeFor(pkg: RegistryPackage): "npx" | "uvx" | "docker" {
  const hint = pkg.runtimeHint ?? undefined;
  const natural = pkg.registryType === "npm" ? "npx" : pkg.registryType === "pypi" ? "uvx" : "docker";
  return hint === natural ? hint : natural;
}

const SUPPORTED_PACKAGES = new Set(["npm", "pypi", "oci"]);

function pickRemote(remotes: readonly RegistryRemote[]): RegistryRemote | undefined {
  return remotes.find((r) => r.type === "streamable-http") ?? remotes.find((r) => r.type === "sse");
}

function pickPackage(packages: readonly RegistryPackage[]): RegistryPackage | undefined {
  return packages.find(
    (p) => SUPPORTED_PACKAGES.has(p.registryType) && (p.transport?.type ?? "stdio") === "stdio",
  );
}

function publisherOf(name: string): string {
  return name.includes("/") ? name.slice(0, name.indexOf("/")) : name;
}

/** What a registry server becomes: a remote with its headers, or a pinned local package. */
export function fromRegistry(
  server: RegistryServer,
  options: { via?: "remote" | "package" | undefined; values?: Readonly<Record<string, string>> | undefined },
): Draft {
  const warnings: string[] = [];
  const values = new Values(options.values ?? {});
  const remote = pickRemote(server.remotes ?? []);
  const pkg = pickPackage(server.packages ?? []);
  const via = options.via ?? (remote !== undefined ? "remote" : "package");
  const base = {
    title: server.title || server.name.split("/").pop() || server.name,
    description: server.description ?? "",
    idBase: server.name.split("/").pop() || server.name,
  };
  const registry = { name: server.name, version: server.version ?? "latest" };
  const meta = {
    kind: "registry" as const,
    registry,
    publisher: publisherOf(server.name),
    ...(server.repository?.url ? { repository: server.repository.url } : {}),
    ...(server.websiteUrl ? { websiteUrl: server.websiteUrl } : {}),
  };
  if (via === "remote") {
    if (remote === undefined)
      throw new UserError(`${server.name} has no remote server. Install it as a package.`);
    const url = values.fill(remote.url, remote.variables);
    return {
      ...base,
      source: meta,
      transport: "remote",
      protocol: remote.type === "sse" ? "sse" : "http",
      url,
      headers: entries(remote.headers, values, warnings),
      env: [],
      inputs: values.inputs,
      warnings,
    };
  }
  if (pkg === undefined) {
    const others = (server.packages ?? []).map((p) => p.registryType);
    throw new UserError(
      others.length > 0
        ? `majhi starts npm, pypi and oci (docker) servers over stdio. ${server.name} ships as ${others.join(", ")}.`
        : `${server.name} ships no package. Try its remote server.`,
    );
  }
  const { spec, version } = pinned(pkg);
  const runtime = runtimeFor(pkg);
  const env = entries(pkg.environmentVariables, values, warnings);
  const runtimeArgs = argumentWords(pkg.runtimeArguments, values);
  const packageArgs = argumentWords(pkg.packageArguments, values);
  const words =
    runtime === "npx"
      ? ["npx", "-y", ...runtimeArgs.filter((a) => a !== "-y"), spec, ...packageArgs]
      : runtime === "uvx"
        ? ["uvx", ...runtimeArgs, spec, ...packageArgs]
        : [
            "docker",
            "run",
            "-i",
            "--rm",
            ...env.flatMap((e) => ["-e", e.name]),
            ...runtimeArgs,
            spec,
            ...packageArgs,
          ];
  return {
    ...base,
    source: { ...meta, package: { registryType: pkg.registryType, identifier: pkg.identifier, version } },
    transport: "local",
    command: words.map(shellWord).join(" "),
    headers: [],
    env,
    inputs: values.inputs,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// From a URL, a command or a pasted snippet

/** What the owner or agent gave for a header or variable. */
interface Given {
  values: Readonly<Record<string, string>>;
  /** Names to treat as secrets whatever they are called. */
  secrets: readonly string[];
}

/** A given header or variable. A secret's value is dropped, and the owner sets it after installing. */
function givenEntries(given: Given, warnings: string[]): DraftEntry[] {
  const out: DraftEntry[] = [];
  const marked = new Set(given.secrets.map((s) => s.toLowerCase()));
  for (const [name, value] of Object.entries(given.values)) {
    const secret =
      marked.has(name.toLowerCase()) ||
      SECRET_NAME.test(name) ||
      detectSecrets(`${name}=${value}`).length > 0;
    if (secret) {
      if (!isPlaceholder(value)) {
        warnings.push(`The value of ${name} was not kept. Set it after installing, with the secure input.`);
      }
      out.push({ name, kind: "secret", required: true });
    } else if (isPlaceholder(value)) {
      warnings.push(`${name} has no value, so it is left out.`);
    } else {
      out.push({ name, kind: "text", required: false, value });
    }
  }
  return out;
}

/** A remote server's address: web only, with no login or key in it. */
function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`${raw} is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UserError("A remote MCP server is an http or https address.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UserError("The address holds a user name or password. Put it in a header.");
  }
  const keyed = [...url.searchParams].some(
    ([k, v]) => SECRET_NAME.test(k) || detectSecrets(`${k}=${v}`).length > 0,
  );
  if (keyed) {
    throw new UserError("The address holds a key. majhi keeps secrets out of addresses: put it in a header.");
  }
  return url;
}

export function fromUrl(
  input: {
    url: string;
    protocol?: "http" | "sse" | undefined;
    headers?: Record<string, string> | undefined;
    secrets?: string[] | undefined;
  },
  describe: { name?: string | undefined; kind?: "url" | "json" } = {},
): Draft {
  const url = checkUrl(input.url);
  const warnings: string[] = [];
  const protocol = input.protocol ?? (url.pathname.endsWith("/sse") ? "sse" : "http");
  return {
    source: { kind: describe.kind ?? "url" },
    title: describe.name ?? url.hostname,
    description: "",
    idBase: describe.name ?? url.hostname.replace(/^(?:mcp|www)\./, "").split(".")[0] ?? "mcp",
    transport: "remote",
    protocol,
    url: url.toString(),
    headers: givenEntries({ values: input.headers ?? {}, secrets: input.secrets ?? [] }, warnings),
    env: [],
    inputs: [],
    warnings,
  };
}

/** Warns when an npx or uvx command does not pin the package it starts. */
function pinWarning(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  const runner = words[0]?.split("/").pop();
  if (runner !== "npx" && runner !== "bunx" && runner !== "uvx") return undefined;
  const target = words.slice(1).find((w) => !w.startsWith("-"));
  if (target === undefined) return undefined;
  const version =
    runner === "uvx"
      ? (/==(.+)$/.exec(target)?.[1] ?? /@([^/]+)$/.exec(target)?.[1])
      : target.lastIndexOf("@") > 0
        ? target.slice(target.lastIndexOf("@") + 1)
        : undefined;
  if (version !== undefined && version !== "latest") return undefined;
  return `${target} is not pinned to a version, so a later release will run in its place. Name one, like ${runner === "uvx" ? `${target.split(/[=@]/)[0]}==1.2.3` : `${target.split("@latest")[0]}@1.2.3`}.`;
}

export function fromCommand(
  input: { command: string; env?: Record<string, string> | undefined; secrets?: string[] | undefined },
  describe: { name?: string | undefined; kind?: "command" | "json" } = {},
): Draft {
  const command = input.command.trim();
  if (/[\r\n]/.test(command)) throw new UserError("Give the command on one line.");
  if (detectSecrets(command).length > 0) {
    throw new UserError(
      "The command holds a key. majhi keeps secrets out of commands: pass it as an environment variable.",
    );
  }
  const warnings: string[] = [];
  const unpinned = pinWarning(command);
  if (unpinned !== undefined) warnings.push(unpinned);
  const target =
    command.split(/\s+/).find((w, i) => i > 0 && !w.startsWith("-")) ?? command.split(/\s+/)[0] ?? "mcp";
  const guess = target
    .replace(/^@[^/]+\//, "")
    .replace(/@[^/]*$/, "")
    .replace(/^mcp-server-|-mcp$|-mcp-server$|^mcp-/g, "");
  return {
    source: { kind: describe.kind ?? "command" },
    title: describe.name ?? target.replace(/@[^/]*$/, ""),
    description: "",
    idBase: describe.name ?? (guess || "mcp"),
    transport: "local",
    command,
    headers: [],
    env: givenEntries({ values: input.env ?? {}, secrets: input.secrets ?? [] }, warnings),
    inputs: [],
    warnings,
  };
}

const ServerEntry = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasLaunch = (v: Record<string, unknown>) =>
  typeof v.command === "string" || typeof v.url === "string" || typeof v.serverUrl === "string";

/** The servers of a pasted snippet, by name: `mcpServers`, `servers`, one server, or a bare map. */
function snippetServers(json: unknown): Record<string, Record<string, unknown>> {
  if (!ServerEntry(json)) throw new UserError('Paste a JSON object, like { "mcpServers": { ... } }.');
  const nested = [json.mcpServers, json.servers].find(ServerEntry);
  const map = nested ?? (hasLaunch(json) ? { server: json } : json);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(map))
    if (ServerEntry(value) && hasLaunch(value)) out[name] = value;
  if (Object.keys(out).length === 0)
    throw new UserError("The snippet holds no server with a command or a url.");
  return out;
}

const stringMap = (v: unknown): Record<string, string> =>
  ServerEntry(v)
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"))
    : {};

export function fromSnippet(
  text: string,
  options: { pick?: string | undefined; secrets?: string[] | undefined },
): Draft {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UserError("That is not valid JSON.");
  }
  const servers = snippetServers(json);
  const names = Object.keys(servers);
  const name = options.pick ?? (names.length === 1 ? names[0] : undefined);
  if (name === undefined) {
    throw new UserError(
      `The snippet holds ${names.length} servers (${names.join(", ")}). Say which with pick.`,
    );
  }
  const server = servers[name];
  if (server === undefined)
    throw new UserError(`The snippet has no server ${name}. It has ${names.join(", ")}.`);
  const url = server.url ?? server.serverUrl;
  if (typeof url === "string") {
    const type = typeof server.type === "string" ? server.type.toLowerCase() : "";
    return fromUrl(
      {
        url,
        ...(type === "sse"
          ? { protocol: "sse" as const }
          : type.includes("http")
            ? { protocol: "http" as const }
            : {}),
        headers: stringMap(server.headers),
        secrets: options.secrets,
      },
      { name, kind: "json" },
    );
  }
  const args = Array.isArray(server.args)
    ? server.args.filter((a): a is string => typeof a === "string")
    : [];
  return fromCommand(
    {
      command: [String(server.command), ...args].map(shellWord).join(" "),
      env: stringMap(server.env),
      secrets: options.secrets,
    },
    { name, kind: "json" },
  );
}
