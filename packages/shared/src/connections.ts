import { z } from "zod";
import {
  ConnectionFailureSchema,
  ConnectionHealthSchema,
  FAILURE_FIX,
  FAILURE_LINE,
} from "./connection-health.ts";
import { IdSchema, SecretRefSchema } from "./ids.ts";

/**
 * Connections (SPEC 5.14): the clusters, MCP servers, hosts, CLIs, mailboxes and browsers agents
 * reach outside their repos. Each type is one entry of CONNECTION_TYPES that declares its fields.
 * Adding a type is that entry, its Test and its injection.
 *
 * A connection lives under its org in majhi.yaml, as `orgs.<org>.connections.<id>`. Ids are unique
 * across orgs. A value is kept by its field's kind:
 *   - `text` as it is, in majhi.yaml;
 *   - `secret` in secrets.age, with a `secret:<name>` reference in majhi.yaml;
 *   - `file` in ~/.majhi/connections/<id>/ (folder 0700, files 0600), as `file:<name>`.
 * Values never reach logs, the room, TASK.md, memory or reports. Agents see a connection's name and
 * description, never a value.
 */

/** Wire scope for owner-approved connections shared by every workspace. Never an org. */
export const GLOBAL_CONNECTIONS = "global";

export const ConnectionTypeSchema = z.enum([
  "kubectl",
  "mcp",
  "ssh",
  "env",
  "mail",
  "browser",
  "api",
  "cli",
  "git",
  "host",
  "chat",
]);
export type ConnectionType = z.infer<typeof ConnectionTypeSchema>;

/** Where a value is kept: secrets.age, majhi.yaml, or a file of the connection. */
export const FieldKindSchema = z.enum(["secret", "text", "file"]);
export type FieldKind = z.infer<typeof FieldKindSchema>;

/**
 * Entries the owner adds by name, each with its own kind: the variables of an `env` connection, the
 * headers of a remote MCP server, the environment of a local one.
 */
export const ConnectionListKeySchema = z.enum(["vars", "headers", "env"]);
export type ConnectionListKey = z.infer<typeof ConnectionListKeySchema>;
export const CONNECTION_LISTS = ConnectionListKeySchema.options;

/** Other fields' values a field or list counts under, like `{ transport: "remote" }`. */
const WhenSchema = z.record(z.string(), z.string());

/** One field a type declares. */
export const ConnectionFieldSchema = z.object({
  /** Its key under `fields` in majhi.yaml. */
  key: z.string(),
  label: z.string(),
  kind: FieldKindSchema,
  /** The variable a run gets it in. Absent when majhi uses the value itself, like a URL or a context. */
  variable: z.string().optional(),
  /** The connection does not work until it is set. */
  required: z.boolean(),
  help: z.string(),
  /** The values a text field may take. The first is the default. */
  choices: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  /** The field counts only while these other fields hold these values. */
  when: WhenSchema.optional(),
  /** How a text value must look: a URL, a port, a host name or alias, or words separated by spaces. */
  format: z.enum(["url", "port", "ports", "host", "ssh", "words"]).optional(),
  placeholder: z.string().optional(),
  /** The page offers the Host aliases of ~/.ssh/config. */
  pick: z.enum(["ssh-alias", "ssh-key"]).optional(),
  /** majhi sets it (Connect), so the form does not offer it. */
  managed: z.boolean().optional(),
});
export type ConnectionField = z.infer<typeof ConnectionFieldSchema>;

/** A list of entries the owner names. */
export const ConnectionListSchema = z.object({
  key: ConnectionListKeySchema,
  label: z.string(),
  help: z.string(),
  /** The kinds an entry may have. */
  kinds: z.array(FieldKindSchema),
  /** An entry's name is an environment variable or an HTTP header. */
  names: z.enum(["variable", "header"]),
  when: WhenSchema.optional(),
});
export type ConnectionList = z.infer<typeof ConnectionListSchema>;

export const ConnectionTypeDefSchema = z.object({
  type: ConnectionTypeSchema,
  label: z.string(),
  /** One line for the type picker. */
  summary: z.string(),
  fields: z.array(ConnectionFieldSchema),
  lists: z.array(ConnectionListSchema),
});
export type ConnectionTypeDef = z.infer<typeof ConnectionTypeDefSchema>;

/**
 * Exceptions to how majhi's gate reads an MCP server's tool names (a name that starts with get, list
 * or search is a read; anything else asks the owner), by exact tool name.
 */
function toolExceptions(when: Record<string, string> = {}): ConnectionField[] {
  const scope = Object.keys(when).length > 0 ? { when } : {};
  return [
    {
      key: "read_tools",
      label: "Tools that only read",
      kind: "text",
      required: false,
      format: "words",
      placeholder: "browser_navigate browser_snapshot",
      help: "Tools that change nothing though their names do not say so. They run without asking.",
      ...scope,
    },
    {
      key: "write_tools",
      label: "Tools that change something",
      kind: "text",
      required: false,
      format: "words",
      placeholder: "get_or_create_alert",
      help: "Tools that change something though their names read like a read. They ask first.",
      ...scope,
    },
  ];
}

