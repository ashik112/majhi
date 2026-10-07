import {
  type GitAccountStatus,
  type GitHost,
  type LoginOffer,
  type OrgView,
  type SignOut,
  tokenPageUrl,
} from "@majhi/shared";
import { ExternalLink, RefreshCw } from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Dot, type DotTone } from "@/components/ui/status-dot";
import { GitSignInPanel, SignedOutNotice, SignOutButton } from "@/features/git-signin/panel";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { HOST_LABEL } from "@/lib/hosts";
import { useOnboardingStatus } from "@/lib/onboarding-queries";
import {
  useDetectAgain,
  useDismissGitLogin,
  useGitStatus,
  useSetGitAccount,
  useUpdateOrg,
  useUseSavedLogin,
} from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";

/** Where a host lists the account's SSH keys, for when no key on this computer logs in as it. */
const SSH_KEYS_PAGE: Partial<Record<GitHost, (host: string) => string>> = {
  github: () => "https://github.com/settings/keys",
  gitlab: (host) => `https://${host}/-/user_settings/ssh_keys`,
  bitbucket: () => "https://bitbucket.org/account/settings/ssh-keys/",
};

const VIA_LABEL: Record<LoginOffer["via"][number], string> = {
  ssh: "SSH key",
  gh: "gh login",
  glab: "glab login",
};

/** Runs an action and keeps its failure, in plain words, for the spot that started it. */
function useAction() {
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>) => {
    setFailure(undefined);
    setBusy(true);
    fn()
      .catch((e: unknown) => setFailure(describeError(e)))
      .finally(() => setBusy(false));
  };
  return { failure, busy, run, setFailure };
}

/**
 * The org's git accounts, one row per host: how it pushes, whether its merge request token works,
 * and the commit identity, each with the one step that fixes it. Hosts the org's projects use with
 * no account yet show the logins found on this computer. On top, the same sign-in panel as the
 * onboarding git step: "Sign in with" GitHub, GitLab or Bitbucket, or a pasted token.
 */
