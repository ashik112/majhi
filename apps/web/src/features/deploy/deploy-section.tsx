import type { DeploySuggestion, ProjectView } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DetailSection } from "@/components/ui/list-detail";
import { RowsSkeleton } from "@/components/ui/skeleton";
import {
  useDeploy,
  useDeployView,
  useHideDeploySuggestion,
  useRemoveDeploy,
  useSetDeploy,
} from "@/lib/deploy-queries";
import {
  defaultEnv,
  draftFromSuggestion,
  draftFromTarget,
  emptyDraft,
  type TargetDraft,
} from "./deploy-model";
import { History } from "./history";
import { Suggestions } from "./suggestions";
import { TargetBlock } from "./target-block";
import { TargetForm } from "./target-form";

interface FormState {
  initial: TargetDraft;
  editing: string | undefined;
}

/** Where the project is deployed: its targets in the order they go live, what majhi found, and the deploys so far. */
export function DeploySection({ project }: { project: ProjectView }) {
  const view = useDeployView(project.id);
  const set = useSetDeploy();
  const hide = useHideDeploySuggestion();
  const remove = useRemoveDeploy();
  const deploy = useDeploy();
  const [form, setForm] = useState<FormState | undefined>();
  const [removing, setRemoving] = useState<string | undefined>();
  // The env a Deploy now was pressed for, so a refusal sits under that block.
  const [deployed, setDeployed] = useState<{ env: string; message: string } | undefined>();

  const rule = view.data?.rule;
  const note =
    rule === undefined ? undefined : (
      <span className="text-xs text-fg-faint">
        Ship rule <span className="text-fg-soft">{rule}</span>
      </span>
    );

  if (view.isPending) {
    return (
      <DetailSection title="Deploy targets">
        <RowsSkeleton rows={2} height={72} />
      </DetailSection>
    );
  }
  if (view.isError) {
    return (
      <DetailSection title="Deploy targets">
        <p role="alert" className="text-sm text-red text-pretty">
          {view.error.message}
        </p>
      </DetailSection>
    );
  }
  const { targets, suggestions, history } = view.data;

  const addSuggestion = (s: DeploySuggestion) => {
    if (s.target === undefined) return;
    set.mutate({ project: project.id, target: s.target });
  };

  return (
    <>
      <DetailSection title="Deploy targets" note={note} className="pb-3">
        <div className="flex min-w-0 flex-col">
          {targets.map((t) => (
            <TargetBlock
              key={t.env}
              project={project}
              target={t}
              deploying={deploy.isPending && deploy.variables?.env === t.env}
              problem={deployed?.env === t.env ? deployed.message : undefined}
              onEdit={() => setForm({ initial: draftFromTarget(t), editing: t.env })}
              onRemove={() => {
                remove.reset();
                setRemoving(t.env);
              }}
              onDeploy={() => {
                setDeployed(undefined);
                deploy.mutate(
                  { project: project.id, env: t.env },
                  { onError: (e) => setDeployed({ env: t.env, message: e.message }) },
                );
              }}
            />
          ))}
        </div>
        <div>
          <Button
            size="sm"
            onClick={() => setForm({ initial: emptyDraft(defaultEnv(targets)), editing: undefined })}
          >
            Add target
          </Button>
        </div>
      </DetailSection>
      <Suggestions
        items={suggestions}
        busy={set.isPending || hide.isPending}
        error={set.error?.message ?? hide.error?.message}
        onAdd={addSuggestion}
        onSetUp={(s) => setForm({ initial: draftFromSuggestion(s), editing: undefined })}
        onHide={(s) => hide.mutate({ project: project.id, suggestion: s.id })}
      />
      <History history={history} />
      {form !== undefined && (
        <TargetForm
          project={project}
          initial={form.initial}
          editing={form.editing}
          onClose={() => {
            set.reset();
            setForm(undefined);
          }}
        />
      )}
      {removing !== undefined && (
        <ConfirmDialog
          title={`Remove ${removing}`}
          body="The target goes from this project. Deploys already made stay in the history."
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error?.message}
          onCancel={() => setRemoving(undefined)}
          onConfirm={() =>
            remove.mutate({ project: project.id, env: removing }, { onSuccess: () => setRemoving(undefined) })
          }
        />
      )}
    </>
  );
}
