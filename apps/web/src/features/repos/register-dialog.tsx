import type { ProjectView, Repo } from "@majhi/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { ApiRequestError } from "@/lib/api";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects, useRegisterProject, useUpdateProject } from "@/lib/task-queries";
import { aliasClashes, projectIdError, suggestProjectId } from "./project-model";

/** Registers a repo as a project, or edits a registered one (`project` set). */
export function RegisterDialog({
  repo,
  project,
  onClose,
}: {
  repo: Repo;
  project?: ProjectView | undefined;
  onClose: () => void;
}) {
  const orgs = useOrgs();
  const projects = useProjects();
  const register = useRegisterProject();
  const update = useUpdateProject();
  const toast = useToast();
  const editing = project !== undefined;
  const others = projects.data ?? [];
  const taken = useMemo(() => others.filter((p) => p.id !== project?.id).map((p) => p.id), [others, project]);

  const [org, setOrg] = useState(project?.org ?? "");
  const [id, setId] = useState(() => project?.id ?? suggestProjectId(repo.name, taken));
  const [aliases, setAliases] = useState<string[]>(() => project?.aliases ?? []);
  const [base, setBase] = useState(project?.base ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  const orgList = orgs.data ?? [];
  const chosenOrg = org || (orgList.length === 1 ? (orgList[0]?.id ?? "") : "");
  const idProblem = editing ? undefined : projectIdError(id, taken);
  const clashes = aliasClashes(aliases, others, id);
  const orgProblem = chosenOrg === "" ? "Pick the org this repo belongs to" : undefined;
  const aliasProblem =
    clashes.length > 0
      ? `${clashes.map((c) => `${c.alias} (${c.project})`).join(", ")} already in use`
      : undefined;
  const busy = register.isPending || update.isPending;

  function submit() {
    setSubmitted(true);
    setFailure(undefined);
    if (idProblem || orgProblem || aliasProblem) return;
    const trimmedBase = base.trim();
    const done = () => {
      toast(editing ? "Project updated" : "Project registered", { detail: id });
      onClose();
    };
    const fail = (error: ApiRequestError) => setFailure([error.message, ...error.details].join(". "));
    if (editing) {
      update.mutate(
        { id, org: chosenOrg, aliases, ...(trimmedBase ? { base: trimmedBase } : {}) },
        { onSuccess: done, onError: fail },
      );
    } else {
      register.mutate(
        { id, org: chosenOrg, path: repo.path, aliases, ...(trimmedBase ? { base: trimmedBase } : {}) },
        { onSuccess: done, onError: fail },
      );
    }
  }

  return (
    <Modal
      label={editing ? `Edit project ${project.id}` : `Register ${repo.name}`}
      onClose={onClose}
      className="w-[480px]"
    >
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-md font-semibold">
            {editing ? `Edit ${project.id}` : `Register ${repo.name}`}
          </h2>
          <p className="truncate font-mono text-sm text-fg-faint" title={repo.path}>
            {repo.path}
          </p>
        </div>

        <Field label="Org" error={submitted ? orgProblem : undefined}>
          {(props) => (
            <Select {...props} value={chosenOrg} onChange={(event) => setOrg(event.target.value)}>
              <option value="">Choose an org</option>
              {orgList.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {orgs.isSuccess && orgList.length === 0 && (
          <p className="-mt-2 text-sm text-amber">No orgs yet. Add one in Studio, under Accounts.</p>
        )}

        <Field
          label="Project id"
          hint="Names the repo in the task box and in branch names."
          error={submitted ? idProblem : undefined}
        >
          {(props) => (
            <Input
              {...props}
              value={id}
              disabled={editing}
              onChange={(event) => setId(event.target.value.trim())}
              className="font-mono"
            />
          )}
        </Field>

        <Field
          label="Aliases"
          hint="Other words for it in the task box, like backend or api. Enter adds one."
          error={submitted ? aliasProblem : undefined}
        >
          {(props) => (
            <ChipsInput
              {...props}
              label="Aliases"
              value={aliases}
              onChange={setAliases}
              placeholder="backend"
            />
          )}
        </Field>

        <Field label="Base branch (optional)" hint="Default: the org's base, then the repo's default branch.">
          {(props) => (
            <Input
              {...props}
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="develop"
              className="font-mono"
            />
          )}
        </Field>

        {failure && (
          <p
            role="alert"
            className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red text-pretty"
          >
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {editing ? "Save" : "Register"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
