import type { RuntimeOptions } from "@majhi/acp";
import type { HealthCheck } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { accountRuntime } from "./homes.ts";
import type { AccountService } from "./service.ts";

export interface LoginDeps {
  majhiHome: string;
  accounts: AccountService;
  terminals: TerminalManager;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  /** Told when a login ends, so the account list can refresh. */
  onFinished: () => void;
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
  const terminal = deps.terminals.start({
    key: `login:${id}`,
    command: spec.command,
    args: spec.args,
    env: spec.env,
    cwd: account.home,
    onExit: async (code): Promise<HealthCheck | undefined> => {
      try {
        if (code !== 0) return undefined;
        return (await deps.accounts.health(id, true)).health;
      } finally {
        deps.onFinished();
      }
    },
  });
  return { terminalId: terminal.id, command: spec.display };
}
