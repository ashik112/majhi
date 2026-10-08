import { type GitLogin, type OnboardingWorkspace, PRIVATE } from "@majhi/shared";
import { ChevronDown, CircleAlert, CircleCheck } from "lucide-react";
import * as m from "motion/react-m";
import { useMemo, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { GitSignInPanel } from "@/features/git-signin/panel";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useGitLogins, useSetGitAccount } from "@/lib/studio-queries";
import { hostKind } from "../model";
import { Problem, StepFrame, useStep } from "../step-frame";

const VIA: Record<GitLogin["via"], string> = { gh: "gh login", glab: "glab login", ssh: "SSH key" };

/** Workspaces that need a git sign-in: every one but Private, and Private once it has projects. */
function needsGit(w: OnboardingWorkspace): boolean {
  return w.id !== PRIVATE || w.projects > 0;
}

/**
 * Git accounts, per workspace, one row each. A row opens to the logins found on this computer
 * (Use) and the same sign-in panel as the workspace page: "Sign in with" each host, and a pasted
 * token as the fallback. The first workspace still waiting is open.
 */
export function GitStep() {
  const step = useStep();
  const workspaces = step.status.workspaces;
  const [openPick, setOpen] = useState<string | null>();
  const logins = useGitLogins();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const waiting = workspaces.find(
    (w) => needsGit(w) && (w.missing.length > 0 || !w.git.some((g) => g.signedIn)),
  );
  const stillToSignIn = [...new Set(workspaces.filter(needsGit).flatMap((w) => w.missing))];
  const openId = openPick === undefined ? (waiting?.id ?? null) : openPick;

  return (
    <StepFrame note={stillToSignIn.length > 0 ? `Still to sign in: ${stillToSignIn.join(", ")}` : undefined}>
      <ul aria-label="Workspaces" className="m-0 flex list-none flex-col gap-2 p-0">
        {workspaces.map((w) => (
          <WorkspaceGit
            key={w.id}
            workspace={w}
            names={names}
            open={openId === w.id}
            onToggle={() => setOpen(openId === w.id ? null : w.id)}
            found={logins.data?.hosts ?? []}
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
}: {
  workspace: OnboardingWorkspace;
  names: ReadonlyMap<string, string>;
  open: boolean;
  onToggle: () => void;
  found: readonly { host: string; logins: readonly GitLogin[] }[];
}) {
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
          {first && workspace.missing.length > 0 ? (
            <>
              <HostGlyph host={first.kind} />
              <span className="truncate text-fg-soft">Sign in to {workspace.missing.join(", ")}</span>
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-amber" />
            </>
          ) : first ? (
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
          <GitSignInPanel workspace={workspace} git={workspace.git} names={names}>
            {offers.length > 0 && <FoundLogins workspace={workspace} offers={offers.slice(0, 3)} />}
          </GitSignInPanel>
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
