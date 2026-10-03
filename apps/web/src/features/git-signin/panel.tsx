import type { MrHost, OnboardingWorkspace, SignOut } from "@majhi/shared";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useSignOut } from "@/lib/onboarding-queries";
import { ExternalButton } from "@/onboarding/bits";
import { SignIn, type SignInWorkspace } from "./sign-in";

const KINDS: readonly MrHost[] = ["github", "gitlab", "bitbucket"];

type SignedHost = OnboardingWorkspace["git"][number];

/**
 * A workspace's git sign-in, the same in the onboarding git step and on the workspace page: the
 * accounts it works as with Sign out, "Sign in with" GitHub, GitLab or Bitbucket, the running
 * sign-in, and a pasted token as the way around the browser.
 */
export function GitSignInPanel({
  workspace,
  git,
  names,
  showSigned = true,
  children,
}: {
  workspace: SignInWorkspace;
  /** The workspace's git hosts, from `onboarding.status`. */
  git: readonly SignedHost[];
  /** Workspace names by id, for the reused-account warning. */
  names: ReadonlyMap<string, string>;
  /** False where the page lists the accounts itself (the workspace page). */
  showSigned?: boolean;
  /** Shown under the signed-in accounts: the logins found on this computer, in the git step. */
  children?: ReactNode;
}) {
  const [active, setActive] = useState<{ kind: MrHost; paste: boolean } | null>(null);
  const [signedOut, setSignedOut] = useState<SignOut>();
  const signed = git.filter((g) => g.signedIn);
  const close = () => setActive(null);

  return (
    <div className="flex flex-col gap-4">
      {showSigned && signed.length > 0 && (
        <ul aria-label={`${workspace.name} git accounts`} className="m-0 flex list-none flex-col gap-1.5 p-0">
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

      {!active && children}

      <div className="flex flex-col gap-2">
        <p className="m-0 text-sm text-fg-muted">{signed.length > 0 ? "Add another host" : "Sign in with"}</p>
        <div className="flex flex-wrap items-center gap-2">
          {KINDS.map((kind) => (
            <Button
              key={kind}
              aria-pressed={active?.kind === kind}
              aria-label={`Sign in with ${HOST_LABEL[kind]}`}
              className="aria-pressed:border-accent-line aria-pressed:bg-accent-wash"
              onClick={() => setActive({ kind, paste: false })}
            >
              <HostGlyph host={kind} />
              {HOST_LABEL[kind]}
            </Button>
          ))}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {active && (
          <SignIn
            key={`${active.kind}-${active.paste ? "paste" : "browser"}`}
            workspace={workspace}
            kind={active.kind}
            paste={active.paste}
            names={names}
            onClose={close}
          />
        )}
      </AnimatePresence>

      {active?.paste !== true && active?.kind !== "bitbucket" && (
        <p className="m-0 text-sm text-fg-faint">
          Have a token already?{" "}
          <button
            type="button"
            onClick={() => setActive({ kind: active?.kind ?? "github", paste: true })}
            className="cursor-pointer text-fg-muted underline decoration-line-control underline-offset-[3px] hover:text-fg"
          >
            Paste a {HOST_LABEL[active?.kind ?? "github"]} token instead
          </button>
        </p>
      )}
    </div>
  );
}

function SignedRow({
  workspace,
  git,
  onSignedOut,
}: {
  workspace: SignInWorkspace;
  git: SignedHost;
  onSignedOut: (result: SignOut) => void;
}) {
  const label = HOST_LABEL[git.kind];
  return (
    <li className="flex flex-col gap-2">
      <div className="flex min-h-10 items-center gap-3 rounded-lg border border-green-line bg-green-wash pr-1.5 pl-3">
        <HostGlyph host={git.kind} className="size-4" />
        <span className="text-base text-fg">
          Works as <span className="font-mono font-medium">@{git.account ?? label}</span>
        </span>
        <span className="ml-auto text-sm text-green">{git.host}</span>
        <SignOutButton org={workspace.id} kind={git.kind} host={git.host} onSignedOut={onSignedOut} />
      </div>
    </li>
  );
}

/** Removes the workspace's token for one host, revoking it at the host where it can. */
export function SignOutButton({
  org,
  kind,
  host,
  onSignedOut,
}: {
  org: string;
  kind: MrHost;
  host: string;
  onSignedOut: (result: SignOut) => void;
}) {
  const signOut = useSignOut();
  return (
    <span className="flex flex-col items-end">
      <Button
        size="sm"
        variant="ghost"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate({ org, kind, host }, { onSuccess: onSignedOut })}
      >
        {signOut.isPending ? "Signing out" : "Sign out"}
      </Button>
      {signOut.error && (
        <span role="alert" className="max-w-[40ch] text-right text-sm text-red">
          {describeError(signOut.error)}
        </span>
      )}
    </span>
  );
}

/** What signing out did at the host, with the page to finish it there when majhi could not. */
export function SignedOutNotice({ result }: { result: SignOut }) {
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
            ? `${who} is signed out here. The token still works on ${label} until you remove it there.`
            : `${who} is signed out here, but ${label} did not confirm the revoke. Remove it there to be sure.`}
      </p>
      {result.revoke !== "revoked" && result.revokeUrl && (
        <ExternalButton href={result.revokeUrl} size="sm">
          Remove it on {label}
        </ExternalButton>
      )}
    </div>
  );
}
