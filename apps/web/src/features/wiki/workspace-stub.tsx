import type { WikiStatus } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { plural } from "@/lib/format";
import { COPY } from "./copy";
import { projectState } from "./wiki-header";

/** How many projects of the workspace have pages, which the workspace's own pages need two of. */
export const WORKSPACE_NEEDS = 2;

/** The one line under the stub's row in the list: how many projects are built. */
export function stubSub(statuses: readonly WikiStatus[]): string {
  const built = statuses.filter((s) => s.builtCommit !== undefined).length;
  return `${built} of ${plural(statuses.length, "project")} built`;
}

/**
 * The workspace's Overview before it can be written: how the projects connect needs pages for at least two of
 * them. It lists each project with its state and a button for the ones not built.
 */
export function WorkspaceStub({
  statuses,
  onBuild,
}: {
  statuses: readonly WikiStatus[];
  onBuild: (project: string) => void;
}) {
  const built = statuses.filter((s) => s.builtCommit !== undefined).length;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3 py-3.5">
        <h2 className="text-md font-semibold">{COPY.group.overview}</h2>
      </div>
      <DetailSection title="Projects" note={stubSub(statuses)} className="border-t-0">
        <p className="m-0 mb-3 max-w-[68ch] text-base text-fg-muted text-pretty">
          {built >= WORKSPACE_NEEDS
            ? "The overview of how the projects connect is written when you update the workspace."
            : `How the projects connect is written once ${WORKSPACE_NEEDS} of them have pages. Build the rest first.`}
        </p>
        <ul aria-label="Projects of the workspace" className="m-0 flex list-none flex-col p-0">
          {statuses.map((s) => (
            <li
              key={s.project}
              className="flex min-h-10 items-center gap-3 border-t border-line text-sm first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-fg">{s.project}</span>
              <span className="text-fg-muted">{projectState(s)}</span>
              {s.builtCommit === undefined && (
                <Button size="sm" disabled={s.running} onClick={() => onBuild(s.project)}>
                  Build
                </Button>
              )}
            </li>
          ))}
        </ul>
      </DetailSection>
    </>
  );
}
