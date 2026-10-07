import type { OriginView, Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { ChevronRight, FolderGit2 } from "lucide-react";
import { OrgBadge } from "@/components/ui/org-badge";
import { cn } from "@/lib/cn";
import { orgSearch } from "@/lib/org-filter";
import { OriginMark, originName } from "../tasks-ui/origin-mark";
import { type OrgTag, ProjectNames } from "../tasks-ui/project-names";
import { CLIP_ATTR, type CrumbFit } from "./use-crumb-fit";

const SEP = <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-fg-dim" />;

/**
 * Where the task lives and where it came from, on one line: workspace, its projects, then the origin.
 * The workspace opens the board for it. A subtask's origin is its parent, a link.
 */
export function Crumbs({
  task,
  org,
  origin,
  fit,
  filter,
}: {
  task: Pick<Task, "kind" | "repos">;
  org: OrgTag;
  origin: OriginView | undefined;
  fit: CrumbFit;
  /** The workspace filter the board keeps, so the link back lands where the owner was. */
  filter: string | undefined;
}) {
  const projects = task.repos.map((r) => r.project);
  return (
    <>
      <span title={org.name} className="flex min-w-0 shrink-[2] items-center gap-1.5 text-sm text-fg-soft">
        <OrgBadge label={org.letters} color={org.color} size="sm" />
        <span
          {...{ [CLIP_ATTR]: "" }}
          className={cn("min-w-0 truncate", (fit === "short" || fit === "tight") && "hidden")}
        >
          {org.name}
        </span>
      </span>
      {SEP}
      {projects.length > 0 ? (
        <span
          className="flex min-w-0 shrink items-center gap-1 text-sm"
          title={`Project: ${projects.join(", ")}`}
        >
          <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
          <ProjectNames org={undefined} projects={projects} tile={false} />
        </span>
      ) : (
        <span className="shrink-0 text-sm whitespace-nowrap text-fg-faint">
          {task.kind === "chat" ? "chat" : "no project"}
        </span>
      )}
      {origin !== undefined && (
        <>
          {SEP}
          {origin.kind === "parent" ? (
            <Link
              to="/t/$taskId"
              params={{ taskId: origin.task }}
              search={orgSearch(filter)}
              title={`Subtask of ${origin.task}${origin.name === undefined ? "" : `, ${origin.name}`}`}
              className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-xs text-sm text-fg-soft hover:text-fg"
            >
              <OriginMark origin={origin} />
              <span className={cn("font-mono text-xs", fit === "tight" && "hidden")}>{origin.task}</span>
            </Link>
          ) : (
            <span className="flex min-w-0 shrink-0 items-center gap-1.5 text-sm text-fg-soft">
              <OriginMark origin={origin} />
              <span className={cn("truncate", fit === "tight" && "hidden")}>{originName(origin)}</span>
            </span>
          )}
        </>
      )}
    </>
  );
}
