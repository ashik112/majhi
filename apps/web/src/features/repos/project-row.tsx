import type { ProjectView, Repo } from "@majhi/shared";
import { collapseHome } from "@majhi/shared";
import { Copy, GitBranch, Pencil, Trash2 } from "lucide-react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { HOST_LABEL } from "@/lib/hosts";
import { useCopy } from "@/lib/use-copy";
import { Highlight } from "./highlight";

/** Column template shared by every row and the header above them. */
export const PROJECT_COLUMNS =
  "grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1.7fr)_minmax(0,1.3fr)_112px]";

const CHIP =
  "inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-[5px] bg-[#272a31] px-2 text-xs text-fg-soft";

/** Every remote of a repo as a small chip: host, and the SSH alias it goes through. */
function Remotes({ repo }: { repo: Repo | undefined }) {
  if (!repo || repo.remotes.length === 0) {
    return <span className="text-sm text-fg-faint">{repo ? "No remote" : "Unknown"}</span>;
  }
  return (
    <ul aria-label="Remotes" className="flex flex-wrap gap-1.5">
      {repo.remotes.map((remote) => (
        <li key={remote.name} className={CHIP} title={remote.url}>
          <HostGlyph host={remote.host} className="size-3" />
          {HOST_LABEL[remote.host]}
          {remote.sshAlias && <span className="truncate font-mono text-fg-faint">{remote.sshAlias}</span>}
          {repo.remotes.length > 1 && remote.name !== "origin" && (
            <span className="text-fg-faint">{remote.name}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

const ROW =
  "grid items-center gap-4 rounded-[10px] border border-line-strong bg-raised px-4 py-3 text-base transition-colors duration-150 hover:border-line-hover";

/** A registered project: id, remotes, path, aliases and base, with Edit and Remove. */
export function ProjectRow({
  project,
  repo,
  home,
  terms,
  onEdit,
  onRemove,
}: {
  project: ProjectView;
  repo: Repo | undefined;
  home: string;
  terms: readonly string[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <li data-repo-row="" className={cn(ROW, PROJECT_COLUMNS)}>
      <span className="min-w-0">
        <span className="block truncate font-mono font-medium">
          <Highlight text={project.id} terms={terms} />
        </span>
        {!project.exists && <span className="block text-xs text-red">Repo not found at this path</span>}
      </span>
      <Remotes repo={repo} />
      <span className="truncate font-mono text-sm text-fg-soft" title={project.path}>
        <Highlight text={collapseHome(project.path, home)} terms={terms} />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        {project.aliases.length > 0 ? (
          <span className="truncate font-mono text-xs text-fg-soft" title={project.aliases.join(", ")}>
            {project.aliases.map((a) => `@${a}`).join(" ")}
          </span>
        ) : (
          <span className="text-xs text-fg-faint">No aliases</span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-fg-faint">
          <GitBranch aria-hidden="true" className="size-3" />
          <span className="truncate font-mono">{project.base ?? "default branch"}</span>
        </span>
      </span>
      <span className="flex justify-end gap-0.5">
        <CopyPath name={project.id} path={project.path} home={home} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit project ${project.id}`}
          title="Edit project"
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove project ${project.id}`}
          title="Remove project"
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </span>
    </li>
  );
}

/** A repo found in a root that is not a project yet. */
export function RepoRow({
  repo,
  home,
  terms,
  onRegister,
}: {
  repo: Repo;
  home: string;
  terms: readonly string[];
  onRegister: () => void;
}) {
  return (
    <li data-repo-row="" className={cn(ROW, PROJECT_COLUMNS, "bg-card")}>
      <span className="truncate font-mono font-medium text-fg-soft">
        <Highlight text={repo.name} terms={terms} />
      </span>
      <Remotes repo={repo} />
      <span className="truncate font-mono text-sm text-fg-faint" title={repo.path}>
        <Highlight text={repo.relPath} terms={terms} />
      </span>
      <span className="flex items-center gap-1.5 text-xs text-fg-faint">
        <GitBranch aria-hidden="true" className="size-3" />
        <span className="truncate font-mono">{repo.branch ?? "detached"}</span>
      </span>
      <span className="flex items-center justify-end gap-1.5">
        <CopyPath name={repo.name} path={repo.path} home={home} />
        <Button variant="secondary" size="sm" aria-label={`Register ${repo.name}`} onClick={onRegister}>
          Register
        </Button>
      </span>
    </li>
  );
}

/** Copies the repo's path, with a toast that echoes it. */
function CopyPath({ name, path, home }: { name: string; path: string; home: string }) {
  const copy = useCopy();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Copy path of ${name}`}
      title="Copy path"
      onClick={() => void copy(path, collapseHome(path, home))}
    >
      <Copy aria-hidden="true" />
    </Button>
  );
}
