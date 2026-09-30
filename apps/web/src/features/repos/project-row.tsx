import type { GitHost, ProjectView, Repo } from "@majhi/shared";
import { collapseHome } from "@majhi/shared";
import { Copy, GitBranch, Plus } from "lucide-react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { Dot } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";
import { HOST_LABEL } from "@/lib/hosts";
import { useCopy } from "@/lib/use-copy";
import { Highlight } from "./highlight";

/** The hosts of a repo's remotes, once each, as small marks. */
function HostMarks({ repo }: { repo: Repo | undefined }) {
  const hosts = [...new Set((repo?.remotes ?? []).map((r) => r.host))] as GitHost[];
  if (hosts.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" title={hosts.map((h) => HOST_LABEL[h]).join(", ")}>
      {hosts.map((host) => (
        <HostGlyph key={host} host={host} className="size-3" />
      ))}
      <span className="sr-only">{hosts.map((h) => HOST_LABEL[h]).join(", ")}</span>
    </span>
  );
}

/**
 * A registered project in the list: its id with the hosts of its remotes, then whether it is on disk
 * and its path. The id is the button; it covers the whole row.
 */
export function ProjectListRow({
  project,
  repo,
  home,
  terms,
  selected,
  onSelect,
}: {
  project: ProjectView;
  repo: Repo | undefined;
  home: string;
  terms: readonly string[];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      data-repo-row=""
      className={cn(
        ROW,
        "min-h-[46px] flex-col justify-center gap-0.5 px-2.5 py-1.5 focus-within:bg-raised",
        selected && ROW_SELECTED,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
          className={cn(
            "min-w-0 cursor-pointer truncate text-left font-mono text-sm after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent",
            selected ? "text-fg" : "text-fg-soft",
          )}
        >
          <Highlight text={project.id} terms={terms} />
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {!project.exists && <span className="text-xs text-red">Missing</span>}
          <HostMarks repo={repo} />
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <Dot tone={project.exists ? "green" : "red"} size={6} />
        <span className="sr-only">{project.exists ? "On disk, " : "Missing on disk, "}</span>
        <span className="min-w-0 truncate font-mono text-fg-faint" title={project.path}>
          <Highlight text={collapseHome(project.path, home)} terms={terms} />
        </span>
      </span>
    </li>
  );
}

/** Every remote of a repo as a small chip: host, and the SSH alias it goes through. */
function Remotes({ repo }: { repo: Repo }) {
  if (repo.remotes.length === 0) return <span className="text-sm text-fg-faint">No remote</span>;
  return (
    <ul aria-label="Remotes" className="flex min-w-0 flex-wrap gap-1.5">
      {repo.remotes.map((remote) => (
        <li
          key={remote.name}
          className="inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-[5px] bg-raised px-2 text-xs text-fg-soft"
          title={remote.url}
        >
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

/** A repo found in a workspace root that is not a project yet: name, remotes, path, branch, Register. */
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
    <li
      data-repo-row=""
      className="group grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-line py-2 first:border-t-0 @[760px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-sm text-fg">
          <Highlight text={repo.name} terms={terms} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-faint @[760px]:hidden">
          <span className="truncate font-mono">{repo.relPath}</span>
        </span>
      </span>
      <span className="hidden min-w-0 @[760px]:block">
        <Remotes repo={repo} />
      </span>
      <span className="hidden min-w-0 flex-col @[760px]:flex">
        <span className="truncate font-mono text-xs text-fg-muted" title={repo.path}>
          <Highlight text={repo.relPath} terms={terms} />
        </span>
        <span className="flex items-center gap-1 text-xs text-fg-faint">
          <GitBranch aria-hidden="true" className="size-3" />
          <span className="truncate font-mono">{repo.branch ?? "detached"}</span>
        </span>
      </span>
      <span className="flex items-center justify-end gap-1">
        <CopyPath
          name={repo.name}
          path={repo.path}
          home={home}
          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        />
        <Button variant="ghost" size="sm" aria-label={`Register ${repo.name}`} onClick={onRegister}>
          <Plus aria-hidden="true" />
          Register
        </Button>
      </span>
    </li>
  );
}

/** Copies the repo's path, with a toast that echoes it. */
export function CopyPath({
  name,
  path,
  home,
  className,
}: {
  name: string;
  path: string;
  home: string;
  className?: string;
}) {
  const copy = useCopy();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Copy path of ${name}`}
      title="Copy path"
      className={className}
      onClick={() => void copy(path, collapseHome(path, home))}
    >
      <Copy aria-hidden="true" />
    </Button>
  );
}
