import {
  DEFAULT_GIT_HOST,
  type GitLogin,
  type MrHost,
  type OnboardingWorkspace,
  PRIVATE,
  type SignOut,
  tokenPageUrl,
} from "@majhi/shared";
import { ChevronDown, CircleCheck } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { type FormEvent, useMemo, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useSignOut } from "@/lib/onboarding-queries";
import { useGitLogins, useSetGitAccount } from "@/lib/studio-queries";
import { ExternalButton } from "../bits";
import { hostKind } from "../model";
import { Problem, StepFrame, useStep } from "../step-frame";
import { SignIn } from "./sign-in";

const KINDS: readonly MrHost[] = ["github", "gitlab", "bitbucket"];
const VIA: Record<GitLogin["via"], string> = { gh: "gh login", glab: "glab login", ssh: "SSH key" };

/** Workspaces that need a git sign-in: every one but Private, and Private once it has projects. */
function needsGit(w: OnboardingWorkspace): boolean {
  return w.id !== PRIVATE || w.projects > 0;
}

/**
 * Git accounts, per workspace, one row each. A row opens to the logins found on this computer
 * (Use), "Sign in with" each host in the browser, and a pasted token as the fallback. The first
 * workspace still waiting is open; one sign-in runs at a time.
 */
export function GitStep() {
  const step = useStep();
  const workspaces = step.status.workspaces;
  const [active, setActive] = useState<{ org: string; kind: MrHost } | null>(null);
  const [openPick, setOpen] = useState<string | null>();
  const logins = useGitLogins();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const waiting = workspaces.find((w) => needsGit(w) && !w.git.some((g) => g.signedIn));
  const openId = openPick === undefined ? (waiting?.id ?? null) : openPick;

  return (
    <StepFrame>
      <ul aria-label="Workspaces" className="m-0 flex list-none flex-col gap-2 p-0">
        {workspaces.map((w) => (
          <WorkspaceGit
            key={w.id}
            workspace={w}
            names={names}
            open={openId === w.id}
            onToggle={() => setOpen(openId === w.id ? null : w.id)}
            found={logins.data?.hosts ?? []}
            active={active?.org === w.id ? active.kind : null}
            onSignIn={(kind) => setActive({ org: w.id, kind })}
            onClose={() => setActive(null)}
          />
        ))}
      </ul>
    </StepFrame>
  );
}

function WorkspaceGit({
  workspace,
  names,
  open,
  onToggle,
  found,
  active,
  onSignIn,
  onClose,
}: {
  workspace: OnboardingWorkspace;
  names: ReadonlyMap<string, string>;
  open: boolean;
  onToggle: () => void;
  found: readonly { host: string; logins: readonly GitLogin[] }[];
  active: MrHost | null;
  onSignIn: (kind: MrHost) => void;
  onClose: () => void;
}) {
  const [pasting, setPasting] = useState(false);
  const [signedOut, setSignedOut] = useState<SignOut>();
  const signed = workspace.git.filter((g) => g.signedIn);
  const offers = found.flatMap((h) =>
    h.logins
      .filter(
        (l) =>
          !workspace.git.some(
            (g) => g.host === h.host && g.account?.toLowerCase() === l.account.toLowerCase(),
          ),
      )
      .map((l) => ({ host: h.host, login: l })),
  );
  const first = signed[0];
  const bodyId = `git-${workspace.id}`;

  return (
    <li
      className={cn(
        "flex flex-col rounded-xl border transition-colors duration-200",
        open ? "border-line-control bg-card" : "border-line-strong bg-transparent hover:border-line-control",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl px-4 text-left"
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: workspace.color ?? "var(--c-fg-dim)" }}
        />
        <span className="min-w-0 truncate text-body font-semibold text-fg">{workspace.name}</span>
        <span className="ml-auto flex min-w-0 items-center gap-2 text-sm">
          {first ? (
            <>
              <HostGlyph host={first.kind} />
              <span className="truncate text-fg-soft">
                Works as <span className="font-mono">@{first.account ?? HOST_LABEL[first.kind]}</span>
                {signed.length > 1 ? `, and ${signed.length - 1} more` : ""}
              </span>
              <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-green" />
            </>
          ) : (
            <span className="text-fg-faint">
              {needsGit(workspace) ? "Not signed in yet" : "Optional until it has projects"}
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-fg-faint transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <m.div
          id={bodyId}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col gap-4 border-t border-line px-4 pt-4 pb-5"
        >
          {signed.length > 0 && (
            <ul
              aria-label={`${workspace.name} git accounts`}
              className="m-0 flex list-none flex-col gap-1.5 p-0"
            >
              {signed.map((g) => (
                <SignedRow
                  key={`${g.host}/${g.account ?? ""}`}
                  workspace={workspace}
                  git={g}
                  onSignedOut={setSignedOut}
                />
              ))}
            </ul>
          )}

          {signedOut && <SignedOutNotice result={signedOut} />}

          {offers.length > 0 && !active && <FoundLogins workspace={workspace} offers={offers.slice(0, 3)} />}

          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm text-fg-muted">
              {signed.length > 0 ? "Add another host" : "Sign in with"}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {KINDS.map((kind) => (
                <Button
                  key={kind}
                  aria-pressed={active === kind}
                  aria-label={`Sign in with ${HOST_LABEL[kind]}`}
                  className="aria-pressed:border-accent-line aria-pressed:bg-accent-wash"
                  onClick={() => onSignIn(kind)}
                >
                  <HostGlyph host={kind} />
                  {HOST_LABEL[kind]}
                </Button>
              ))}
            </div>
          </div>

          <AnimatePresence initial={false}>
            {active && (
              <SignIn key={active} workspace={workspace} kind={active} names={names} onClose={onClose} />
            )}
          </AnimatePresence>

          {pasting ? (
            <PasteToken workspace={workspace} onDone={() => setPasting(false)} />
          ) : (
            <p className="m-0 text-sm text-fg-faint">
              No browser handy?{" "}
              <button
                type="button"
                onClick={() => setPasting(true)}
                className="cursor-pointer text-fg-muted underline decoration-line-control underline-offset-[3px] hover:text-fg"
              >
                Paste a token instead
              </button>
            </p>
          )}
        </m.div>
      )}
    </li>
  );
}