export function GitAccounts({ org }: { org: OrgView }) {
  const status = useGitStatus(org.id);
  const detect = useDetectAgain(org.id);
  const now = useNow(30_000);
  const journey = useOnboardingStatus();
  const workspaces = journey.data?.workspaces;
  const names = useMemo(() => new Map((workspaces ?? []).map((w) => [w.id, w.name])), [workspaces]);
  const git = workspaces?.find((w) => w.id === org.id)?.git ?? [];
  const [signedOut, setSignedOut] = useState<SignOut>();
  const data = status.data;
  const checked = data?.checkedAt;
  const rows = (data?.accounts.length ?? 0) + (data?.missing.length ?? 0);
  return (
    <DetailSection
      title="Git accounts"
      note={`Who ${org.name} pushes as.`}
      actions={
        <>
          {checked !== undefined && !detect.isPending && (
            <span className="text-sm text-fg-faint">Checked {formatAgo(checked, now)}</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={detect.isPending || status.isPending}
            onClick={() => detect.mutate()}
          >
            <RefreshCw aria-hidden="true" className={detect.isPending ? "animate-spin" : undefined} />
            {detect.isPending ? "Detecting" : "Detect again"}
          </Button>
        </>
      }
    >
      <GitSignInPanel workspace={{ id: org.id, name: org.name }} git={git} names={names} showSigned={false} />
      {signedOut && <SignedOutNotice result={signedOut} />}
      {status.isPending ? (
        <p className="m-0 text-sm text-fg-faint">Looking at this computer's keys and logins.</p>
      ) : data === undefined ? (
        <p className="m-0 text-sm text-fg-muted">
          The git accounts could not be read{status.error ? `: ${describeError(status.error)}` : "."}
        </p>
      ) : (
        <>
          {checked === undefined && (
            <p className="m-0 text-sm text-fg-muted">
              The host helper is not connected, so majhi cannot see this computer's keys and logins.
            </p>
          )}
          {detect.error && (
            <p role="alert" className="m-0 text-sm text-red">
              {describeError(detect.error)}
            </p>
          )}
          {rows === 0 ? (
            <p className="m-0 text-sm text-fg-faint">
              No git accounts yet. Sign in above, or register a project of {org.name} and the hosts of its
              remotes show here.
            </p>
          ) : (
            <ul aria-label={`Git accounts of ${org.name}`} className="m-0 flex list-none flex-col p-0">
              {data.accounts.map((a) => (
                <AccountRow key={`${a.host}/${a.account}`} org={org} status={a} onSignedOut={setSignedOut} />
              ))}
              {data.missing.map((m) => (
                <MissingRow key={m.host} org={org} host={m.host} kind={m.kind} offers={m.offers} />
              ))}
            </ul>
          )}
          {data.tokens.map((t) => (
            <p key={t.kind} className="m-0 text-sm text-fg-muted">
              A {HOST_LABEL[t.kind]} token is saved for merge requests. Add the account it belongs to and it
              shows there.
            </p>
          ))}
        </>
      )}
    </DetailSection>
  );
}

const ROW = "flex min-w-0 flex-col gap-3 border-t border-line py-4 first:border-t-0 first:pt-1 last:pb-0";

function RowHead({ kind, children, actions }: { kind: GitHost; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
      <HostGlyph host={kind} />
      <div className="flex min-w-0 items-baseline gap-2 text-sm">{children}</div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

function AccountRow({
  org,
  status,
  onSignedOut,
}: {
  org: OrgView;
  status: GitAccountStatus;
  onSignedOut: (result: SignOut) => void;
}) {
  const { remove } = useSetGitAccount();
  const kind = status.kind === "other" ? undefined : status.kind;
  return (
    <li className={ROW}>
      <RowHead
        kind={status.kind}
        actions={
          <>
            {kind !== undefined && status.token.state !== "missing" && (
              <SignOutButton org={org.id} kind={kind} host={status.host} onSignedOut={onSignedOut} />
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: org.id, host: status.host, account: status.account })}
            >
              Remove
            </Button>
          </>
        }
      >
        <span className="truncate font-mono text-fg">{status.account}</span>
        <span className="truncate text-fg-faint">on {status.host}</span>
      </RowHead>
      <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-3 pl-[22px]">
        <Line label="Push">
          <PushLine org={org.id} status={status} />
        </Line>
        <Line label="Merge requests">
          <TokenLine org={org.id} status={status} />
        </Line>
        <Line label="Commit identity">
          <IdentityLine org={org} account={status.account} />
        </Line>
      </dl>
    </li>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm leading-5 text-fg-faint">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col items-start gap-2">{children}</dd>
    </>
  );
}

function State({ tone, children }: { tone: DotTone; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm leading-5 text-fg-soft">
      <Dot tone={tone} size={7} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

function Failure({ text }: { text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <p role="alert" className="m-0 max-w-[60ch] text-sm text-pretty text-red">
      {text}
    </p>
  );
}

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ExternalLink aria-hidden="true" />
      </a>
    </Button>
  );
}

function PushLine({ org, status }: { org: string; status: GitAccountStatus }) {
  const { set } = useSetGitAccount();
  const action = useAction();
  const push = status.push;
  if (push.state === "ssh") {
    return (
      <State tone="green">
        {push.alias === undefined ? (
          "SSH key ok (default key)"
        ) : (
          <>
            SSH alias <span className="font-mono text-fg">{push.alias}</span> ok
          </>
        )}
      </State>
    );
  }
  if (push.state === "https") return <State tone="green">Pushes with this computer's saved login</State>;
  if (push.state === "unknown") return <State tone="neutral">Not known while the host helper is off</State>;
  const keys = SSH_KEYS_PAGE[status.kind]?.(status.host);
  return (
    <>
      <State tone="amber">
        {push.note ?? (
          <>
            No SSH key on this computer logs in as <span className="font-mono text-fg">{status.account}</span>
          </>
        )}
      </State>
      {push.choices.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {push.choices.map((c) => (
            <Button
              key={c.ssh}
              size="sm"
              disabled={action.busy}
              onClick={() =>
                action.run(() =>
                  set.mutateAsync({ id: org, host: status.host, account: status.account, ssh: c.ssh }),
                )
              }
            >
              Push with the {c.label}
            </Button>
          ))}
        </div>
      ) : (
        keys && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-faint">
            <ExternalButton href={keys}>Add an SSH key on {status.host}</ExternalButton>
            then Detect again.
          </span>
        )
      )}
      <Failure text={action.failure} />
    </>
  );
}

function TokenLine({ org, status }: { org: string; status: GitAccountStatus }) {
  const token = status.token;
  if (token.state === "ok") {
    return (
      <State tone="green">
        Works as <span className="font-mono text-fg">{token.as}</span>
      </State>
    );
  }
  if (token.state === "unchecked") {
    return <State tone="neutral">Token saved. {status.host} could not be reached to check it.</State>;
  }
  return (
    <>
      <State tone="amber">
        {token.state === "refused" ? `${status.host} no longer accepts the saved token` : "No token yet"}
      </State>
      <TokenFix org={org} status={status} />
    </>
  );
}

/** The ways to give an account a token, in order: a CLI login, this computer's saved login, a new token. */
function TokenFix({ org, status }: { org: string; status: GitAccountStatus }) {
  const { set } = useSetGitAccount();
  const saved = useUseSavedLogin();
  const action = useAction();
  const [value, setValue] = useState("");
  const token = status.token;
  const create = tokenPageUrl(status.kind, status.host, org);
  const bitbucket = status.kind === "bitbucket";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pasted = value.trim();
    if (pasted === "") return;
    action.run(async () => {
      await set.mutateAsync({ id: org, host: status.host, account: status.account, token: pasted });
      setValue("");
    });
  };
  const cli = token.state === "missing" ? token.cli : undefined;
  const savedLogin = token.state === "missing" && token.savedLogin;
  return (
    <>
      {(cli !== undefined || savedLogin) && (
        <div className="flex flex-wrap items-center gap-2">
          {cli !== undefined && (
            <Button
              size="sm"
              disabled={action.busy}
              onClick={() =>
                action.run(() => set.mutateAsync({ id: org, host: status.host, account: status.account }))
              }
            >
              Use {cli} login
            </Button>
          )}
          {savedLogin && (
            <Button
              size="sm"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  const r = await saved.mutateAsync({ id: org, host: status.host, account: status.account });
                  if (!r.saved) action.setFailure(r.reason);
                })
              }
            >
              Use this computer's saved login
            </Button>
          )}
        </div>
      )}
      {create && (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ExternalButton href={create}>
            {bitbucket ? "Create an Atlassian API token for Bitbucket" : `Create a token on ${status.host}`}
          </ExternalButton>
          <span className="text-sm text-fg-faint">
            Log in to {status.host} as <span className="font-mono text-fg-muted">{status.account}</span>{" "}
            first.
          </span>
        </span>
      )}
      <form onSubmit={submit} className="flex w-full max-w-[440px] items-center gap-2">
        <Input
          aria-label={`Token for ${status.account} on ${status.host}`}
          type="password"
          autoComplete="new-password"
          placeholder={bitbucket ? "Atlassian email:API token" : "Paste the token"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" disabled={value.trim() === "" || action.busy}>
          {action.busy && value.trim() !== "" ? "Checking" : "Verify and save"}
        </Button>
      </form>
      <Failure text={action.failure} />
    </>
  );
}

