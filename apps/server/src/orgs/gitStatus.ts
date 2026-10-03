import {
  type DismissedLogin,
  type GitAccount,
  type GitAccountStatus,
  type GitHost,
  type GitHostLogins,
  type GitLogin,
  type GitStatus,
  type LoginOffer,
  type MrHost,
  normalizeSshRoute,
  sshRouteMatches,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import { mrKindOf, type TokenCheck } from "./gitAccount.ts";

export interface GitStatusDeps {
  org: (id: string) => Promise<
    | {
        accounts: readonly GitAccount[];
        mrTokens: Partial<Record<MrHost, string>>;
        dismissed: readonly DismissedLogin[];
      }
    | undefined
  >;
  /** Host names of the remotes of the org's projects, aliases resolved. */
  usedHosts: (id: string) => Promise<readonly string[]>;
  /** This computer's logins, or undefined when the host helper is not connected. */
  logins: () => Promise<{ hosts: readonly GitHostLogins[]; checkedAt: string } | undefined>;
  /** Whether a saved token works, and as whom. */
  checkToken: (host: string, kind: GitHost, account: string, ref: string) => Promise<TokenCheck>;
  /** Silent: whether this computer saved a login for the account, and if the host takes it as a token. */
  savedLogin: (host: string, kind: GitHost, account: string) => Promise<"none" | "login" | "token">;
  classify: (host: string) => GitHost;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Each org's account per host: how it pushes, whether its token works, and hosts still missing one. */
export async function gitStatus(deps: GitStatusDeps, id: string): Promise<GitStatus> {
  const org = await deps.org(id);
  if (org === undefined) throw new UserError(`Org "${id}" does not exist.`, 404);
  const [found, used] = await Promise.all([
    deps.logins().catch(() => undefined),
    deps.usedHosts(id).catch(() => []),
  ]);
  const loginsOf = (host: string): readonly GitLogin[] =>
    found?.hosts.find((h) => h.host === host)?.logins ?? [];

  const accounts = await Promise.all(
    org.accounts.map(async (a): Promise<GitAccountStatus> => {
      const kind = deps.classify(a.host);
      const logins = loginsOf(a.host).filter((l) => same(l.account, a.account));
      const route = normalizeSshRoute(a.host, a.ssh);
      const key =
        logins.find((l) => sshRouteMatches(route, l) && l.alias === undefined) ??
        logins.find((l) => sshRouteMatches(route, l));
      const ref = a.token ?? org.mrTokens[mrKindOf(kind)];
      // Only asked when it would show something: an https push or the saved-login button.
      const saved =
        found !== undefined && (key === undefined || ref === undefined)
          ? await deps.savedLogin(a.host, kind, a.account).catch(() => "none" as const)
          : "none";
      const push: GitAccountStatus["push"] =
        found === undefined
          ? { state: "unknown" }
          : key !== undefined
            ? { state: "ssh", ...(key.alias === undefined ? {} : { alias: key.alias }) }
            : saved !== "none"
              ? { state: "https" }
              : {
                  state: "missing",
                  choices: logins
                    .filter((l) => l.via === "ssh")
                    .map((l) => ({
                      ssh: l.alias ?? "default",
                      label: l.alias === undefined ? `${a.host} default key` : `SSH alias ${l.alias}`,
                    })),
                };
      let token: GitAccountStatus["token"];
      if (ref === undefined) {
        const cli = logins.find((l) => l.via === "gh" || l.via === "glab")?.via;
        token = {
          state: "missing",
          ...(cli === "gh" || cli === "glab" ? { cli } : {}),
          savedLogin: saved === "token",
        };
      } else {
        const check = await deps
          .checkToken(a.host, kind, a.account, ref)
          .catch((): TokenCheck => ({ state: "unreachable" }));
        token = check.state === "unreachable" ? { state: "unchecked" } : check;
      }
      return { host: a.host, account: a.account, kind, push, token };
    }),
  );

  const covered = new Set(org.accounts.map((a) => a.host));
  const missing = [...new Set(used.map((h) => h.toLowerCase()))]
    .filter((host) => !covered.has(host))
    .sort()
    .map((host) => ({
      host,
      kind: deps.classify(host),
      offers: offersFor(host, loginsOf(host), org.dismissed),
    }));

  const kinds = new Set(org.accounts.map((a) => mrKindOf(deps.classify(a.host))));
  const tokens = (Object.entries(org.mrTokens) as Array<[MrHost, string | undefined]>).flatMap(
    ([kind, ref]) => (ref === undefined || kinds.has(kind) ? [] : [{ kind, ref }]),
  );

  return {
    ...(found === undefined ? {} : { checkedAt: found.checkedAt }),
    accounts,
    missing,
    tokens,
  };
}

/**
 * The logins of one host, one offer per account, without those the owner said No to for this org.
 * The default key is the SSH route when it logs in as the account, else the first alias.
 */
export function offersFor(
  host: string,
  logins: readonly GitLogin[],
  dismissed: readonly DismissedLogin[],
): LoginOffer[] {
  const out: LoginOffer[] = [];
  for (const l of logins) {
    if (dismissed.some((d) => d.host === host && same(d.account, l.account))) continue;
    let offer = out.find((o) => same(o.account, l.account));
    if (offer === undefined) {
      offer = { account: l.account, via: [] };
      out.push(offer);
    }
    if (!offer.via.includes(l.via)) offer.via.push(l.via);
    if (l.via === "ssh" && (offer.ssh === undefined || l.alias === undefined)) {
      offer.ssh = l.alias ?? "default";
    }
  }
  return out;
}

const CHECK_MS = 10 * 60_000;

/**
 * Remembers token and saved-login checks for ten minutes, so opening the org page does not call
 * the host's API each time. `clear` forgets them all, for Detect again.
 */
export class CheckCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined && this.now() - hit.at < CHECK_MS) return hit.value as Promise<T>;
    const value = run();
    this.entries.set(key, { at: this.now(), value });
    value.catch(() => this.entries.delete(key));
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
