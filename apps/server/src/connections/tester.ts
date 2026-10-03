import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEnv, Command, Spawner, SpawnRequest } from "@majhi/acp";
import {
  activeLists,
  type ConnectionConfig,
  type ConnectionListKey,
  type ConnectionTestResult,
  type ConnectionType,
  connectionType,
  type FieldKind,
  textValue,
} from "@majhi/shared";
import { errorCode, errorMessage, UserError } from "../errors.ts";
import { sshConfigHosts } from "../scan/sshConfig.ts";
import type { SecretStore } from "../secrets/store.ts";
import { classifyProbe, runSsh, type SshRunFn } from "../ssh/hosts.ts";
import { type BrowserServer, browserServer } from "./browser.ts";
import { cutKubeconfig, KubeconfigError } from "./kubeconfig.ts";
import { imapLogin, smtpGreeting } from "./mail.ts";
import { listTools, remoteTransport, SpawnedTransport } from "./mcp-client.ts";
import { type ConnectionService, ownerOnlyDir } from "./service.ts";

const KUBECTL_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MCP_TIMEOUT_MS = 30_000;
/** A first start may download the server from npm. */
const BROWSER_TIMEOUT_MS = 180_000;
const MAIL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 256 * 1024;
/** A scratch folder older than this belongs to a Test that never cleaned up, like one cut short by a restart. */
const SCRATCH_MAX_AGE_MS = 60 * 60_000;
const SCRATCH_PREFIX = "test-";

export interface TesterDeps {
  connections: ConnectionService;
  secrets: SecretStore;
  /** The spawner of agent sessions: a Test's programs run where an agent's would. */
  spawner: Spawner;
  /** PATH and LANG of runs. Never majhi's own environment. */
  base: BaseEnv;
  /** Where a Test's scratch folders go: in the tasks folder, which a runner can mount. */
  scratchRoot: () => Promise<string>;
  /** Whose ~/.ssh/config holds the aliases. */
  hostHome: string;
  ssh?: SshRunFn;
  /**
   * The command of a browser MCP server. Default: `npx -y` at the pinned version. The runner image has
   * the servers, and tests replace it, so neither downloads one.
   */
  browserCommand?: (server: BrowserServer) => Command;
  now?: () => Date;
}

interface Outcome {
  ok: boolean;
  detail: string;
  /** An MCP server's tool names. */
  tools?: string[];
  warnings: string[];
}

interface Entry {
  name: string;
  kind: FieldKind;
  /** A text value, or a secret's value. */
  value?: string;
  /** A file's contents. */
  file?: Buffer;
}

/** A connection's values, read for one Test and dropped after it. */
interface Values {
  /** Text values (a choice field's default included) and secret values, by field key. */
  fields: Record<string, string>;
  files: Record<string, Buffer>;
  /** The entries of the lists that count, like the headers of a remote MCP server. */
  lists: Partial<Record<ConnectionListKey, Entry[]>>;
  /** Every secret value with its name, so no Test says one. */
  secrets: { name: string; value: string }[];
}

interface RunResult {
  /** Null when the program did not start or was stopped at the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program does not exist where it ran. */
  missing: boolean;
}

/**
 * The Test of each connection type (SPEC 5.14). A Test spends no tokens. Programs (kubectl, an
 * env test command, a local or browser MCP server) start through the sessions' spawner, so with
 * runner containers they run in one, never in majhi; they get PATH, LANG, a throwaway HOME and the
 * connection's own values, never majhi's environment. Files go in a scratch folder only the owner
 * can open, removed when the Test ends. SSH runs from majhi the way its git does; mail and remote
 * MCP servers are reached from majhi. No secret value ever reaches a result.
 */
export class ConnectionTester {
  constructor(private readonly deps: TesterDeps) {}

  async test(id: string): Promise<ConnectionTestResult> {
    const started = Date.now();
    const view = await this.deps.connections.get(id);
    const found = await this.deps.connections.find(id);
    if (found === undefined) throw new UserError(`There is no connection ${id}.`, 404);
    let outcome: Outcome;
    let secrets: Values["secrets"] = [];
    if (view.problems.length > 0) {
      outcome = { ok: false, detail: `${view.problems.join(". ")}.`, warnings: [] };
    } else {
      try {
        const values = await this.resolve(id, found.connection);
        secrets = values.secrets;
        outcome = await this.run(found.connection.type, values);
      } catch (err) {
        outcome = { ok: false, detail: firstLine(errorMessage(err)), warnings: [] };
      }
    }
    const result: ConnectionTestResult = {
      ok: outcome.ok,
      detail: redact(outcome.detail, id, secrets),
      ...(outcome.tools === undefined ? {} : { tools: outcome.tools.map((t) => redact(t, id, secrets)) }),
      warnings: outcome.warnings.map((w) => redact(w, id, secrets)),
      at: (this.deps.now?.() ?? new Date()).toISOString(),
      durationMs: Math.max(0, Date.now() - started),
    };
    this.deps.connections.recordTest(id, result);
    return result;
  }