/** A remote URL or a local command: an `mcp` connection, and a mail MCP server under `when`. */
function mcpServer(when: Record<string, string> = {}): Pick<ConnectionTypeDef, "fields" | "lists"> {
  const remote = { ...when, transport: "remote" };
  const local = { ...when, transport: "local" };
  return {
    fields: [
      {
        key: "transport",
        label: "Server",
        kind: "text",
        required: true,
        help: "A server on the network, or a command majhi starts.",
        choices: [
          { value: "remote", label: "Remote URL" },
          { value: "local", label: "Local command" },
        ],
        ...(Object.keys(when).length > 0 ? { when } : {}),
      },
      {
        key: "url",
        label: "URL",
        kind: "text",
        required: true,
        format: "url",
        placeholder: "https://mcp.newrelic.com/mcp",
        help: "The server's Streamable HTTP address.",
        when: remote,
      },
      {
        key: "protocol",
        label: "Protocol",
        kind: "text",
        required: true,
        help: "Streamable HTTP, or the older server-sent events (SSE) some servers still use.",
        choices: [
          { value: "http", label: "Streamable HTTP" },
          { value: "sse", label: "SSE" },
        ],
        when: remote,
      },
      {
        key: "auth",
        label: "Sign-in",
        kind: "text",
        required: true,
        managed: true,
        help: "Headers set by hand, or the service's own sign-in through Connect, which majhi renews.",
        choices: [
          { value: "headers", label: "Headers" },
          { value: "oauth", label: "Sign in with the service" },
        ],
        when: remote,
      },
      {
        key: "products",
        label: "Products",
        kind: "text",
        required: false,
        managed: true,
        format: "words",
        help: "The products of the service its agents get, each its own server on the same sign-in.",
        when: remote,
      },
      {
        key: "command",
        label: "Command",
        kind: "text",
        required: true,
        placeholder: "npx -y @acme/mcp-server --read-only",
        help: "The command and its arguments. It starts without majhi's own environment.",
        when: local,
      },
      ...toolExceptions(when),
    ],
    lists: [
      {
        key: "headers",
        label: "Headers",
        help: "Sent with every request, like Api-Key for New Relic.",
        kinds: ["secret", "text"],
        names: "header",
        when: remote,
      },
      {
        key: "env",
        label: "Environment",
        help: "Variables the command starts with. A file becomes the path of its copy.",
        kinds: ["secret", "text", "file"],
        names: "variable",
        when: local,
      },
    ],
  };
}

const IMAP = { mode: "imap" };

