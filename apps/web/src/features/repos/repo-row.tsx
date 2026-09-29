import type { Repo } from "@majhi/shared";
import { ChevronRight, GitBranch } from "lucide-react";
import { memo } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { HOST_LABEL } from "@/lib/hosts";
import { highlightParts, primaryRemote } from "./filter";

/** Column template shared by rows and their skeletons: cursor, name, path, branch, host, registered. */
export const ROW_GRID = cn(
  "grid items-center gap-x-3 grid-cols-[0.875rem_minmax(0,1fr)_auto]",
  "md:grid-cols-[0.875rem_minmax(0,15rem)_minmax(0,1fr)_minmax(0,10rem)_minmax(0,13rem)_5.25rem]",
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
}

export const RepoRow = memo(function RepoRow({ repo, selected, terms, onSelect, onOpen }: RepoRowProps) {
  const remote = primaryRemote(repo);
  const others = repo.remotes.length - 1;
  return (
    <li className="[contain-intrinsic-size:auto_36px] [content-visibility:auto]">
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
        <span className="hidden justify-end md:flex">
          {repo.registered && <Badge tone="green">registered</Badge>}
        </span>
      </button>
    </li>
  );
});
