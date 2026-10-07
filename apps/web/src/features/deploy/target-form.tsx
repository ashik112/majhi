import type { DeployKind, ProjectView } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { Select, Textarea } from "@/components/ui/select";
import { useConnections } from "@/lib/connection-queries";
import { useSetDeploy } from "@/lib/deploy-queries";
import { useWatches } from "@/lib/watch-queries";
import {
  buildTarget,
  connectionsFor,
  KINDS,
  kindLabel,
  redeployProblem,
  type TargetDraft,
} from "./deploy-model";
import { RollbackPair } from "./rollback-pair";

const KIND_SEGMENTS = KINDS.map((k) => ({ value: k, label: kindLabel(k) }));
const TARGET_SEGMENTS = [
  { value: "preview", label: "Preview" },
  { value: "production", label: "Production" },
] as const;

/** Adds or edits one target in a dialog. Save keeps it open and shows the server's refusal. */
export function TargetForm({
  project,
  initial,
  editing,
  onClose,
}: {
  project: ProjectView;
  initial: TargetDraft;
  /** The environment being edited; absent for a new target. */
  editing: string | undefined;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState(false);
  const save = useSetDeploy();
  const connections = useConnections();
  const watches = useWatches();
  const set = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const all = connections.data ?? [];
  const viaChoices = connectionsFor(draft.kind, all, project.org);
  const sshChoices = connectionsFor("ssh", all, project.org);
  const watchChoices = (watches.data?.watches ?? []).filter((w) => w.org === project.org);
  const built = buildTarget(draft);
  const blocked = redeployProblem(draft.kind);
  const problem = save.error?.message ?? (shown && !built.ok ? built.problem : undefined);

  const changeKind = (kind: DeployKind) =>
    setDraft((d) => ({
      ...d,
      kind,
      connection: "",
      rollbackKind: redeployProblem(kind) === undefined ? d.rollbackKind : "ssh",
    }));

  const submit = () => {
    setShown(true);
    if (!built.ok) return;
    save.mutate({ project: project.id, target: built.target }, { onSuccess: onClose });
  };

  return (
    <Modal
      label={editing === undefined ? "Add deploy target" : `Edit ${editing}`}
      onClose={onClose}
      className="flex w-[520px] flex-col open:flex"
    >
      <form
        className="flex max-h-[calc(100dvh-32px)] min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="shrink-0 border-b border-line-strong px-5 py-3.5">
          <h2 className="text-md font-semibold">
            {editing === undefined ? "Add target" : `Edit ${editing}`}
          </h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4 scroll-fade">
          <Field label="Environment">
            {(props) => (
              <Input
                {...props}
                value={draft.env}
                disabled={editing !== undefined}
                placeholder="staging"
                onChange={(e) => set("env", e.target.value)}
              />
            )}
          </Field>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm text-fg-faint">Via</span>
            <Segmented
              label="Via"
              value={draft.kind}
              segments={KIND_SEGMENTS}
              onChange={changeKind}
              className="flex-wrap"
            />
          </div>
          <ConnectionPicker
            label="Connection"
            value={draft.connection}
            choices={viaChoices.map((c) => ({ id: c.id, name: c.name }))}
            onChange={(v) => set("connection", v)}
          />
          <ViaFields draft={draft} base={project.base} set={set} />
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-1 p-0 text-sm font-semibold text-fg">Verify</legend>
            <Field label="Health URL">
              {(props) => (
                <Input
                  {...props}
                  className="font-mono"
                  value={draft.health}
                  placeholder="https://staging.acme.example/health"
                  onChange={(e) => set("health", e.target.value)}
                />
              )}
            </Field>
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3">
              <Field label="Wait (s)">
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={0}
                    max={1800}
                    value={draft.wait}
                    onChange={(e) => set("wait", e.target.value)}
                  />
                )}
              </Field>
              <Field label="Watch">
                {(props) => (
                  <Select {...props} value={draft.watch} onChange={(e) => set("watch", e.target.value)}>
                    <option value="">None</option>
                    {watchChoices.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.def.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </fieldset>
          <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-1 p-0 text-sm font-semibold text-fg">Rollback</legend>
            <div className="flex">
              <RollbackPair
                label="Rollback"
                value={draft.rollbackKind}
                blocked={blocked}
                onChange={(v) => set("rollbackKind", v)}
              />
            </div>
            {draft.rollbackKind === "ssh" && (
              <>
                <ConnectionPicker
                  label="SSH connection"
                  value={draft.rollbackConnection}
                  choices={sshChoices.map((c) => ({ id: c.id, name: c.name }))}
                  onChange={(v) => set("rollbackConnection", v)}
                />
                <Field label="Command">
                  {(props) => (
                    <Textarea
                      {...props}
                      rows={3}
                      value={draft.rollbackCommand}
                      onChange={(e) => set("rollbackCommand", e.target.value)}
                    />
                  )}
                </Field>
              </>
            )}
          </fieldset>
          {problem !== undefined && (
            <p
              role="alert"
              className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red text-pretty"
            >
              {problem}
            </p>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line-strong px-5 py-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? "Saving" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ViaFields({
  draft,
  base,
  set,
}: {
  draft: TargetDraft;
  base: string | undefined;
  set: <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => void;
}) {
  const refField = (
    <Field label="Ref">
      {(props) => (
        <Input
          {...props}
          className="font-mono"
          value={draft.ref}
          placeholder={base === undefined ? "base" : `base (${base})`}
          onChange={(e) => set("ref", e.target.value)}
        />
      )}
    </Field>
  );
  switch (draft.kind) {
    case "github-workflow":
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Workflow file">
            {(props) => (
              <Input
                {...props}
                className="font-mono"
                value={draft.workflow}
                placeholder="deploy.yml"
                onChange={(e) => set("workflow", e.target.value)}
              />
            )}
          </Field>
          {refField}
        </div>
      );
    case "gitlab-pipeline":
      return refField;
    case "vercel":
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vercel project">
            {(props) => (
              <Input
                {...props}
                className="font-mono"
                value={draft.vercelProject}
                onChange={(e) => set("vercelProject", e.target.value)}
              />
            )}
          </Field>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm text-fg-faint">Target</span>
            <Segmented
              label="Vercel target"
              value={draft.vercelTarget}
              segments={TARGET_SEGMENTS}
              onChange={(v) => set("vercelTarget", v)}
            />
          </div>
        </div>
      );
    case "ssh":
      return (
        <Field label="Command">
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              value={draft.command}
              onChange={(e) => set("command", e.target.value)}
            />
          )}
        </Field>
      );
  }
}

function ConnectionPicker({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: { id: string; name: string }[];
  onChange: (id: string) => void;
}) {
  // A saved target may name a connection that is gone: keep it visible so the owner can swap it.
  const known = value === "" || choices.some((c) => c.id === value);
  return (
    <Field label={label}>
      {(props) =>
        choices.length === 0 ? (
          <p {...props} className="m-0 text-base text-fg-faint">
            No such connection in this workspace
          </p>
        ) : (
          <Select {...props} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose</option>
            {!known && <option value={value}>{value}</option>}
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name === "" || c.name === c.id ? c.id : `${c.name} (${c.id})`}
              </option>
            ))}
          </Select>
        )
      }
    </Field>
  );
}