/** Every connection type, in the order the page offers them. */
export const CONNECTION_TYPES: readonly ConnectionTypeDef[] = [
  {
    type: "kubectl",
    label: "Kubernetes",
    summary: "A cluster through kubectl: a kubeconfig, one context and a default namespace",
    fields: [
      {
        key: "kubeconfig",
        label: "Kubeconfig",
        kind: "file",
        variable: "KUBECONFIG",
        required: true,
        help: "Runs get a copy that holds only the context below. Use a read-only identity, like a viewer role.",
      },
      {
        key: "context",
        label: "Context",
        kind: "text",
        required: true,
        placeholder: "prod",
        help: "A context of the kubeconfig, as kubectl config get-contexts lists it.",
      },
      {
        key: "namespace",
        label: "Namespace",
        kind: "text",
        required: false,
        placeholder: "default",
        help: "Used when a command names no namespace.",
      },
    ],
    lists: [],
  },
  {
    type: "mcp",
    label: "MCP server",
    summary: "Any MCP server: a remote URL with headers, or a local command",
    ...mcpServer(),
  },
  {
    type: "ssh",
    label: "SSH host",
    summary: "A host of ~/.ssh/config. majhi runs the commands, so runs never hold a key",
    fields: [
      {
        key: "alias",
        label: "Host",
        kind: "text",
        required: true,
        format: "ssh",
        pick: "ssh-alias",
        placeholder: "root@203.0.113.10",
        help: "A Host of ~/.ssh/config, or user@address with an optional :port. majhi signs in with the keys in your ssh-agent.",
      },
      {
        key: "key",
        label: "Key",
        kind: "text",
        required: false,
        pick: "ssh-key",
        placeholder: "~/.ssh/id_ed25519.pub",
        help: "Which of your keys to use, when the host needs a different one. Only its public half is used: the agent signs.",
      },
    ],
    lists: [],
  },
  {
    type: "env",
    label: "Variables",
    summary: "Named values for CLIs and APIs, like aws, psql or an API key",
    fields: [
      {
        key: "service",
        label: "Service",
        kind: "text",
        required: false,
        managed: true,
        help: "The catalog entry a guided app setup made this for.",
      },
      {
        key: "access",
        label: "Access",
        kind: "text",
        required: false,
        managed: true,
        help: "What the owner turned on when it was set up.",
      },
      {
        key: "account",
        label: "Signed in as",
        kind: "text",
        required: false,
        managed: true,
        help: "Who the service says the token belongs to.",
      },
      {
        key: "clis",
        label: "For",
        kind: "text",
        required: false,
        format: "words",
        placeholder: "aws psql",
        help: "The CLIs these values are for, separated by spaces. Their commands that change something ask first.",
      },
      {
        key: "test",
        label: "Test command",
        kind: "text",
        required: false,
        placeholder: "aws sts get-caller-identity",
        help: "A read-only command that Test runs with these values.",
      },
    ],
    lists: [
      {
        key: "vars",
        label: "Variables",
        help: "Each becomes a variable of the run. A file becomes the path of its copy.",
        kinds: ["secret", "text", "file"],
        names: "variable",
      },
    ],
  },
  {
    type: "mail",
    label: "Mail",
    summary: "A mailbox over IMAP and SMTP, or a mail MCP server",
    fields: [
      {
        key: "mode",
        label: "Through",
        kind: "text",
        required: true,
        help: "IMAP and SMTP, or an MCP server set up like any other.",
        choices: [
          { value: "imap", label: "IMAP and SMTP" },
          { value: "mcp", label: "MCP server" },
        ],
      },
      {
        key: "imap_host",
        label: "IMAP host",
        kind: "text",
        variable: "MAIL_IMAP_HOST",
        required: true,
        format: "host",
        placeholder: "imap.acme.com",
        help: "Reached over TLS.",
        when: IMAP,
      },
      {
        key: "imap_port",
        label: "IMAP port",
        kind: "text",
        variable: "MAIL_IMAP_PORT",
        required: false,
        format: "port",
        placeholder: "993",
        help: "Default 993.",
        when: IMAP,
      },
      {
        key: "smtp_host",
        label: "SMTP host",
        kind: "text",
        variable: "MAIL_SMTP_HOST",
        required: false,
        format: "host",
        placeholder: "smtp.acme.com",
        help: "Leave it empty for a mailbox that only reads.",
        when: IMAP,
      },
      {
        key: "smtp_port",
        label: "SMTP port",
        kind: "text",
        variable: "MAIL_SMTP_PORT",
        required: false,
        format: "port",
        placeholder: "465",
        help: "Default 465, SMTP over TLS. 587 starts plain and switches to TLS.",
        when: IMAP,
      },
      {
        key: "user",
        label: "User",
        kind: "text",
        variable: "MAIL_USER",
        required: true,
        placeholder: "ops@acme.com",
        help: "The login, often the address.",
        when: IMAP,
      },
      {
        key: "password",
        label: "Password",
        kind: "secret",
        variable: "MAIL_PASSWORD",
        required: true,
        help: "An app password, where the provider offers one.",
        when: IMAP,
      },
      ...mcpServer({ mode: "mcp" }).fields,
    ],
    lists: mcpServer({ mode: "mcp" }).lists,
  },
  {
    type: "browser",
    label: "Browser",
    summary: "A browser driven through Playwright MCP or Chrome DevTools MCP, with its own profile",
    fields: [
      {
        key: "server",
        label: "Server",
        kind: "text",
        required: true,
        help: "Each connection keeps its own browser profile, so logins stay apart.",
        choices: [
          { value: "playwright", label: "Playwright MCP" },
          { value: "chrome-devtools", label: "Chrome DevTools MCP" },
        ],
      },
      ...toolExceptions(),
    ],
    lists: [],
  },
  {
    type: "api",
    label: "Signed-in service",
    summary: "A service majhi signed in to for you. Runs get a short-lived token in a variable",
    fields: [
      {
        key: "service",
        label: "Service",
        kind: "text",
        required: true,
        managed: true,
        help: "The catalog entry this sign-in is for.",
      },
      {
        key: "auth",
        label: "Sign-in",
        kind: "text",
        required: true,
        managed: true,
        help: "majhi renews the token. The refresh token never leaves majhi.",
        choices: [{ value: "oauth", label: "Sign in with the service" }],
      },
      {
        key: "token_var",
        label: "Variable",
        kind: "text",
        required: true,
        managed: true,
        help: "The variable a run gets the access token in.",
      },
    ],
    lists: [],
  },
  {
    type: "cli",
    label: "Command-line tool",
    summary: "A tool's own login, kept in a folder of this workspace. Only its runs see it",
    fields: [
      {
        key: "tool",
        label: "Tool",
        kind: "text",
        required: true,
        managed: true,
        help: "The command-line tool this sign-in is for.",
      },
      {
        key: "account",
        label: "Signed in as",
        kind: "text",
        required: false,
        managed: true,
        help: "Who the tool says is signed in.",
      },
    ],
    lists: [],
  },
  {
    type: "git",
    label: "Git host",
    summary:
      "GitHub, GitLab or Bitbucket with this workspace's own sign-in, renewed by majhi. glab and gh get it; changes ask first",
    fields: [
      {
        key: "provider",
        label: "Service",
        kind: "text",
        required: true,
        help: "GitLab gives runs glab with GITLAB_TOKEN, GitHub gives gh with GH_TOKEN, Bitbucket gives BITBUCKET_API_TOKEN and BITBUCKET_EMAIL.",
        choices: [
          { value: "gitlab", label: "GitLab (glab)" },
          { value: "github", label: "GitHub (gh)" },
          { value: "bitbucket", label: "Bitbucket" },
        ],
      },
      {
        key: "signed_in_by",
        label: "Signed in by",
        kind: "text",
        required: false,
        managed: true,
        help: "How the workspace signed in to the host: its own page, or a pasted token.",
        choices: [
          { value: "browser", label: "The host's own page" },
          { value: "token", label: "A pasted token" },
        ],
      },
      {
        key: "host",
        label: "Host",
        kind: "text",
        required: false,
        format: "host",
        placeholder: "gitlab.com",
        help: "Leave empty for gitlab.com, github.com or bitbucket.org. For GitHub Enterprise, GitLab self-managed or Bitbucket Server, the host you signed in to. The workspace must be signed in to this host.",
      },
    ],
    lists: [],
  },
  {
    type: "host",
    label: "Service on this computer",
    summary:
      "A service running on your own computer, like a local stack. This workspace's agents reach only the ports you list, as <name>.host",
    fields: [
      {
        key: "ports",
        label: "Ports",
        kind: "text",
        required: true,
        format: "ports",
        placeholder: "8000, 5432",
        help: "The ports on this computer that agents may reach, 1 to 65535, separated by commas. Nothing else on this computer is reachable.",
      },
    ],
    lists: [],
  },
  {
    type: "chat",
    label: "Chat app",
    summary: "A bot in a chat app that majhi reads client chats through. Agents never get its token",
    fields: [
      {
        // The catalog entry of the app, like every guided setup's `service`: telegram, slack, discord or email.
        key: "service",
        label: "App",
        kind: "text",
        required: true,
        managed: true,
        help: "The chat app this account is in.",
        choices: [
          { value: "telegram", label: "Telegram" },
          { value: "slack", label: "Slack" },
          { value: "discord", label: "Discord" },
          { value: "email", label: "Email" },
        ],
      },
      {
        key: "account",
        label: "Signed in as",
        kind: "text",
        required: false,
        managed: true,
        help: "Who the app says the token belongs to.",
      },
    ],
    lists: [
      {
        key: "vars",
        label: "Tokens",
        help: "The app's tokens. Only majhi reads them: no run gets them.",
        kinds: ["secret"],
        names: "variable",
      },
    ],
  },
];

