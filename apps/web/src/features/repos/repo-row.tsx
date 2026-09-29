import type { ProjectView, Repo } from "@majhi/shared";
import { ChevronRight, GitBranch, Pencil, Trash2 } from "lucide-react";
import { memo } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { HOST_LABEL } from "@/lib/hosts";
import { highlightParts, primaryRemote } from "./filter";

/** Column template shared by rows and their skeletons: cursor, name, path, branch, host, registered. */
export const ROW_GRID = cn(
  "grid items-center gap-x-3 grid-cols-[0.875rem_minmax(0,1fr)_auto]",
  "md:grid-cols-[0.875rem_minmax(0,15rem)_minmax(0,1fr)_minmax(0,10rem)_minmax(0,13rem)_15rem]",
);

/** DOM id of a repo row. Paths may hold spaces, which ids may not. */
export function rowId(path: string): string {
  return `repo-${encodeURIComponent(path)}`;
}

export function Highlight({ text, terms }: { text: string; terms: readonly string[] }) {
  return highlightParts(text, terms).map((part, i) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
    part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
  );
}

interface RepoRowProps {
  repo: Repo;
  selected: boolean;
  terms: readonly string[];
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  /** The project registered at this path, if any. */
  project?: ProjectView | undefined;
  onRegister: (repo: Repo) => void;
  onEdit: (repo: Repo, project: ProjectView) => void;
  onRemove: (project: ProjectView) => void;
}

export const RepoRow = memo(function RepoRow({
  repo,
  selected,
  terms,
  onSelect,
  onOpen,
  project,
  onRegister,
  onEdit,
  onRemove,
}: RepoRowProps) {
  const remote = primaryRemote(repo);
  const others = repo.remotes.length - 1;
  return (
    <li className="relative [contain-intrinsic-size:auto_36px] [content-visibility:auto]">
      <button
        type="button"
        tabIndex={-1}
        id={rowId(repo.path)}
        data-repo-row=""
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(repo.path)}
        onDoubleClick={() => onOpen(repo.path)}
        className={cn(
          ROW_GRID,
          "h-9 w-full scroll-mt-10 scroll-mb-2 px-4 text-left transition-colors duration-75",
          selected ? "bg-selected" : "hover:bg-card",
        )}
      >
        <span aria-hidden="true" className="flex justify-center">
          {selected && <ChevronRight className="size-3.5 text-amber" strokeWidth={2.5} />}
        </span>
        <span className="truncate text-base font-medium text-fg">
          <Highlight text={repo.name} terms={terms} />
        </span>
        <span className="hidden truncate font-mono text-sm text-fg-faint md:block">
          <Highlight text={repo.relPath} terms={terms} />
        </span>
        <span className="hidden min-w-0 items-center gap-1.5 md:flex">
          <GitBranch aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
          {repo.branch ? (
            <span className="truncate font-mono text-sm text-fg-muted">{repo.branch}</span>
          ) : (
            <span className="truncate text-sm text-fg-faint">detached</span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {remote ? (
            <>
              <HostGlyph host={remote.host} />
              <span className="shrink-0 text-sm text-fg-soft">{HOST_LABEL[remote.host]}</span>
              {remote.sshAlias && (
                <span
                  className="truncate font-mono text-xs text-fg-faint"
                  title={`SSH alias ${remote.sshAlias}`}
                >
                  {remote.sshAlias}
                </span>
              )}
              {others > 0 && (
                <span
                  className="shrink-0 font-mono text-xs text-fg-faint"
                  title={repo.remotes.map((r) => r.name).join(", ")}
                >
                  +{others}
                </span>
              )}
            </>
          ) : (
            <span className="text-sm text-fg-faint">No remote</span>
          )}
        </span>
        <span className="hidden md:block" />
      </button>
      <RepoActions
        repo={repo}
        project={project}
        onRegister={onRegister}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    </li>
  );
});

/** Register, or the org and aliases with Edit and Remove. Sits over the last column of the row. */
export function RepoActions({
  repo,
  project,
  onRegister,
  onEdit,
  onRemove,
}: {
  repo: Repo;
  project: ProjectView | undefined;
  onRegister: (repo: Repo) => void;
  onEdit: (repo: Repo, project: ProjectView) => void;
  onRemove: (project: ProjectView) => void;
}) {
  return (
    <div className="absolute top-1/2 right-3 hidden w-[14rem] -translate-y-1/2 items-center justify-end gap-1 md:flex">
      {project ? (
        <>
          <Badge tone="green" mono title={`Org ${project.org}`}>
            {project.org}
          </Badge>
          <span
            className="min-w-0 truncate font-mono text-xs text-fg-faint"
            title={project.aliases.join(", ")}
          >
            {project.aliases.length > 0 ? project.aliases.join(", ") : "no aliases"}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit project ${project.id}`}
            title="Edit project"
            onClick={() => onEdit(repo, project)}
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove project ${project.id}`}
            title="Remove project"
            onClick={() => onRemove(project)}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Register ${repo.name}`}
          onClick={() => onRegister(repo)}
        >
          Register
        </Button>
      )}
    </div>
  );
}
