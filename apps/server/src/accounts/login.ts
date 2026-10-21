import type { RuntimeOptions, SpawnRequest, TtyLaunch } from "@majhi/acp";
import type { HealthCheck } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { accountRuntime } from "./homes.ts";
import type { SignInGuard } from "./identity.ts";
import type { AccountService } from "./service.ts";

export interface LoginDeps {
  majhiHome: string;
  accounts: AccountService;
  /** Pins the account to whoever signed in, when the login ends. */
  identity: SignInGuard;
  terminals: TerminalManager;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  /** Told when a login ends, so the account list can refresh. */
  onFinished: () => void;
  /**
   * Starts the login in a runner container that mounts only this account's home: the server image holds no agent
   * CLI. Absent without a runner (MAJHI_RUNNER=local): the login runs next to majhi.
   */
  tty?: ((req: SpawnRequest) => Promise<TtyLaunch>) | undefined;
}

/** Starts the tool's own login for a login account in a terminal. */
export async function startLogin(
  deps: LoginDeps,
  id: string,
): Promise<{ terminalId: string; command: string }> {
  const config = await deps.accounts.require(id);
  if (config.auth !== "login") throw new UserError(`${id} uses an API key, so it has no login.`);
  const account = accountRuntime(deps.majhiHome, id, config);
  await deps.runtime.prepareHome(account);
  const spec = deps.runtime.loginCommand(account, deps.options);
  const launch =
    deps.tty === undefined
      ? undefined
      : await deps.tty({
          command: { command: spec.command, args: spec.args },
          env: { TERM: "xterm-256color", ...spec.env },
          cwd: account.home,
          scratch: true,
          account,
          accountFolder: true,
        });
  const terminal = deps.terminals.start({
    key: `login:${id}`,
    command: launch?.command ?? spec.command,
    args: launch?.args ?? spec.args,
    env: launch?.env ?? spec.env,
    cwd: account.home,
    ...(launch === undefined ? {} : { stop: launch.stop }),
    onExit: async (code): Promise<HealthCheck | undefined> => {
      try {
        if (code !== 0) return undefined;
        // The owner just signed in: the account now belongs to whoever did (identity.ts), before the check reads it.
        await deps.identity.pin(id, config).catch(() => undefined);
        return (await deps.accounts.health(id, true)).health;
      } finally {
        deps.onFinished();
      }
    },
  });
  return { terminalId: terminal.id, command: spec.display };
}
