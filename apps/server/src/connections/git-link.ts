import {
  type CommandMeta,
  type ConnectionView,
  DEFAULT_GIT_HOST,
  type MrHost,
  type OrgConfig,
  suggestConnectionId,
} from "@majhi/shared";

/**
 * A workspace's sign-in to a git host is also one connection (SPEC 5.14), so it has a row, a state and a
 * check like every other. The sign-in itself lives in the workspace's git accounts (`git_accounts`),
 * where Ship, MRs and push read it; this makes the `git` connection that gives agents `gh`, `glab` or
 * the Bitbucket variables, and runs its first check.
 */

const KIND_NAME: Record<MrHost, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket" };
const OWNER: CommandMeta = { actor: { kind: "owner" } };

export interface GitLinkDeps {
  connections: {
    list(): Promise<ConnectionView[]>;
    create(
      input: {
        org: string;
        type: "git";
        name: string;
        description?: string;
        fields: Record<string, string>;
      },
      command: string,
      meta: CommandMeta,
    ): Promise<ConnectionView>;
    update(
      input: { id: string; fields: Record<string, string | null> },
      command: string,
      meta: CommandMeta,
    ): Promise<unknown>;
  };
  orgs: () => Promise<Record<string, OrgConfig>>;
  /** Which git service a host is, by its name (github, gitlab, bitbucket in it), or none. */
  kindOf: (host: string) => MrHost | undefined;
  /** How an existing account signed in, read from what is stored. Undefined: unknown. */
  viaOf?: (
    org: string,
    account: { host: string; token?: string | undefined; oauth?: string | undefined },
  ) => Promise<"browser" | "token" | undefined>;
  /** The check, which decides the connection's state. */
  check: (id: string) => Promise<unknown>;
  health: { start(id: string): unknown };
}

export interface GitHostRef {
  org: string;
  kind: MrHost;
  host: string;
  /** The owner confirmed that a self-hosted host is on their own network. */
  privateNetwork?: boolean | undefined;
  /** How the workspace signed in: the host's own page, or a pasted token. Unknown for an account from before. */
  via?: "browser" | "token" | undefined;
}

export class GitLink {
  private readonly running = new Map<string, Promise<string>>();

  constructor(private readonly deps: GitLinkDeps) {}

  /** The workspace's `git` connection for this host: found, or made. */
  async ensure(ref: GitHostRef, meta: CommandMeta = OWNER): Promise<string> {
    const existing = (await this.deps.connections.list()).find(
      (c) => c.type === "git" && c.org === ref.org && this.matches(c, ref),
    );
    if (existing !== undefined) {
      if (ref.privateNetwork === true && existing.fields.private_network?.value !== "yes") {
        await this.deps.connections.update(
          { id: existing.id, fields: { private_network: "yes" } },
          "git.signIn.token",
          meta,
        );
      }
      return existing.id;
    }
    const selfHosted = ref.host !== DEFAULT_GIT_HOST[ref.kind];
    const name = selfHosted ? `${KIND_NAME[ref.kind]} (${ref.host})` : KIND_NAME[ref.kind];
    const taken = new Set((await this.deps.connections.list()).map((c) => c.id));
    const view = await this.deps.connections.create(
      {
        org: ref.org,
        id: suggestConnectionId(`${ref.kind} ${selfHosted ? ref.host : ""} ${ref.org}`, taken),
        type: "git",
        name,
        description: `${name}, signed in for this workspace.`,
        fields: {
          provider: ref.kind,
          ...(ref.via === undefined ? {} : { signed_in_by: ref.via }),
          ...(selfHosted ? { host: ref.host } : {}),
          ...(ref.privateNetwork === true ? { private_network: "yes" } : {}),
        },
      } as Parameters<GitLinkDeps["connections"]["create"]>[0] & { id: string },
      "git.signIn.token",
      meta,
    );
    return view.id;
  }

  private matches(c: ConnectionView, ref: GitHostRef): boolean {
    const provider = c.fields.provider?.value ?? "gitlab";
    const host = c.fields.host?.value ?? DEFAULT_GIT_HOST[provider as MrHost] ?? "";
    return provider === ref.kind && host === ref.host;
  }

  /**
   * The workspace signed in to this host: make or find the connection, and check it. Concurrent calls
   * for one host share one run, so the sign-in's own hook and the command that awaits it do not check twice.
   */
  signedIn(ref: GitHostRef, meta: CommandMeta = OWNER): Promise<string> {
    const key = `${ref.org} ${ref.kind} ${ref.host}`;
    const running = this.running.get(key);
    if (running !== undefined) return running;
    const run = (async () => {
      const id = await this.ensure(ref, meta);
      this.deps.health.start(id);
      await this.deps.check(id);
      return id;
    })().finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  /** A connection for every git account that has a token and none yet. Checked later, by the startup pass. */
  async syncAll(): Promise<void> {
    for (const [org, config] of Object.entries(await this.deps.orgs())) {
      for (const account of config.git_accounts ?? []) {
        if (account.token === undefined) continue;
        const kind = this.deps.kindOf(account.host);
        if (kind === undefined) continue;
        const via = await this.deps.viaOf?.(org, account).catch(() => undefined);
        await this.ensure({ org, kind, host: account.host, via }).catch(() => undefined);
      }
    }
  }
}

/** For tests and callers that hold a connection's fields. */
export function gitHostOf(c: Pick<ConnectionView, "fields">): { kind: MrHost; host: string } {
  const kind = (c.fields.provider?.value ?? "gitlab") as MrHost;
  return { kind, host: c.fields.host?.value ?? DEFAULT_GIT_HOST[kind] };
}
