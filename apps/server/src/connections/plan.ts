import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerSpec, StdioServerSpec } from "@majhi/acp";
import {
  activeLists,
  CLI_PROFILE_DIR,
  type ConnectionConfig,
  type ConnectionListKey,
  type ConnectionType,
  cliRunEnv,
  cliTool,
  type ServiceProduct,
  serviceByUrl,
  textValue,
  words,
} from "@majhi/shared";
import type { SecretStore } from "../secrets/store.ts";
import type { HeldConnection } from "./access.ts";
import { browserServer } from "./browser.ts";
import type { GateConnection } from "./gate.ts";
import { cutKubeconfig, KubeconfigError, kubeconfigSecrets, mergeKubeconfigs } from "./kubeconfig.ts";

/** How an agent uses one of its connections: what TASK.md and majhi-connections list show. Never a value. */
export interface ConnectionUse {
  id: string;
  org: string;
  name: string;
  type: ConnectionType;
  description: string;
  /** One line: the variables, the kubectl context, the MCP server, the ssh tool. */
  use: string;
}

/** What one run gets from its connections (SPEC 5.14). */
export interface RunPlan {
  /** Variables the run starts with. */
  env: Record<string, string>;
  /** Files of the run's own folder, by name: the kubeconfig, file values. */
  files: { name: string; data: string | Buffer }[];
  /** MCP servers on the session. */
  servers: (McpServerSpec | StdioServerSpec)[];
  /** What the gate checks against. */
  gate: GateConnection[];
  /** Every secret value, by `<connection>.<field>`, to replace in what the run shows. */
  secrets: { name: string; value: string }[];
  uses: ConnectionUse[];
  /** Browser profiles, mounted read-write into this run only. */
  profiles: string[];
  /** Connections left out, and why, for the room. */
  problems: string[];
}

export interface PlanDeps {
  secrets: Pick<SecretStore, "get">;
  /** The folder of a connection's own files: ~/.majhi/connections/<id>/. */
  connectionDir: (id: string) => string;
  /** PLAYWRIGHT_BROWSERS_PATH of runs, for browser servers. */
  browsersPath?: string | undefined;
  /**
   * The bearer token of a connection signed in with OAuth (Connect, 5.14), renewed when it ends soon.
   * The run gets it as a header at session start; the refresh token never leaves majhi.
   */
  oauth?: ((connection: string) => Promise<{ token: string } | { problem: string }>) | undefined;
}

const SECRET = "secret:";
const FILE = "file:";