/** Types only Connect makes (5.14): the new-connection form does not offer them. */
export const CONNECT_ONLY_TYPES: readonly ConnectionType[] = ["api", "cli", "chat"];

const BY_TYPE = new Map(CONNECTION_TYPES.map((def) => [def.type, def]));

export function connectionType(type: ConnectionType): ConnectionTypeDef {
  const def = BY_TYPE.get(type);
  if (def === undefined) throw new Error(`No connection type ${type}`);
  return def;
}

// ---------------------------------------------------------------------------
// Values

/** A text value. No line breaks: values become variables, headers and command lines. */
export const ConnectionTextSchema = z
  .string()
  .trim()
  .min(1, "Empty")
  .max(4096)
  .refine((v) => !/[\r\n\0]/.test(v), "A value cannot hold a line break");

/** A secret as the owner types it. Values on several lines belong in a file field. */
export const ConnectionSecretValueSchema = z
  .string()
  .trim()
  .min(1, "Empty")
  .max(8192)
  .refine(
    (v) => !/[\r\n\0]/.test(v),
    "A secret cannot hold a line break. Use a file for values on several lines.",
  );

/** The largest file a connection holds, like a kubeconfig or a service-account JSON. */
export const CONNECTION_FILE_MAX_BYTES = 1024 * 1024;

/** A file of a connection: `file:<name>`, kept in ~/.majhi/connections/<id>/. */
export const FileRefSchema = z.string().regex(/^file:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "Use file:<name>");

/** The name of an entry of `vars` or `env`: an environment variable. */
export const VariableNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Use letters, digits and underscores, like API_KEY");

/** The name of an entry of `headers`. */
export const HeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/, "Use letters, digits and dashes, like Api-Key");

/**
 * Variables a connection cannot set: majhi sets them for every run (packages/acp buildEnv), they
 * change how programs start, or they steer the agent CLI's own sign-in and API. KUBECONFIG comes
 * from kubectl connections only.
 */
const RESERVED_VARIABLES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TERM",
  "LANG",
  "KUBECONFIG",
  "SSH_AUTH_SOCK",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PLAYWRIGHT_BROWSERS_PATH",
  "DEFAULT_AUTH_REQUEST",
  "ENABLE_CLAUDEAI_MCP_SERVERS",
  // These would route the agent CLI's own traffic, its account token included, through a server the
  // connection names, or change which certificates it trusts.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
/** DOCKER_: the docker CLI that starts a runner reads these itself, and passes some by value. */
const RESERVED_PREFIXES = [
  "LD_",
  "DYLD_",
  "MAJHI_",
  "GIT_",
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
  "DOCKER_",
];

export function reservedVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_VARIABLES.has(upper) || RESERVED_PREFIXES.some((p) => upper.startsWith(p));
}

