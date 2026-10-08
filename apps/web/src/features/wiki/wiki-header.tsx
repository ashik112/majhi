import type { WikiStatus } from "@majhi/shared";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageHeader } from "@/components/ui/page-header";
import { Pick, type PickOption } from "@/components/ui/pick";
import { badgeLetters, plural } from "@/lib/format";
import { SignInButton } from "./sign-in-button";
import { COPY } from "./copy";
import type { WikiWorkspace } from "./use-wiki-switch";

/** What the project picker says about one project's wiki: not built, built, or how many commits behind. */
export function projectState(status: WikiStatus | undefined): string {
  if (status?.builtCommit === undefined) return COPY.workspace.notBuilt;
  return status.behind !== undefined && status.behind > 0
    ? COPY.workspace.behind(status.behind)
    : COPY.workspace.built;
}

/** The value of the project picker that means the workspace's own wiki. */
export const WHOLE = "*";

interface Props {
  workspaces: readonly WikiWorkspace[];
  org: string;
  onOrg: (org: string) => void;
  projects: readonly { id: string; status: WikiStatus | undefined }[];
  /** A project, or `WHOLE` for the workspace's own pages. */
  scope: string | undefined;
  onScope: (scope: string) => void;
  status: WikiStatus | undefined;
  /** The commit each project's pages were built from, shown for the whole workspace. */
  commits: readonly { project: string; commit: string }[] | undefined;
  onUpdate: (() => void) | undefined;
}

/** The top bar: the workspace and project pickers, what the pages were built from, and Update. */
export function WikiHeader({
  workspaces,
  org,
  onOrg,
  projects,
  scope,
  onScope,
  status,
  commits,
  onUpdate,
}: Props) {
  const orgOptions: PickOption[] = workspaces.map((w) => ({
    value: w.org.id,
    label: w.org.name,
    lead: <OrgBadge label={badgeLetters(w.org.key)} color={w.org.color} size="md" />,
  }));
  const projectOptions: PickOption[] = [
    { value: WHOLE, label: COPY.workspace.option, detail: COPY.workspace.repoCount(projects.length) },
    ...projects.map((p) => ({
      value: p.id,
      label: p.id,
      detail: projectState(p.status),
      group: COPY.workspace.projects,
    })),
  ];
  return (
    <PageHeader
      title="Wiki"
      subtitle={
        <span className="flex items-center gap-2">
          <Pick
            label={COPY.picker.workspace}
            value={org}
            options={orgOptions}
            onChange={onOrg}
            className="w-[150px] min-[1320px]:w-[190px]"
          />
          {projects.length > 0 && (
            <Pick
              label={COPY.picker.project}
              value={scope}
              options={projectOptions}
              onChange={onScope}
              className="w-[150px] min-[1320px]:w-[230px]"
              menuWidth={260}
            />
          )}
        </span>
      }
    >
      <StatusLine status={status} commits={commits} />
      {onUpdate !== undefined && (
        <>
          <Button
            variant={needsUpdate(status) ? "primary" : "secondary"}
            onClick={onUpdate}
            disabled={status?.running === true}
          >
            <RefreshCw aria-hidden="true" className={status?.running ? "animate-spin" : undefined} />
            Update
          </Button>
        </>
      )}
    </PageHeader>
  );
}

export const PHASE_WORDS = {
  facts: "reading the code",
  plan: "planning",
  write: "writing pages",
  check: "checking sources",
  store: "saving",
} as const;

/** Whether an update has something to do: the code moved, the rules are older, or the last update did not finish. */
function needsUpdate(status: WikiStatus | undefined): boolean {
  if (status === undefined) return false;
  return (
    (status.behind ?? 0) > 0 ||
    status.oldRules ||
    status.lastError !== undefined ||
    status.failed.length > 0 ||
    status.flowsNotChosen
  );
}

/** What the pages were built from and how far the code has moved since, or what the update is doing now. */
function StatusLine({
  status,
  commits,
}: {
  status: WikiStatus | undefined;
  commits: readonly { project: string; commit: string }[] | undefined;
}) {
  if (status === undefined) return null;
  if (status.running) {
    return (
      <span className="flex items-center gap-2 text-sm text-fg-muted" role="status">
        <Lamp state="working" />
        Updating: {PHASE_WORDS[status.phase]}
        {status.total > 0 && ` ${status.done} of ${status.total}`}
      </span>
    );
  }
  // A page the last update did not write is not "up to date", whatever the commits say.
  const notWritten = status.failed.length + (status.flowsNotChosen ? 1 : 0);
  return (
    <span className="flex min-w-0 items-center gap-3 text-sm text-fg-muted" role="status">
      {status.lastError !== undefined && (
        <span className="flex items-center gap-1.5 text-red" title={status.lastError}>
          <span aria-hidden="true" className="size-1.5 rounded-full bg-red" />
          {status.signedOut === undefined ? COPY.failed.updateFailed : COPY.failed.signedOut(status.signedOut)}
          {status.signedOut !== undefined && <SignInButton account={status.signedOut} />}
        </span>
      )}
      {status.builtCommit === undefined ? (
        <span>Not built yet</span>
      ) : (
        <span
          className="min-w-0 truncate"
          title={commits?.map((c) => `${c.project} ${c.commit.slice(0, 7)}`).join(", ")}
        >
          Built from{" "}
          {commits !== undefined && commits.length > 1 ? (
            commits.map((c, i) => (
              <span key={c.project}>
                {i > 0 && ", "}
                {c.project} <b className="font-mono font-medium text-fg">{c.commit.slice(0, 7)}</b>
              </span>
            ))
          ) : (
            <b className="font-mono font-medium text-fg">{status.builtCommit.slice(0, 7)}</b>
          )}
        </span>
      )}
      {status.builtCommit !== undefined && status.behind !== undefined && status.lastError === undefined && (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden="true"
            className={
              status.behind > 0 || notWritten > 0
                ? "size-1.5 rounded-full bg-amber"
                : "size-1.5 rounded-full bg-green"
            }
          />
          {status.behind > 0
            ? `${plural(status.behind, "commit")} behind`
            : notWritten > 0
              ? `${plural(notWritten, "page")} not written`
              : "Up to date"}
        </span>
      )}
      {status.oldRules && <span className="whitespace-nowrap text-amber">Older rules</span>}
    </span>
  );
}
