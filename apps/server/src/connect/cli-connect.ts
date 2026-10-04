import type { CliCheckResult, CliLoginResult, CliToolId } from "@majhi/shared";
import type { HostLink } from "../host/link.ts";

/**
 * The host helper's side of a command-line tool sign-in (SPEC 5.14, "Command-line tools"). The
 * helper runs the tool's own login on the owner's computer, in the folder of one connection, and
 * says who signed in. The server never sees a token of it: the tool keeps its files in that folder,
 * and only that workspace's runs mount it.
 */
export interface CliHost {
  /** False when the host helper is not connected: there is then no tool to run. */
  connected(): boolean;
  login(
    params: { signIn: string; tool: CliToolId; connection: string; expected?: string },
    onPage: (page: { url: string; code?: string | undefined }) => void,
  ): Promise<CliLoginResult>;
  cancel(signIn: string): Promise<void>;
  check(params: { tool: CliToolId; connection: string }): Promise<CliCheckResult>;
  logout(params: { tool: CliToolId; connection: string }): Promise<{ revoked: boolean }>;
}

/** A sign-in never waits longer than the helper does. */
export const CLI_LOGIN_TIMEOUT_MS = 16 * 60_000;
const SHORT_MS = 40_000;

export function hostCli(link: Pick<HostLink, "isConnected" | "call">): CliHost {
  return {
    connected: () => link.isConnected(),
    login: (params, onPage) =>
      link.call("cli.login", params, CLI_LOGIN_TIMEOUT_MS, (p) => {
        if ("login" in p) onPage(p.login);
      }),
    cancel: async (signIn) => {
      if (link.isConnected()) await link.call("cli.loginCancel", { signIn }, 10_000);
    },
    check: (params) => link.call("cli.check", params, SHORT_MS),
    logout: (params) => link.call("cli.logout", params, SHORT_MS),
  };
}