/** One entry of `vars`, `headers` or `env`. */
export const ConnectionEntrySchema = z.strictObject({
  kind: FieldKindSchema,
  /** The text, the `secret:` reference or the `file:` name, as the kind says. Absent until it is set. */
  value: z.string().min(1).max(4096).optional(),
});
export type ConnectionEntry = z.infer<typeof ConnectionEntrySchema>;

const FieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

/** How a stored value of this kind must look, or why it does not. */
function storedValueIssue(kind: FieldKind, value: string): string | undefined {
  if (kind === "secret") {
    return SecretRefSchema.safeParse(value).success
      ? undefined
      : "A secret lives in secrets.age: use secret:<name>";
  }
  if (kind === "file") return FileRefSchema.safeParse(value).success ? undefined : "Use file:<name>";
  const text = ConnectionTextSchema.safeParse(value);
  return text.success ? undefined : (text.error.issues[0]?.message ?? "Not a text value");
}

interface StorageIssue {
  path: (string | number)[];
  message: string;
}

/** What makes a stored connection unreadable: a field its type lacks, a value of the wrong kind. */
function storageIssues(conn: {
  type: ConnectionType;
  fields?: Record<string, string> | undefined;
  vars?: Record<string, ConnectionEntry> | undefined;
  headers?: Record<string, ConnectionEntry> | undefined;
  env?: Record<string, ConnectionEntry> | undefined;
}): StorageIssue[] {
  const def = BY_TYPE.get(conn.type);
  // An unknown type is already an issue of its own.
  if (def === undefined) return [];
  const issues: StorageIssue[] = [];
  for (const [key, value] of Object.entries(conn.fields ?? {})) {
    const field = def.fields.find((f) => f.key === key);
    if (field === undefined) {
      issues.push({ path: ["fields", key], message: `A ${def.label} connection has no field ${key}` });
      continue;
    }
    const issue =
      storedValueIssue(field.kind, value) ??
      (field.choices !== undefined && !field.choices.some((c) => c.value === value)
        ? `Use one of ${field.choices.map((c) => c.value).join(", ")}`
        : undefined) ??
      // A service on this computer is a hole in the sandbox: a stored list is checked as strictly as a typed one.
      (field.format === "ports" && field.kind === "text" ? hostPortsIssue(field.label, value) : undefined);
    if (issue !== undefined) issues.push({ path: ["fields", key], message: issue });
  }
  for (const key of CONNECTION_LISTS) {
    const entries = conn[key];
    if (entries === undefined) continue;
    const list = def.lists.find((l) => l.key === key);
    if (list === undefined) {
      issues.push({ path: [key], message: `A ${def.label} connection has no ${key}` });
      continue;
    }
    const seen = new Set<string>();
    for (const [name, entry] of Object.entries(entries)) {
      const path = [key, name];
      const lower = name.toLowerCase();
      if (list.names === "header" && seen.has(lower))
        issues.push({ path, message: `${name} is there twice` });
      seen.add(lower);
      if (list.names === "variable" && reservedVariable(name)) {
        issues.push({ path, message: `${name} is kept for majhi and the agent CLIs. Use another name.` });
      }
      if (!list.kinds.includes(entry.kind)) {
        issues.push({ path, message: `${list.label} cannot hold a ${entry.kind}` });
      } else if (entry.value !== undefined) {
        const issue = storedValueIssue(entry.kind, entry.value);
        if (issue !== undefined) issues.push({ path, message: issue });
      }
    }
  }
  return issues;
}

/** `orgs.<org>.connections.<id>` in majhi.yaml. No secret value is ever stored here. */
export const ConnectionConfigSchema = z
  .strictObject({
    type: ConnectionTypeSchema,
    name: z.string().trim().min(1).max(80),
    /** What agents see: what it reaches and how to use it. Never a secret. */
    description: z.string().trim().max(2000).optional(),
    /** Values of the type's fields, by key. */
    fields: z.record(FieldKeySchema, z.string().min(1).max(4096)).optional(),
    vars: z.record(VariableNameSchema, ConnectionEntrySchema).optional(),
    headers: z.record(HeaderNameSchema, ConnectionEntrySchema).optional(),
    env: z.record(VariableNameSchema, ConnectionEntrySchema).optional(),
    /** The exact write actions the org allows without asking the owner. */
    allow: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
    /** Agents of the workspace this connection never reaches. Every other agent of it gets it. */
    agents_off: z.array(IdSchema).max(200).optional(),
  })
  .superRefine((conn, ctx) => {
    for (const issue of storageIssues(conn)) ctx.addIssue({ code: "custom", ...issue });
  });
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

/**
 * The connections of every org, by org. A connection id is unique across orgs: it names the
 * connection's folder of files, so two orgs can never share one.
 */
export function duplicateConnectionIds(
  orgs: Readonly<Record<string, { connections?: Record<string, unknown> | undefined }>>,
): { id: string; orgs: string[] }[] {
  const owners = new Map<string, string[]>();
  for (const [org, config] of Object.entries(orgs)) {
    for (const id of Object.keys(config.connections ?? {})) owners.set(id, [...(owners.get(id) ?? []), org]);
  }
  return [...owners].filter(([, list]) => list.length > 1).map(([id, list]) => ({ id, orgs: list }));
}