/** Builds a run's plan. `dir` is the run's own folder, where `files` will be written. */
export async function planConnections(
  held: readonly HeldConnection[],
  dir: string,
  deps: PlanDeps,
): Promise<RunPlan> {
  const plan: RunPlan = {
    env: {},
    files: [],
    servers: [],
    gate: [],
    secrets: [],
    uses: [],
    profiles: [],
    problems: [],
  };
  const setBy = new Map<string, string>();
  const setVar = (owner: string, name: string, value: string) => {
    const first = setBy.get(name);
    if (first !== undefined && first !== owner) {
      plan.problems.push(`${name} is set by ${first} and ${owner}; the run gets ${first}'s.`);
      return;
    }
    setBy.set(name, owner);
    plan.env[name] = value;
  };
  const secretOf = async (
    owner: string,
    field: string,
    ref: string | undefined,
  ): Promise<string | undefined> => {
    if (ref === undefined || !ref.startsWith(SECRET)) return undefined;
    const value = await deps.secrets.get(ref.slice(SECRET.length));
    if (value !== undefined) plan.secrets.push({ name: `${owner}.${field}`, value });
    return value;
  };
  const fileOf = async (owner: string, ref: string | undefined): Promise<Buffer | undefined> => {
    if (ref === undefined || !ref.startsWith(FILE)) return undefined;
    return readFile(join(deps.connectionDir(owner), ref.slice(FILE.length))).catch(() => undefined);
  };
  /** The entries of a list as variables. A file entry becomes the path of its copy in `dir`. */
  const entries = async (h: HeldConnection, key: ConnectionListKey): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(h.connection[key] ?? {})) {
      if (entry.kind === "text" && entry.value !== undefined) out[name] = entry.value;
      if (entry.kind === "secret") {
        const value = await secretOf(h.id, name, entry.value);
        if (value !== undefined) out[name] = value;
      }
      if (entry.kind === "file") {
        const data = await fileOf(h.id, entry.value);
        if (data === undefined) continue;
        const file = `${h.id}-${name}`;
        plan.files.push({ name: file, data });
        out[name] = join(dir, file);
      }
    }
    return out;
  };
  const use = (h: HeldConnection, line: string) =>
    plan.uses.push({
      id: h.id,
      org: h.org,
      name: h.connection.name,
      type: h.connection.type,
      description: h.connection.description ?? "",
      use: line,
    });
  const gate = (h: HeldConnection, extra: Partial<GateConnection> = {}) =>
    plan.gate.push({ id: h.id, type: h.connection.type, allow: h.connection.allow ?? [], ...extra });

  // Every kubectl connection is one context of one kubeconfig, named after the connection.
  const kube: { id: string; text: string; context: string; namespace?: string | undefined }[] = [];
  for (const h of held.filter((c) => c.connection.type === "kubectl")) {
    const context = textValue(h.connection, "context");
    const text = (await fileOf(h.id, h.connection.fields?.kubeconfig))?.toString("utf8");
    if (context === undefined || text === undefined) {
      plan.problems.push(`${h.id} is not set up, so the run does not get it.`);
      continue;
    }
    const namespace = textValue(h.connection, "namespace");
    try {
      cutKubeconfig(text, context, namespace);
    } catch (err) {
      if (!(err instanceof KubeconfigError)) throw err;
      plan.problems.push(`${h.id}: ${err.message}`);
      continue;
    }
    kube.push({ id: h.id, text, context, namespace });
  }
  if (kube.length > 0) {
    const merged = mergeKubeconfigs(kube);
    plan.files.push({ name: "kubeconfig", data: merged });
    plan.env.KUBECONFIG = join(dir, "kubeconfig");
    for (const value of kubeconfigSecrets(merged)) {
      const owner = kube.find((k) => k.text.includes(value))?.id ?? kube[0]?.id ?? "kubectl";
      plan.secrets.push({ name: `${owner}.kubeconfig`, value });
    }
    kube.forEach((k, i) => {
      const h = held.find((c) => c.id === k.id);
      if (h === undefined) return;
      gate(h, { context: k.id });
      use(h, useLine(h, i === 0));
    });
  }

  for (const h of held) {
    const c = h.connection;
    switch (c.type) {
      case "kubectl":
        break;
      case "env": {
        const vars = await entries(h, "vars");
        for (const [name, value] of Object.entries(vars)) setVar(h.id, name, value);
        const clis = words(textValue(c, "clis"));
        gate(h, { clis });
        use(h, useLine(h));
        break;
      }
      case "mail": {
        if (textValue(c, "mode") === "mcp") {
          await mcpServer(h, plan, entries, gate, use, deps.oauth);
          break;
        }
        const values: [string, string | undefined][] = [
          ["MAIL_IMAP_HOST", textValue(c, "imap_host")],
          ["MAIL_IMAP_PORT", textValue(c, "imap_port") ?? "993"],
          ["MAIL_SMTP_HOST", textValue(c, "smtp_host")],
          [
            "MAIL_SMTP_PORT",
            textValue(c, "smtp_host") === undefined ? undefined : (textValue(c, "smtp_port") ?? "465"),
          ],
          ["MAIL_USER", textValue(c, "user")],
          ["MAIL_PASSWORD", await secretOf(h.id, "password", c.fields?.password)],
        ];
        for (const [name, value] of values) if (value !== undefined) setVar(h.id, name, value);
        gate(h);
        use(h, useLine(h));
        break;
      }
      case "mcp":
        await mcpServer(h, plan, entries, gate, use, deps.oauth);
        break;
      case "browser": {
        const server = browserServer(textValue(c, "server"));
        const profile = join(deps.connectionDir(h.id), "profile");
        plan.profiles.push(profile);
        plan.servers.push({
          type: "stdio",
          name: h.id,
          command: server.command,
          args: [...server.args(profile)],
          env: deps.browsersPath === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: deps.browsersPath },
        });
        gate(h, {
          server: h.id,
          readTools: [...server.reads, ...words(textValue(c, "read_tools"))],
          writeTools: words(textValue(c, "write_tools")),
        });
        use(h, useLine(h));
        break;
      }
      case "ssh":
        gate(h);
        use(h, useLine(h));
        break;
      case "api": {
        // The owner's sign-in for this workspace, as a short-lived token in one variable. The
        // refresh token never leaves majhi.
        const name = textValue(c, "token_var");
        const answer =
          deps.oauth === undefined || name === undefined
            ? { problem: "It has no sign-in." }
            : await deps.oauth(h.id);
        if ("problem" in answer || name === undefined) {
          plan.problems.push(
            `${h.id}: ${"problem" in answer ? answer.problem : "It has no variable."} The run does not get it.`,
          );
          break;
        }
        setVar(h.id, name, answer.token);
        plan.secrets.push({ name: `${h.id}.oauth`, value: answer.token });
        gate(h, { clis: [] });
        use(h, useLine(h));
        break;
      }
      case "cli": {
        const tool = cliTool(textValue(c, "tool") ?? "");
        if (tool === undefined) {
          plan.problems.push(`${h.id} names no known tool, so the run does not get it.`);
          break;
        }
        // Only this connection's folder, and only the tool's own variables pointing into it.
        const profile = join(deps.connectionDir(h.id), CLI_PROFILE_DIR);
        for (const [name, value] of Object.entries(cliRunEnv(tool, profile))) setVar(h.id, name, value);
        plan.profiles.push(profile);
        gate(h, { clis: [tool.binary] });
        use(h, useLine(h));
        break;
      }
    }
  }
  return plan;
}

