import type { ProjectView } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status-dot";
import { useDeployView } from "@/lib/deploy-queries";
import { DEPLOY_PAGE_ID, lastReached, reachedLook, runHost, runsLine } from "./deploy-model";
import { TierChip } from "./tier-chip";

/** Where the project is deployed, read only: one row per environment and what reached it last. */
export function DeploySection({ project }: { project: ProjectView }) {
  const view = useDeployView(project.id);

  if (view.isPending) {
    return (
      <DetailSection title="Deploys" className="pb-3">
        <RowsSkeleton rows={2} height={36} />
      </DetailSection>
    );
  }
  if (view.isError) {
    return (
      <DetailSection title="Deploys" className="pb-3">
        <p role="alert" className="text-sm text-red text-pretty">
          {view.error.message}
        </p>
      </DetailSection>
    );
  }
  const { environments, history } = view.data;
  if (environments.length === 0) {
    return (
      <DetailSection title="Deploys" className="pb-3">
        <p className="text-sm text-fg-faint">None found.</p>
      </DetailSection>
    );
  }
  const now = Date.now();
  return (
    <DetailSection
      title="Deploys"
      className="pb-3"
      actions={
        <Button asChild size="sm">
          <Link to="/wiki" search={{ org: project.org, project: project.id, id: DEPLOY_PAGE_ID }}>
            Deploy page
          </Link>
        </Button>
      }
    >
      <ul aria-label={`Environments of ${project.id}`} className="flex flex-col">
        {environments.map((environment) => {
          const reached = lastReached(history, environment.env);
          const first = reached?.runs[0];
          const look = reached === undefined ? undefined : reachedLook(reached, now);
          return (
            <li
              key={environment.env}
              className="grid min-h-9 grid-cols-[136px_92px_minmax(0,1fr)_auto] items-center gap-3 border-t border-line py-1.5 text-sm first:border-t-0"
            >
              <span className="truncate font-mono text-fg" title={environment.env}>
                {environment.env}
              </span>
              <span>
                <TierChip tier={environment.tier} />
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-fg-soft">
                {first !== undefined && reached !== undefined && (
                  <>
                    <HostGlyph host={runHost(first)} className="size-3.5" />
                    <span className="min-w-0 truncate font-mono text-xs" title={runsLine(reached.runs)}>
                      {runsLine(reached.runs)}
                    </span>
                  </>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-fg-faint">
                {look !== undefined && (
                  <>
                    <Dot tone={look.tone} size={6} />
                    {look.text}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </DetailSection>
  );
}