// ---------------------------------------------------------------------------
// Which fields count

/** The values `when` rules read: what is stored, else a choice field's default. */
function ruleValues(
  def: ConnectionTypeDef,
  fields: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of def.fields) {
    const value = fields[field.key] ?? field.choices?.[0]?.value;
    if (field.kind === "text" && value !== undefined) out[field.key] = value;
  }
  return out;
}

function holds(
  when: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(when ?? {}).every(([key, value]) => values[key] === value);
}

/** The fields that count for these values: a remote MCP server has a URL and no command. */
export function activeFields(
  type: ConnectionType,
  fields: Readonly<Record<string, string>> = {},
): ConnectionField[] {
  const def = connectionType(type);
  const values = ruleValues(def, fields);
  return def.fields.filter((f) => holds(f.when, values));
}

/** The lists that count for these values: headers for a remote MCP server, env for a local one. */
export function activeLists(
  type: ConnectionType,
  fields: Readonly<Record<string, string>> = {},
): ConnectionList[] {
  const def = connectionType(type);
  const values = ruleValues(def, fields);
  return def.lists.filter((l) => holds(l.when, values));
}

/** The value a text field reads as: the stored one, else a choice field's default. */
export function textValue(conn: Pick<ConnectionConfig, "type" | "fields">, key: string): string | undefined {
  const field = connectionType(conn.type).fields.find((f) => f.key === key);
  if (field === undefined || field.kind !== "text") return undefined;
  return conn.fields?.[key] ?? field.choices?.[0]?.value;
}

/** Words of a `words` field, like the CLIs of an env connection. */
export function words(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter((w) => w.length > 0);
}

const WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const WEB_URL = z.url({ protocol: /^https?$/ });
/** A host name or an ssh alias. Never starts with a dash, so it cannot pass for an option. */
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;
/** An ssh target: an alias or a host, with an optional user and port. Never starts with `-`. */
export const SSH_TARGET =
  /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9._-]{0,252}(?::\d{1,5})?$/;

/** A key under ~/.ssh, by its public file: `~/.ssh/<name>.pub`. No path leaves ~/.ssh. */
export const SSH_PUBKEY = /^~\/\.ssh\/[A-Za-z0-9._-]{1,128}\.pub$/;

/**
 * `ssh` arguments for a target: the chosen key (its public file, so the agent signs with exactly that
 * key), `-p <port>` when the target names one, then `--` and `user@host`.
 */
export function sshTargetArgs(target: string, key?: { pub: string } | undefined): string[] {
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(target);
  const host = m?.[1] ?? target;
  const keyArgs = key === undefined ? [] : ["-o", "IdentitiesOnly=yes", "-o", `IdentityFile=${key.pub}`];
  return [...keyArgs, ...(m?.[2] === undefined ? [] : ["-p", m[2]]), "--", host];
}

/** The most ports one service on this computer may list. */
export const HOST_PORTS_MAX = 16;

/**
 * Ports no service on this computer may name: majhi's own default port. The server also refuses the
 * port it really listens on (`ConnectionService`), which can differ from the default.
 */
export const MAJHI_OWN_PORTS: readonly number[] = [7070];

/** The ports of a `ports` value, in the order given. Anything that is not a whole port 1 to 65535 is left out. */
export function hostPorts(value: string | undefined): number[] {
  const out: number[] = [];
  for (const word of words(value)) {
    const port = Number(word);
    if (
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      String(port) === word &&
      !out.includes(port)
    ) {
      out.push(port);
    }
  }
  return out;
}

/** Why a list of ports is not one, or undefined: every word a whole port, none majhi's own, not too many. */
export function hostPortsIssue(label: string, value: string): string | undefined {
  const given = words(value);
  if (given.length === 0) return `${label} needs at least one port`;
  const bad = given.find((w) => hostPorts(w).length !== 1);
  if (bad !== undefined) return `${bad} is not a port. ${label} are numbers from 1 to 65535, like 8000, 5432`;
  if (given.length > HOST_PORTS_MAX) return `${label} take at most ${HOST_PORTS_MAX} ports`;
  const own = hostPorts(value).find((p) => MAJHI_OWN_PORTS.includes(p));
  if (own !== undefined) return `Port ${own} is majhi's own. No agent may reach it`;
  return undefined;
}

/** Why a text value does not fit its field's format, or undefined. */
export function formatIssue(
  field: Pick<ConnectionField, "format" | "label" | "pick">,
  value: string,
): string | undefined {
  if (field.format === "port") {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535
      ? undefined
      : `${field.label} is a port, 1 to 65535`;
  }
  if (field.format === "ports") return hostPortsIssue(field.label, value);
  if (field.format === "url") {
    return WEB_URL.safeParse(value).success
      ? undefined
      : `${field.label} is a web address, like https://mcp.acme.com/mcp`;
  }
  if (field.pick === "ssh-key") {
    return SSH_PUBKEY.test(value)
      ? undefined
      : `${field.label} is a public key in ~/.ssh, like ~/.ssh/id_ed25519.pub`;
  }
  if (field.format === "ssh") {
    return SSH_TARGET.test(value)
      ? undefined
      : `${field.label} is a Host of ~/.ssh/config or user@address, like root@203.0.113.10`;
  }
  if (field.format === "host") {
    return HOST.test(value) ? undefined : `${field.label} is a host name, like imap.acme.com`;
  }
  if (field.format === "words") {
    const bad = words(value).find((w) => !WORD.test(w));
    return bad === undefined ? undefined : `${bad} is not a command name`;
  }
  return undefined;
}