  private run(type: ConnectionType, values: Values): Promise<Outcome> {
    switch (type) {
      case "kubectl":
        return this.kubectl(values);
      case "mcp":
        return this.mcp(values);
      case "ssh":
        return this.ssh(values);
      case "env":
        return this.env(values);
      case "mail":
        return values.fields.mode === "mcp" ? this.mcp(values) : this.mail(values);
      case "browser":
        return this.browser(values);
    }
  }

  /** `kubectl auth can-i --list` against a copy that holds only the context, and two checks for writes. */
  private async kubectl(v: Values): Promise<Outcome> {
    const context = v.fields.context ?? "";
    const namespace = v.fields.namespace;
    let cut: string;
    try {
      cut = cutKubeconfig(v.files.kubeconfig?.toString("utf8") ?? "", context, namespace);
    } catch (err) {
      if (err instanceof KubeconfigError) return fail(err.message);
      throw err;
    }
    return this.scratch(async (dir) => {
      const kubeconfig = join(dir, "kubeconfig");
      await writeFile(kubeconfig, cut, { mode: 0o600 });
      const env = this.runEnv(dir, { KUBECONFIG: kubeconfig });
      const kubectl = (...args: string[]) =>
        this.runOnce(
          { command: { command: "kubectl", args: [...args, "--request-timeout=15s"] }, env, cwd: dir },
          KUBECTL_TIMEOUT_MS,
        );
      const [list, del, patch] = await Promise.all([
        kubectl("auth", "can-i", "--list"),
        kubectl("auth", "can-i", "delete", "pods"),
        kubectl("auth", "can-i", "patch", "deployments"),
      ]);
      if (notInstalled(list)) return fail("kubectl is not installed where agents run.");
      if (list.code !== 0)
        return fail(`kubectl could not read the cluster: ${firstLine(list.stderr || list.stdout)}`);
      const rules = Math.max(0, list.stdout.split("\n").filter((l) => l.trim() !== "").length - 1);
      const warnings: string[] = [];
      for (const [run, what] of [
        [del, "delete pods"],
        [patch, "patch deployments"],
      ] as const) {
        if (firstLine(run.stdout) === "yes") {
          warnings.push(`This identity can ${what}. Use a read-only one, like a viewer role.`);
        }
      }
      const where = namespace ? `context ${context}, namespace ${namespace}` : `context ${context}`;
      return { ok: true, detail: `kubectl reads ${where}: ${rules} permission rules.`, warnings };
    });
  }

  /** Connects to the server, remote or local, and lists its tools. */
  private async mcp(v: Values): Promise<Outcome> {
    if ((v.fields.transport ?? "remote") === "remote") {
      const headers: Record<string, string> = {};
      for (const e of v.lists.headers ?? []) if (e.value !== undefined) headers[e.name] = e.value;
      const protocol = v.fields.protocol === "sse" ? "sse" : "http";
      return toolsOutcome(
        await listTools(remoteTransport(v.fields.url ?? "", headers, protocol), MCP_TIMEOUT_MS),
      );
    }
    return this.scratch(async (dir) => {
      const env = this.runEnv(dir, await this.variables(dir, v.lists.env));
      // The owner's command line, as a shell reads it, in the run's sandbox.
      const command = { command: "sh", args: ["-c", `exec ${v.fields.command ?? ""}`] };
      return toolsOutcome(await this.stdioTools({ command, env, cwd: dir }, MCP_TIMEOUT_MS));
    });
  }

  /** `ssh -o BatchMode=yes <alias> true`, from majhi, the way its git reaches hosts. */
  private async ssh(v: Values): Promise<Outcome> {
    const alias = v.fields.alias ?? "";
    const hosts = await sshConfigHosts(this.deps.hostHome);
    if (!hosts.some((h) => h.alias === alias)) return fail(`~/.ssh/config has no Host ${alias}.`);
    const run = await (this.deps.ssh ?? runSsh)([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "--",
      alias,
      "true",
    ]);
    if (run.code === 0) return { ok: true, detail: `Signed in to ${alias} and ran a command.`, warnings: [] };
    if (run.code !== null && run.code !== 255) {
      return fail(`${alias} took the key but did not run a command (exit ${run.code}).`);
    }
    return fail(classifyProbe(run).detail);
  }

