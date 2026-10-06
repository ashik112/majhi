import type { WikiStatus } from "@majhi/shared";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { plural } from "@/lib/format";
import type { WikiWorkspace } from "./use-wiki-switch";

interface Props {
  workspaces: readonly WikiWorkspace[];
  org: string;
  onOrg: (org: string) => void;
  projects: readonly string[];
  project: string | undefined;
  onProject: (project: string) => void;
  status: WikiStatus | undefined;
  onUpdate: (() => void) | undefined;
}

/** The top bar: the workspace and project pickers, what the pages were built from, and Update. */
export function WikiHeader({
  workspaces,
  org,
  onOrg,
  projects,
  project,
  onProject,
  status,
  onUpdate,
}: Props) {
  return (
    <PageHeader
      title="Wiki"
      subtitle={
        <span className="flex items-center gap-2">
          <Select
            aria-label="Workspace"
            className="h-8 w-[150px] min-[1320px]:w-[190px]"
            value={org}
            onChange={(e) => onOrg(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.org.id} value={w.org.id}>
                {w.org.name}
              </option>
            ))}
          </Select>
          {projects.length > 0 && (
            <Select
              aria-label="Project"
              className="h-8 w-[150px] min-[1320px]:w-[230px]"
              value={project ?? ""}
              onChange={(e) => onProject(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          )}
        </span>
      }
    >
      {onUpdate !== undefined && (
        <>
          <StatusLine status={status} />
          <Button variant="primary" onClick={onUpdate} disabled={status?.running === true}>
            <RefreshCw aria-hidden="true" className={status?.running ? "animate-spin" : undefined} />
            Update
          </Button>
        </>
      )}
    </PageHeader>
  );
}

const PHASE_WORDS = {
  facts: "reading the code",
  plan: "planning",
  write: "writing pages",
  check: "checking sources",
  store: "saving",
} as const;

/** What the pages were built from and how far the code has moved since, or what the update is doing now. */
function StatusLine({ status }: { status: WikiStatus | undefined }) {
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
  return (
    <span className="flex min-w-0 items-center gap-3 text-sm text-fg-muted" role="status">
      {status.lastError !== undefined && (
        <span className="flex items-center gap-1.5 text-red" title={status.lastError}>
          <span aria-hidden="true" className="size-1.5 rounded-full bg-red" />
          Last update failed
        </span>
      )}
      {status.builtCommit === undefined ? (
        <span>Not built yet</span>
      ) : (
        <span className="whitespace-nowrap">
          Built from <b className="font-mono font-medium text-fg">{status.builtCommit.slice(0, 7)}</b>
        </span>
      )}
      {status.builtCommit !== undefined && status.behind !== undefined && (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden="true"
            className={
              status.behind > 0 ? "size-1.5 rounded-full bg-amber" : "size-1.5 rounded-full bg-green"
            }
          />
          {status.behind > 0 ? `${plural(status.behind, "commit")} behind` : "Up to date"}
        </span>
      )}
      {status.oldRules && <span className="whitespace-nowrap text-amber">Older rules</span>}
    </span>
  );
}