/**
 * Why a connection would not work yet, in the page's words: a required field or an entry not set, a
 * value that does not fit. `stored` says whether a secret or file reference points at something.
 */
export function connectionProblems(
  conn: ConnectionConfig,
  stored: (kind: "secret" | "file", value: string) => boolean = () => true,
): string[] {
  const fields = conn.fields ?? {};
  const problems: string[] = [];
  const present = (kind: FieldKind, value: string | undefined) =>
    value !== undefined && (kind === "text" || stored(kind, value));
  for (const field of activeFields(conn.type, fields)) {
    const value = fields[field.key];
    if (field.choices !== undefined) continue;
    if (!present(field.kind, value)) {
      if (field.required) problems.push(`${field.label} is not set`);
      continue;
    }
    const issue = field.kind === "text" && value !== undefined ? formatIssue(field, value) : undefined;
    if (issue !== undefined) problems.push(issue);
  }
  for (const list of activeLists(conn.type, fields)) {
    for (const [name, entry] of Object.entries(conn[list.key] ?? {})) {
      if (!present(entry.kind, entry.value)) problems.push(`${name} is not set`);
    }
  }
  return problems;
}

/** A free connection id from its name: "Acme prod cluster" becomes acme-prod-cluster, then -2, -3. */
export function suggestConnectionId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "connection";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

// ---------------------------------------------------------------------------
// Commands

/** One value as `connections.get` shows it. A secret's value is never returned. */
export const ConnectionValueViewSchema = z.object({
  kind: FieldKindSchema,
  /** A text value. Secret and file values are never returned. */
  value: z.string().optional(),
  /** A value is stored: the text is filled in, the secret is in secrets.age, the file is on disk. */
  set: z.boolean(),
});
export type ConnectionValueView = z.infer<typeof ConnectionValueViewSchema>;

/**
 * The hints an MCP server gives about a tool in `tools/list` (`Tool.annotations`, MCP spec 2025-06-18).
 * Only the three booleans the gate reads. Absent means the server did not say, which is not "false".
 */
