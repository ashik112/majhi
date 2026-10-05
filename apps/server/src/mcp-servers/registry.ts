import { z } from "zod";
import { UserError } from "../errors.ts";

/** The official MCP Registry. `GET /v0.1/servers?search=<q>&version=latest`, with `/v0` as the fallback. */
export const MCP_REGISTRY = "https://registry.modelcontextprotocol.io";
/** The public registry is sometimes slow on a cold path (tens of seconds); its answer is still good. */
const TIMEOUT_MS = 60_000;
/** A registry answer is reused this long, so a second search or install is instant. */
const CACHE_MS = 60 * 60_000;

/** What the registry's `server.json` says about a value: a variable, a header, an argument. */
const ValueSchema = z.object({
  description: z.string().nullish(),
  isRequired: z.boolean().nullish(),
  isSecret: z.boolean().nullish(),
  default: z.string().nullish(),
  value: z.string().nullish(),
  choices: z.array(z.string()).nullish(),
  format: z.string().nullish(),
});
export type RegistryValue = z.infer<typeof ValueSchema>;

const VariablesSchema = z.record(z.string(), ValueSchema).nullish();

const KeyValueSchema = ValueSchema.extend({ name: z.string(), variables: VariablesSchema });
export type RegistryKeyValue = z.infer<typeof KeyValueSchema>;

const ArgumentSchema = ValueSchema.extend({
  type: z.string(),
  name: z.string().nullish(),
  valueHint: z.string().nullish(),
  isRepeated: z.boolean().nullish(),
  variables: VariablesSchema,
});
export type RegistryArgument = z.infer<typeof ArgumentSchema>;

const RemoteSchema = z.object({
  type: z.string(),
  url: z.string(),
  headers: z.array(KeyValueSchema).nullish(),
  variables: VariablesSchema,
});
export type RegistryRemote = z.infer<typeof RemoteSchema>;

const PackageSchema = z.object({
  registryType: z.string(),
  identifier: z.string(),
  version: z.string().nullish(),
  runtimeHint: z.string().nullish(),
  transport: z.object({ type: z.string() }).nullish(),
  runtimeArguments: z.array(ArgumentSchema).nullish(),
  packageArguments: z.array(ArgumentSchema).nullish(),
  environmentVariables: z.array(KeyValueSchema).nullish(),
});
export type RegistryPackage = z.infer<typeof PackageSchema>;

const ServerSchema = z.object({
  name: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  version: z.string().nullish(),
  websiteUrl: z.string().nullish(),
  repository: z.object({ url: z.string().nullish() }).nullish(),
  remotes: z.array(RemoteSchema).nullish(),
  packages: z.array(PackageSchema).nullish(),
});
export type RegistryServer = z.infer<typeof ServerSchema>;

/** `/v0.1` wraps each server as `{ server, _meta }`; the first `/v0` previews listed the server itself. */
const EntrySchema = z.union([z.object({ server: ServerSchema }).transform((e) => e.server), ServerSchema]);
const ListSchema = z.object({ servers: z.array(EntrySchema) });

type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export class McpRegistry {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly base: string = MCP_REGISTRY,
  ) {}

  /** The latest version of each server that matches. */
  async search(query: string, limit: number): Promise<RegistryServer[]> {
    const q = encodeURIComponent(query);
    const cap = `limit=${limit}`;
    let found = await this.list(`/v0.1/servers?search=${q}&version=latest&${cap}`);
    if (found === undefined) found = await this.list(`/v0/servers?search=${q}&${cap}`);
    if (found === undefined) {
      throw new UserError("Could not reach the MCP Registry. Install by URL or command instead.");
    }
    return found.slice(0, limit);
  }

  /** One server by its registry name, at a version (default: the latest). */
  async get(name: string, version?: string): Promise<RegistryServer> {
    const wanted = encodeURIComponent(version ?? "latest");
    const direct = await this.json(`/v0.1/servers/${encodeURIComponent(name)}/versions/${wanted}`);
    const parsed = EntrySchema.safeParse(direct);
    if (parsed.success && parsed.data.name === name) return parsed.data;
    // An older registry has no such path: the search lists the latest of each server.
    const q = encodeURIComponent(name);
    const listed =
      (await this.list(`/v0.1/servers?search=${q}&version=latest`)) ??
      (await this.list(`/v0/servers?search=${q}`)) ??
      [];
    const exact = listed.find((s) => s.name === name);
    if (exact === undefined) throw new UserError(`The MCP Registry has no server ${name}.`, 404);
    if (version !== undefined && exact.version !== version) {
      throw new UserError(
        `The MCP Registry lists ${name} at ${exact.version ?? "an unknown version"}, not ${version}.`,
        404,
      );
    }
    return exact;
  }

  private async list(path: string): Promise<RegistryServer[] | undefined> {
    const body = await this.json(path);
    if (body === undefined) return undefined;
    const parsed = ListSchema.safeParse(body);
    if (!parsed.success) throw new UserError("The MCP Registry answered in a shape majhi does not know.");
    return parsed.data.servers;
  }

  /** The JSON of a path, or undefined when the registry has nothing there or cannot be reached. */
  private readonly cache = new Map<string, { at: number; body: Promise<unknown> }>();

  /** One request per path at a time, and a good answer kept for an hour. A failed one is not kept. */
  private json(path: string): Promise<unknown> {
    const hit = this.cache.get(path);
    if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.body;
    const body = this.fetchJson(path);
    this.cache.set(path, { at: Date.now(), body });
    void body.then((b) => {
      if (b === undefined) this.cache.delete(path);
    });
    return body;
  }

  private async fetchJson(path: string): Promise<unknown> {
    try {
      const res = await this.fetchFn(`${this.base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  }
}