function FoundLogins({
  workspace,
  offers,
}: {
  workspace: OnboardingWorkspace;
  offers: readonly { host: string; login: GitLogin }[];
}) {
  const { set } = useSetGitAccount();
  const [used, setUsed] = useState<string>();
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm text-fg-muted">Found on this computer</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {offers.map(({ host, login }) => {
          const key = `${host}/${login.account}/${login.via}`;
          const kind = hostKind(host);
          return (
            <li
              key={key}
              className="flex min-h-10 items-center gap-3 rounded-lg border border-line-strong bg-field px-3"
            >
              {kind ? <HostGlyph host={kind} className="size-4" /> : null}
              <span className="min-w-0 truncate font-mono text-base text-fg">{login.account}</span>
              <span className="min-w-0 truncate text-sm text-fg-faint">
                {host}, {VIA[login.via]}
              </span>
              <Button
                size="sm"
                className="ml-auto"
                disabled={set.isPending}
                onClick={() => {
                  setUsed(key);
                  set.mutate({
                    id: workspace.id,
                    host,
                    account: login.account,
                    ...(login.via === "ssh" && login.alias ? { ssh: login.alias } : {}),
                  });
                }}
              >
                {set.isPending && used === key ? "Using" : `Use for ${workspace.name}`}
              </Button>
            </li>
          );
        })}
      </ul>
      {set.error && <Problem>{describeError(set.error)}</Problem>}
    </div>
  );
}

function PasteToken({ workspace, onDone }: { workspace: OnboardingWorkspace; onDone: () => void }) {
  const { set } = useSetGitAccount();
  const [kind, setKind] = useState<MrHost>("github");
  const [account, setAccount] = useState("");
  const [token, setToken] = useState("");
  const host = DEFAULT_GIT_HOST[kind];
  const page = tokenPageUrl(kind, host, workspace.id);
  const ready = account.trim() !== "" && token.trim() !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    set.mutate(
      { id: workspace.id, host, account: account.trim(), token: token.trim() },
      {
        onSuccess: () => {
          setToken("");
          onDone();
        },
      },
    );
  };
  return (
    <form
      aria-label={`Token for ${workspace.name}`}
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-line-strong bg-sunken p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Git host"
          value={kind}
          onChange={(e) => setKind(e.target.value as MrHost)}
          className="w-[150px] flex-none"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {HOST_LABEL[k]}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Account"
          placeholder="Account name"
          className="w-[180px] flex-none font-mono"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        />
        <Input
          aria-label="Token"
          type="password"
          autoComplete="new-password"
          placeholder={kind === "bitbucket" ? "Atlassian email:API token" : "Paste the token"}
          className="min-w-[180px] flex-1"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      {set.error && <Problem>{describeError(set.error)}</Problem>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={!ready || set.isPending}>
          {set.isPending ? "Checking" : "Check and save"}
        </Button>
        {page && (
          <ExternalButton href={page} variant="ghost">
            Make a token on {HOST_LABEL[kind]}
          </ExternalButton>
        )}
        <Button variant="ghost" className="ml-auto" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SignedRow({
  workspace,
  git,
  onSignedOut,
}: {
  workspace: OnboardingWorkspace;
  git: OnboardingWorkspace["git"][number];
  onSignedOut: (result: SignOut) => void;
}) {
  const signOut = useSignOut();
  const label = HOST_LABEL[git.kind];
  return (
    <li className="flex flex-col gap-2">
      <div className="flex min-h-10 items-center gap-3 rounded-lg border border-green-line bg-green-wash pr-1.5 pl-3">
        <HostGlyph host={git.kind} className="size-4" />
        <span className="text-base text-fg">
          Works as <span className="font-mono font-medium">@{git.account ?? label}</span>
        </span>
        <span className="ml-auto text-sm text-green">{git.host}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={signOut.isPending}
          onClick={() =>
            signOut.mutate({ org: workspace.id, kind: git.kind, host: git.host }, { onSuccess: onSignedOut })
          }
        >
          {signOut.isPending ? "Signing out" : "Sign out"}
        </Button>
      </div>
      {signOut.error && <Problem>{describeError(signOut.error)}</Problem>}
    </li>
  );
}

/** What signing out did at the host, with the page to finish it there when majhi could not. */
function SignedOutNotice({ result }: { result: SignOut }) {
  const label = HOST_LABEL[result.kind];
  const who = result.account ? `@${result.account}` : "The account";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-strong bg-field px-3 py-2.5"
    >
      <p className="m-0 min-w-0 flex-1 text-base text-fg-soft text-pretty">
        {result.revoke === "revoked"
          ? `${who} is signed out, and ${label} revoked its token.`
          : result.revoke === "local"
            ? `${who} is signed out here. ${label} still lists majhi until you remove it there.`
            : `${who} is signed out here, but ${label} did not confirm the revoke. Remove majhi there to be sure.`}
      </p>
      {result.revoke !== "revoked" && result.revokeUrl && (
        <ExternalButton href={result.revokeUrl} size="sm">
          Remove majhi on {label}
        </ExternalButton>
      )}
    </div>
  );
}