export const ToolAnnotationsSchema = z.object({
  /** The tool does not change its environment. */
  readOnlyHint: z.boolean().optional(),
  /** The tool may delete or destroy data. */
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

/**
 * What the gate does for one tool of an MCP server: `read` runs without asking, `ask` asks the owner,
 * `allowed` is a change the owner allowed, `destructive` always asks.
 */
export const ToolGateSchema = z.object({
  tool: z.string(),
  gate: z.enum(["read", "ask", "allowed", "destructive"]),
  /** Why a change is held, in a few words. Absent for a read. */
  why: z.string().optional(),
});
export type ToolGate = z.infer<typeof ToolGateSchema>;

/** What a Test found. */
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  /** One line, like "12 tools" or why it failed. Never a secret. */
  detail: z.string(),
  /** An MCP server's tool names, all of them. `detail` shows only the first few. */
  tools: z.array(z.string()).optional(),
  /** The hints the server gave about those tools, by tool name. The gate reads them to tell a read from a write. */
  toolAnnotations: z.record(z.string(), ToolAnnotationsSchema).optional(),
  /** What works but should not, like an identity that can delete pods. */
  warnings: z.array(z.string()),
  at: z.string(),
  durationMs: z.number().int().nonnegative(),
  /**
   * Why it failed, read from the call's HTTP status, MCP error code or exit code. The connection's
   * state follows this and never `detail`, which is only for people.
   */
  failure: ConnectionFailureSchema.optional(),
  /** What a passing check did, one short sentence each. */
  checked: z.array(z.string().min(1).max(200)).optional(),
  /** Who the service says the credential belongs to. */
  account: z.string().max(200).optional(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export const ConnectionViewSchema = z.object({
  id: IdSchema,
  org: IdSchema,
  type: ConnectionTypeSchema,
  name: z.string(),
  description: z.string(),
  /** Every field the type declares, by key. */
  fields: z.record(z.string(), ConnectionValueViewSchema),
  vars: z.record(z.string(), ConnectionValueViewSchema),
  headers: z.record(z.string(), ConnectionValueViewSchema),
  env: z.record(z.string(), ConnectionValueViewSchema),
  allow: z.array(z.string()),
  /** The agents it reaches: every agent of its workspace and every root agent, minus `agentsOff`. */
  agents: z.array(IdSchema),
  /** The agents it is switched off for. */
  agentsOff: z.array(IdSchema),
  /** Why it would not work yet, like a required field not set. Empty when it is ready. */
  problems: z.array(z.string()),
  /** The last Test since majhi started. */
  lastTest: ConnectionTestResultSchema.optional(),
  /** MCP servers: what the gate does for each tool of the last Test. Empty before a Test. */
  toolGate: z.array(ToolGateSchema).optional(),
  /**
   * Where the connection stands: connecting, connected (a real call passed, and when), failed (a typed
   * reason and the fix) or needs-attention (it worked, and the last re-check failed). Absent only for a
   * connection majhi has not checked yet, which it does at startup.
   */
  health: ConnectionHealthSchema.optional(),
});
export type ConnectionView = z.infer<typeof ConnectionViewSchema>;

/** A sentence without its closing full stop, to compare two and to join them. */
export function withoutPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

/**
 * What failed, in the check's own plain words ("nonexistent-cli is not installed where agents run"),
 * else the reason's line. No trailing full stop. Empty when the connection has not failed. The Connections
 * page and Health read it, so the same failure reads the same on both.
 */
export function failureLine(view: Pick<ConnectionView, "health" | "lastTest">): string {
  const health = view.health;
  if (health === undefined || (health.state !== "failed" && health.state !== "needs-attention")) return "";
  const test = view.lastTest;
  const said = test !== undefined && !test.ok && test.failure?.reason === health.reason ? test.detail : "";
  return withoutPeriod(said === "" ? FAILURE_LINE[health.reason] : said);
}

/** `failureLine` and `failureFix` as one text, saying a repeated sentence once. */
export function failureSentence(view: Pick<ConnectionView, "health" | "lastTest">): string {
  const line = failureLine(view);
  const fix = failureFix(view);
  return withoutPeriod(fix) === line ? `${line}.` : `${line}. ${fix}`;
}

/** The next step of a failed connection, the same everywhere. Empty when it has not failed. */
export function failureFix(view: Pick<ConnectionView, "health">): string {
  const health = view.health;
  if (health === undefined || (health.state !== "failed" && health.state !== "needs-attention")) return "";
  return health.fix || FAILURE_FIX[health.reason];
}

/** An entry of `vars`, `headers` or `env` as a command sets it: a text value, or none yet. */
export const ConnectionEntryInputSchema = z.strictObject({
  kind: FieldKindSchema,
  /** Only for text. A secret goes through connections.setSecret, a file through connections.setFile. */
  value: ConnectionTextSchema.optional(),
});
export type ConnectionEntryInput = z.infer<typeof ConnectionEntryInputSchema>;

const listInputs = {
  vars: z.record(VariableNameSchema, ConnectionEntryInputSchema).optional(),
  headers: z.record(HeaderNameSchema, ConnectionEntryInputSchema).optional(),
  env: z.record(VariableNameSchema, ConnectionEntryInputSchema).optional(),
};

export const ConnectionCreateInputSchema = z.object({
  org: IdSchema,
  /** Default: from the name, free across every org. */
  id: IdSchema.optional(),
  type: ConnectionTypeSchema,
  name: ConnectionConfigSchema.shape.name,
  description: ConnectionConfigSchema.shape.description,
  /** Text values by field key. A secret goes through connections.setSecret, a file through connections.setFile. */
  fields: z.record(z.string(), ConnectionTextSchema).optional(),
  ...listInputs,
});
export type ConnectionCreateInput = z.infer<typeof ConnectionCreateInputSchema>;

export const ConnectionUpdateInputSchema = z.object({
  id: IdSchema,
  name: ConnectionConfigSchema.shape.name.optional(),
  description: z.string().trim().max(2000).optional(),
  /** Text values by field key; null clears one. Secret and file fields stay as they are. */
  fields: z.record(z.string(), ConnectionTextSchema.nullable()).optional(),
  /** Each list given replaces the old one. A left-out entry goes, with its secret or file. */
  ...listInputs,
  /** Replaces the agents it is switched off for. Only the owner sets it. */
  agentsOff: z.array(IdSchema).max(200).optional(),
});
export type ConnectionUpdateInput = z.infer<typeof ConnectionUpdateInputSchema>;

/** Which value: a field by key, or an entry of a list by name. */
const ValueTargetSchema = z.object({
  id: IdSchema,
  /** A field key, or the name of an entry of `list`. */
  field: z.string().min(1).max(128),
  list: ConnectionListKeySchema.optional(),
});

export const ConnectionSetSecretInputSchema = ValueTargetSchema.extend({
  /** From the page's secure input. Stored in secrets.age, never returned. */
  value: ConnectionSecretValueSchema.optional(),
  /** A secret already in secrets.age, like one the captain got from secret capture. */
  ref: SecretRefSchema.optional(),
}).refine((i) => (i.value === undefined) !== (i.ref === undefined), {
  message: "Give the value or a secret: reference, one of them",
  path: ["value"],
});
export type ConnectionSetSecretInput = z.infer<typeof ConnectionSetSecretInputSchema>;

export const ConnectionSetFileInputSchema = ValueTargetSchema.extend({
  /** An upload id from POST /api/uploads?for=connection or uploads.create. The upload is used up. */
  upload: z.string().min(1).max(200),
});
export type ConnectionSetFileInput = z.infer<typeof ConnectionSetFileInputSchema>;