function IdentityLine({ org, account }: { org: OrgView; account: string }) {
  const update = useUpdateOrg();
  const action = useAction();
  const [name, setName] = useState(account);
  const [email, setEmail] = useState("");
  if (org.identity !== undefined) {
    return (
      <State tone="green">
        {org.identity.name} <span className="font-mono text-fg-muted">{org.identity.email}</span>
      </State>
    );
  }
  return (
    <>
      <State tone="amber">Not set. Commits need a name and an email.</State>
      <form
        className="flex w-full max-w-[560px] flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          action.run(() =>
            update.mutateAsync({ id: org.id, identity: { name: name.trim(), email: email.trim() } }),
          );
        }}
      >
        <Input
          aria-label="Commit name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-[160px] flex-none"
        />
        <Input
          aria-label="Commit email"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-[220px] flex-none"
        />
        <Button type="submit" disabled={name.trim() === "" || email.trim() === "" || action.busy}>
          Set identity
        </Button>
      </form>
      <Failure text={action.failure} />
    </>
  );
}

/** A host the org's projects use with no account yet: the logins found for it, each with Use and No. */
function MissingRow({
  org,
  host,
  kind,
  offers,
}: {
  org: OrgView;
  host: string;
  kind: GitHost;
  offers: readonly LoginOffer[];
}) {
  const { set } = useSetGitAccount();
  const dismiss = useDismissGitLogin();
  const action = useAction();
  const [typed, setTyped] = useState("");
  const use = (account: string, ssh?: string) =>
    action.run(() => set.mutateAsync({ id: org.id, host, account, ...(ssh === undefined ? {} : { ssh }) }));
  return (
    <li className={ROW}>
      <RowHead kind={kind}>
        <span className="font-medium text-fg">Add the {host} account</span>
      </RowHead>
      <div className="flex min-w-0 flex-col gap-2 pl-[22px]">
        {offers.length > 0 ? (
          <>
            <p className="m-0 text-sm text-fg-faint">Found on this computer. Use it for {org.name}?</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {offers.map((o) => (
                <li key={o.account} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="truncate font-mono text-sm text-fg">{o.account}</span>
                  <span className="text-sm text-fg-faint">{o.via.map((v) => VIA_LABEL[v]).join(", ")}</span>
                  <span className="flex items-center gap-1">
                    <Button size="sm" disabled={action.busy} onClick={() => use(o.account, o.ssh)}>
                      Use
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() =>
                        action.run(() => dismiss.mutateAsync({ id: org.id, host, account: o.account }))
                      }
                    >
                      No
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <form
            className="flex w-full max-w-[440px] flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim() !== "") use(typed.trim());
            }}
          >
            <span className="text-sm text-fg-faint">
              Type the account {org.name} uses on {host}.
            </span>
            <span className="flex items-center gap-2">
              <Input
                aria-label={`Account on ${host}`}
                placeholder="Account name"
                className="font-mono"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <Button type="submit" disabled={typed.trim() === "" || action.busy}>
                Add
              </Button>
            </span>
          </form>
        )}
        <Failure text={action.failure} />
      </div>
    </li>
  );
}