  /** The required values are set; with a test command, it runs with them. */
  private async env(v: Values): Promise<Outcome> {
    const vars = v.lists.vars ?? [];
    const test = v.fields.test;
    if (test === undefined) {
      return {
        ok: true,
        detail: `${vars.length} ${vars.length === 1 ? "variable" : "variables"} set.`,
        warnings: ["There is no test command, so majhi only checked that the values are set."],
      };
    }
    return this.scratch(async (dir) => {
      const env = this.runEnv(dir, await this.variables(dir, vars));
      const run = await this.runOnce(
        { command: { command: "sh", args: ["-c", test] }, env, cwd: dir },
        COMMAND_TIMEOUT_MS,
      );
      if (run.code === 0) {
        const said = oneLine(run.stdout).slice(0, 160);
        return { ok: true, detail: said === "" ? `${test} works.` : `${test} works: ${said}`, warnings: [] };
      }
      if (run.code === 127) return fail(`${firstWord(test)} is not installed where agents run.`);
      const why = firstLine(run.stderr || run.stdout);
      const exit = run.code === null ? "did not finish" : `failed with exit ${run.code}`;
      return fail(`${test} ${exit}${why ? `: ${why}` : "."}`);
    });
  }

  /** An IMAP login over TLS and the SMTP greeting. */
  private async mail(v: Values): Promise<Outcome> {
    const host = v.fields.imap_host ?? "";
    await imapLogin({
      host,
      port: Number(v.fields.imap_port ?? "993"),
      user: v.fields.user ?? "",
      password: v.fields.password ?? "",
      timeoutMs: MAIL_TIMEOUT_MS,
    });
    const smtpHost = v.fields.smtp_host;
    if (smtpHost === undefined) {
      return {
        ok: true,
        detail: `Signed in to ${host}. There is no SMTP host, so it only reads.`,
        warnings: [],
      };
    }
    await smtpGreeting({
      host: smtpHost,
      port: Number(v.fields.smtp_port ?? "465"),
      timeoutMs: MAIL_TIMEOUT_MS,
    });
    return { ok: true, detail: `Signed in to ${host}, and ${smtpHost} answers.`, warnings: [] };
  }

  /** The browser MCP server starts and lists its tools. */
  private async browser(v: Values): Promise<Outcome> {
    const server = browserServer(v.fields.server);
    const command = this.deps.browserCommand?.(server) ?? {
      command: "npx",
      args: ["-y", `${server.package}@${server.version}`],
    };
    return this.scratch(async (dir) => {
      const names = await this.stdioTools({ command, env: this.runEnv(dir), cwd: dir }, BROWSER_TIMEOUT_MS);
      const tools = toolsOutcome(names);
      return { ...tools, detail: `${server.label} starts. ${tools.detail}` };
    });
  }

  /** What a Test's programs start with: PATH and LANG of runs, a throwaway HOME, and `extra`. */
  private runEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
    const { base } = this.deps;
    const env: Record<string, string> = { PATH: base.PATH, HOME: join(dir, "home") };
    if (base.LANG) env.LANG = base.LANG;
    if (base.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = base.PLAYWRIGHT_BROWSERS_PATH;
    return { ...env, ...extra };
  }

