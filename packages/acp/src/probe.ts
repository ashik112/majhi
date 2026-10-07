import type { HealthStep, ToolId } from "@majhi/shared";
import { AcpAuthRequired, readSessionOptions } from "./acp-session.ts";
import { buildEnv } from "./env.ts";
import { exec } from "./exec.ts";
import type { AccountProbe, AccountRuntime, Command, RuntimeOptions } from "./index.ts";
import { getTool } from "./tools/index.ts";

const DEFAULT_TIMEOUT_MS = 20_000;

function adapterFor(tool: ToolId, options: RuntimeOptions): Command {
  return options.adapters?.[tool] ?? getTool(tool).adapter;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * Checks an account without spending tokens: the CLI starts (`cli`), it reports
 * being signed in (`auth`), and an ACP session opens (`acp`), whose config
 * options give the models and effort levels.
 */
export async function probeAccount(account: AccountRuntime, options: RuntimeOptions): Promise<AccountProbe> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tool = getTool(account.tool);
  const adapter = adapterFor(account.tool, options);
  const env = buildEnv(account, options.base);
  const steps: HealthStep[] = [];
  const result: AccountProbe = { health: { ok: false, checkedAt: "", durationMs: 0, steps } };

  const finish = (): AccountProbe => {
    result.health.ok = steps.every((s) => s.ok);
    result.health.checkedAt = new Date().toISOString();
    result.health.durationMs = Date.now() - started;
    return result;
  };

  // cli
  const version = await exec(adapter.command, [...adapter.args, ...tool.versionArgs], env, timeoutMs);
  if (version.code !== 0) {
    const why = version.error ?? (firstLine(version.stderr) || `exited with code ${version.code}`);
    steps.push({ name: "cli", ok: false, detail: `${tool.info.name} did not start. ${why}` });
    return finish();
  }
  steps.push({ name: "cli", ok: true, detail: firstLine(version.stdout) || "Started" });

  // auth
  if (account.apiKey !== undefined) {
    const ok = account.apiKey.length > 0;
    steps.push({ name: "auth", ok, detail: ok ? "API key" : "No API key set" });
    if (!ok) return finish();
  } else {
    const status = await exec(adapter.command, [...adapter.args, ...tool.authStatusArgs], env, timeoutMs);
    if (status.error) {
      steps.push({ name: "auth", ok: false, detail: status.error });
      return finish();
    }
    const parsed = tool.parseAuthStatus(status.code ?? 1, status.stdout);
    if (!parsed.signedIn) {
      steps.push({ name: "auth", ok: false, detail: "Not signed in. Sign in from Accounts." });
      return finish();
    }
    steps.push({ name: "auth", ok: true, detail: parsed.as ?? "Signed in" });
    if (parsed.as) result.signedInAs = parsed.as;
  }

  // acp
  try {
    const session = await readSessionOptions(adapter, env, timeoutMs);
    steps.push({ name: "acp", ok: true, detail: `${session.models.length} models` });
    result.models = {
      models: session.models,
      efforts: session.efforts,
      ...(session.defaultModel ? { defaultModel: session.defaultModel } : {}),
      ...(session.defaultEffort ? { defaultEffort: session.defaultEffort } : {}),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    const detail =
      err instanceof AcpAuthRequired
        ? "The agent says sign-in is required. Sign in again from Accounts."
        : `Could not open a session. ${err instanceof Error ? err.message : String(err)}`;
    steps.push({ name: "acp", ok: false, detail });
  }
  return finish();
}

/** The CLI version behind a tool's adapter, for `doctor`. Rejects when it does not start. */
export async function cliVersion(tool: ToolId, options: RuntimeOptions): Promise<string> {
  const spec = getTool(tool);
  const adapter = adapterFor(tool, options);
  const env: Record<string, string> = { PATH: options.base.PATH };
  if (options.base.TMPDIR) env.TMPDIR = options.base.TMPDIR;
  if (options.base.LANG) env.LANG = options.base.LANG;
  const res = await exec(
    adapter.command,
    [...adapter.args, ...spec.versionArgs],
    env,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.code !== 0) {
    throw new Error(res.error ?? (firstLine(res.stderr) || `${spec.info.name} exited with code ${res.code}`));
  }
  return res.stdout.trim();
}
