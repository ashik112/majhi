import type { DeployTarget, ProjectView } from "@majhi/shared";
import { Eye, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { useWatches } from "@/lib/watch-queries";
import { kindLabel, viaName } from "./deploy-model";
import { RollbackPair } from "./rollback-pair";

/** One environment, read only. Edit opens the form; Deploy now starts a deploy of the base tip. */
export function TargetBlock({
  project,
  target,
  deploying,
  problem,
  onEdit,
  onRemove,
  onDeploy,
}: {
  project: ProjectView;
  target: DeployTarget;
  deploying: boolean;
  problem: string | undefined;
  onEdit: () => void;
  onRemove: () => void;
  onDeploy: () => void;
}) {
  const { via, verify, rollback } = target;
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-line py-3 first:border-t-0 first:pt-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <b className="min-w-0 truncate text-md font-semibold text-fg" title={target.env}>
          {target.env}
        </b>
        <span className="flex shrink-0 items-center gap-1.5 text-sm text-lamp-done">
          <Lamp state="done" />
          Confirmed
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" disabled={deploying} onClick={onDeploy} aria-label={`Deploy ${target.env} now`}>
            {deploying ? "Deploying" : "Deploy now"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${target.env}`}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${target.env}`}>
            Remove
          </Button>
        </div>
      </div>
      <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-base">
        <Row label="Via">
          <span className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line-control bg-raised px-1.5 text-xs text-fg-soft">
            <GitBranch aria-hidden="true" className="size-3" />
            {kindLabel(via.kind)}
          </span>
          <span className="min-w-0 truncate font-mono text-sm text-fg" title={viaName(via)}>
            {viaName(via)}
          </span>
          {(via.kind === "github-workflow" || via.kind === "gitlab-pipeline") && (
            <span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap">
              <span className="text-xs text-fg-faint">ref</span>
              <span className="font-mono text-sm">
                {via.ref === "base" ? (project.base ?? "base") : via.ref}
              </span>
            </span>
          )}
        </Row>
        <Row label="Verify">
          {verify.health !== undefined && (
            <span className="min-w-0 truncate font-mono text-sm text-fg-soft" title={verify.health}>
              {verify.health}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-fg-faint">
            wait <span className="font-mono text-sm text-fg-soft">{verify.waitSeconds}</span> s
          </span>
        </Row>
        {verify.watch !== undefined && (
          <Row label="">
            <WatchChip id={verify.watch} org={project.org} />
          </Row>
        )}
        <Row label="Rollback">
          <RollbackPair size="sm" label={`Rollback of ${target.env}`} value={rollback.kind} />
        </Row>
      </dl>
      {problem !== undefined && (
        <p role="alert" className="text-sm text-red text-pretty">
          {problem}
        </p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm text-fg-faint">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{children}</dd>
    </>
  );
}

function WatchChip({ id, org }: { id: string; org: string }) {
  const watches = useWatches();
  const found = watches.data?.watches.find((w) => w.id === id && w.org === org);
  const name = found?.def.name ?? id;
  return (
    <span
      className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2 text-sm text-fg-soft"
      title={`Watch ${name}`}
    >
      <Eye aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">Watch {name}</span>
    </span>
  );
}