  /** The entries as variables. A file entry becomes the path of a copy in the scratch folder. */
  private async variables(dir: string, entries: readonly Entry[] = []): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.file !== undefined) {
        const files = join(dir, "files");
        await ownerOnlyDir(files);
        const path = join(files, entry.name);
        await writeFile(path, entry.file, { mode: 0o600 });
        out[entry.name] = path;
      } else if (entry.value !== undefined) {
        out[entry.name] = entry.value;
      }
    }
    return out;
  }

  private async stdioTools(request: SpawnRequest, timeoutMs: number): Promise<string[]> {
    const spawned = await this.deps.spawner(request);
    const transport = new SpawnedTransport(spawned);
    try {
      return await listTools(transport, timeoutMs);
    } catch (err) {
      const why = firstLine(transport.stderr);
      throw new Error(`${firstLine(errorMessage(err))}${why ? `: ${why}` : ""}`);
    } finally {
      spawned.kill();
    }
  }

  /** Runs a program to the end through the spawner, with stdin closed. Never rejects. */
  private async runOnce(request: SpawnRequest, timeoutMs: number): Promise<RunResult> {
    let spawned: Awaited<ReturnType<Spawner>>;
    try {
      spawned = await this.deps.spawner(request);
    } catch (err) {
      return { code: null, stdout: "", stderr: errorMessage(err), missing: errorCode(err) === "ENOENT" };
    }
    const { child } = spawned;
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
      });
      child.stdin.end();
      let done = false;
      const finish = (result: RunResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        spawned.kill();
        finish({
          code: null,
          stdout,
          stderr: `${stderr}\nStopped after ${timeoutMs / 1000} s.`,
          missing: false,
        });
      }, timeoutMs);
      child.once("error", (err) =>
        finish({ code: null, stdout, stderr: errorMessage(err), missing: errorCode(err) === "ENOENT" }),
      );
      child.once("close", (code) => finish({ code, stdout, stderr, missing: false }));
    });
  }

  /** A folder for one Test's files, owner-only, removed when `use` ends. Clears old leftovers first. */
  private async scratch<T>(use: (dir: string) => Promise<T>): Promise<T> {
    const root = await this.deps.scratchRoot();
    await ownerOnlyDir(root);
    await sweep(root);
    const dir = join(root, `${SCRATCH_PREFIX}${randomBytes(6).toString("hex")}`);
    await ownerOnlyDir(dir);
    await ownerOnlyDir(join(dir, "home"));
    try {
      return await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Reads secret values and files for one Test. Only for a connection with no problems. */
  private async resolve(id: string, connection: ConnectionConfig): Promise<Values> {
    const values: Values = { fields: {}, files: {}, lists: {}, secrets: [] };
    const dir = this.deps.connections.dir(id);
    const secret = async (name: string, ref: string) => {
      const value = await this.deps.secrets.get(ref.slice("secret:".length));
      if (value !== undefined) values.secrets.push({ name, value });
      return value;
    };
    const file = (ref: string) => readFile(join(dir, ref.slice("file:".length)));
    for (const field of connectionType(connection.type).fields) {
      const stored = connection.fields?.[field.key];
      if (field.kind === "text") {
        const value = textValue(connection, field.key);
        if (value !== undefined) values.fields[field.key] = value;
      } else if (stored !== undefined && field.kind === "secret") {
        const value = await secret(field.key, stored);
        if (value !== undefined) values.fields[field.key] = value;
      } else if (stored !== undefined) {
        values.files[field.key] = await file(stored);
      }
    }
    for (const list of activeLists(connection.type, connection.fields ?? {})) {
      const entries: Entry[] = [];
      for (const [name, entry] of Object.entries(connection[list.key] ?? {})) {
        if (entry.value === undefined) entries.push({ name, kind: entry.kind });
        else if (entry.kind === "text") entries.push({ name, kind: entry.kind, value: entry.value });
        else if (entry.kind === "file")
          entries.push({ name, kind: entry.kind, file: await file(entry.value) });
        else {
          const value = await secret(name, entry.value);
          entries.push(value === undefined ? { name, kind: entry.kind } : { name, kind: entry.kind, value });
        }
      }
      values.lists[list.key] = entries;
    }
    return values;
  }
}

function fail(detail: string): Outcome {
  return { ok: false, detail, warnings: [] };
}

function toolsOutcome(names: readonly string[]): Outcome {
  if (names.length === 0)
    return {
      ok: true,
      detail: "It answers, with no tools.",
      tools: [],
      warnings: ["The server lists no tools."],
    };
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? `, and ${names.length - 5} more` : "";
  return {
    ok: true,
    detail: `${names.length} ${names.length === 1 ? "tool" : "tools"}: ${shown}${more}.`,
    tools: [...names],
    warnings: [],
  };
}

function notInstalled(run: RunResult): boolean {
  return run.missing || run.code === 127;
}

/** Replaces each secret value with `[secret <connection>.<field>]`, longest first. */
function redact(text: string, id: string, secrets: readonly { name: string; value: string }[]): string {
  let out = text;
  for (const { name, value } of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (value.length >= 4) out = out.split(value).join(`[secret ${id}.${name}]`);
  }
  return out;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

function firstWord(text: string): string {
  return text.trim().split(/\s+/, 1)[0] ?? text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Removes scratch folders of Tests that never cleaned up. */
async function sweep(root: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  }
}