/** A remote server with its headers, or a local command with its environment. */
async function mcpServer(
  h: HeldConnection,
  plan: RunPlan,
  entries: (h: HeldConnection, key: ConnectionListKey) => Promise<Record<string, string>>,
  gate: (h: HeldConnection, extra?: Partial<GateConnection>) => void,
  use: (h: HeldConnection, line: string) => void,
  oauth: PlanDeps["oauth"],
): Promise<void> {
  const c: ConnectionConfig = h.connection;
  const lists = activeLists(c.type, c.fields ?? {}).map((l) => l.key);
  if (textValue(c, "transport") === "local") {
    const command = textValue(c, "command");
    if (command === undefined) {
      plan.problems.push(`${h.id} has no command, so the run does not get it.`);
      return;
    }
    const env = lists.includes("env") ? await entries(h, "env") : {};
    plan.servers.push({ type: "stdio", name: h.id, command: "sh", args: ["-c", `exec ${command}`], env });
  } else {
    const url = textValue(c, "url");
    if (url === undefined) {
      plan.problems.push(`${h.id} has no URL, so the run does not get it.`);
      return;
    }
    const headers = lists.includes("headers") ? await entries(h, "headers") : {};
    if (textValue(c, "auth") === "oauth") {
      // The owner's sign-in for this workspace's connection, as a header. majhi always supplies it,
      // so the agent CLI never starts a sign-in of its own.
      const answer = oauth === undefined ? { problem: "It has no sign-in." } : await oauth(h.id);
      if ("problem" in answer) {
        plan.problems.push(`${h.id}: ${answer.problem} The run does not get it.`);
        return;
      }
      headers.Authorization = `Bearer ${answer.token}`;
      plan.secrets.push({ name: `${h.id}.oauth`, value: answer.token });
    }
    const type = textValue(c, "protocol") === "sse" ? "sse" : "http";
    const products = productsOf(c);
    if (products.length > 0) {
      // Each product is its own server on the same sign-in.
      for (const product of products) {
        const name = `${h.id}-${product.id}`;
        plan.servers.push({ type, name, url: product.mcpUrl, headers });
        gate(h, {
          server: name,
          readTools: words(textValue(c, "read_tools")),
          writeTools: words(textValue(c, "write_tools")),
        });
      }
      use(h, useLine(h));
      return;
    }
    plan.servers.push({ type, name: h.id, url, headers });
  }
  gate(h, {
    server: h.id,
    readTools: words(textValue(c, "read_tools")),
    writeTools: words(textValue(c, "write_tools")),
  });
  use(h, useLine(h));
}

/** The products a remote MCP connection turned on, as its service lists them. */
function productsOf(c: ConnectionConfig): ServiceProduct[] {
  const picked = words(textValue(c, "products"));
  if (picked.length === 0) return [];
  const service = serviceByUrl(textValue(c, "url") ?? "");
  return (service?.products ?? []).filter((p) => picked.includes(p.id));
}

/**
 * How an agent uses one connection, in one line, from its definition alone: never a value. `current`
 * marks the kubectl context a run's kubeconfig starts in.
 */
export function useLine(h: HeldConnection, current = false): string {
  const c = h.connection;
  switch (c.type) {
    case "kubectl": {
      const namespace = textValue(c, "namespace");
      return `kubectl --context ${h.id}${current ? " (the current context)" : ""}${namespace ? `, namespace ${namespace}` : ""}.`;
    }
    case "env": {
      const names = Object.keys(c.vars ?? {});
      const clis = words(textValue(c, "clis"));
      return `${names.length === 0 ? "No variables." : `Variables ${names.join(", ")}.`}${clis.length > 0 ? ` For ${clis.join(", ")}.` : ""}`;
    }
    case "mail":
      return textValue(c, "mode") === "mcp"
        ? `MCP server ${h.id}. Sending mail asks the owner first.`
        : "Variables MAIL_IMAP_HOST, MAIL_IMAP_PORT, MAIL_SMTP_HOST, MAIL_SMTP_PORT, MAIL_USER and MAIL_PASSWORD. Sending mail asks the owner first.";
    case "mcp": {
      const products = productsOf(c);
      return products.length === 0
        ? `MCP server ${h.id}.`
        : `MCP servers ${products.map((p) => `${h.id}-${p.id} (${p.name})`).join(", ")}.`;
    }
    case "browser":
      return `MCP server ${h.id} (${browserServer(textValue(c, "server")).label}), with its own browser profile.`;
    case "api":
      return `Variable ${textValue(c, "token_var") ?? "ACCESS_TOKEN"} holds a short-lived token for ${c.name}. Anything that changes something asks the owner first.`;
    case "cli": {
      const tool = cliTool(textValue(c, "tool") ?? "");
      return `${tool?.binary ?? "The tool"} is signed in for this workspace only${textValue(c, "account") === undefined ? "" : ` as ${textValue(c, "account")}`}. Commands that change something ask the owner first.`;
    }
    case "ssh":
      return `Run a command on it with the majhi-connections ssh tool (connection ${h.id}). Commands that change something wait for the owner.`;
  }
}
