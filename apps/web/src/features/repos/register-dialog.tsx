import { type MrHost, MrHostSchema, type ProjectView, type Repo } from "@majhi/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { defaultOrgId } from "@/features/accounts/model";
import type { ApiRequestError } from "@/lib/api";
import { HOST_LABEL } from "@/lib/hosts";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects, useRegisterProject, useUpdateProject } from "@/lib/task-queries";
import {
  aliasClashes,
  buildRemotes,
  choiceFromProject,
  linksOf,
  type MrRemoteChoice,
  projectIdError,
  remoteNames,
  suggestProjectId,
} from "./project-model";
import { SshAliasPicker } from "./ssh-alias-picker";

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
  const { org: orgFilter } = useOrgFilter();
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
  const [choice, setChoice] = useState<MrRemoteChoice>(() => choiceFromProject(project));
  const [dependsOn, setDependsOn] = useState<string[]>(() => project?.links.map((l) => l.to) ?? []);
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  const orgList = orgs.data ?? [];
  const chosenOrg = org || (orgList.length === 0 ? "" : defaultOrgId(orgList, orgFilter));
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
    const remotes = buildRemotes(project?.remotes, choice);
    const links = linksOf(dependsOn);
    const fail = (error: ApiRequestError) => setFailure([error.message, ...error.details].join(". "));
    if (editing) {
      update.mutate(
        {
          id,
          org: chosenOrg,
          aliases,
          ...(trimmedBase ? { base: trimmedBase } : {}),
          ...(remotes !== undefined && { remotes }),
          ...(project.links.length > 0 || links.length > 0 ? { links: links.length > 0 ? links : null } : {}),
        },
        { onSuccess: done, onError: fail },
      );
    } else {
      register.mutate(
        {
          id,
          org: chosenOrg,
          path: repo.path,
          aliases,
          ...(trimmedBase ? { base: trimmedBase } : {}),
          ...(remotes ? { remotes } : {}),
          ...(links.length > 0 ? { links } : {}),
        },
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
              placeholder={repo.branch ?? "main"}
              className="font-mono"
            />
          )}
        </Field>

        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="mb-1.5 p-0 text-sm text-fg-faint">Merge requests</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Open MRs against" hint="Default: origin.">
              {(props) => (
                <Select
                  {...props}
                  value={choice.name}
                  onChange={(event) => setChoice({ ...choice, name: event.target.value })}
                >
                  {remoteNames(repo, project).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Host" hint="Auto reads it from the remote's URL.">
              {(props) => (
                <Select
                  {...props}
                  value={choice.host}
                  onChange={(event) => {
                    const parsed = MrHostSchema.safeParse(event.target.value);
                    setChoice({ ...choice, host: parsed.success ? parsed.data : "" });
                  }}
                >
                  <option value="">Auto</option>
                  {MrHostSchema.options.map((host: MrHost) => (
                    <option key={host} value={host}>
                      {HOST_LABEL[host]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="SSH alias" hint="A Host from your SSH config. Pushes go through it.">
            {(props) => (
              <SshAliasPicker
                fieldProps={{ id: props.id, "aria-describedby": props["aria-describedby"] }}
                value={choice.ssh}
                onChange={(ssh) => setChoice({ ...choice, ssh })}
                suggested={repo.remotes.flatMap((r) => (r.sshAlias ? [r.sshAlias] : []))}
              />
            )}
          </Field>
          {others.filter((p) => p.id !== id).length > 0 && (
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-sm text-fg-faint">Depends on</legend>
              {others
                .filter((p) => p.id !== id)
                .map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(p.id)}
                      onChange={(event) =>
                        setDependsOn(
                          event.target.checked ? [...dependsOn, p.id] : dependsOn.filter((d) => d !== p.id),
                        )
                      }
                    />
                    <span className="font-mono">{p.id}</span>
                  </label>
                ))}
              <span className="text-xs text-fg-faint">
                When a task changes both, the one it depends on merges first.
              </span>
            </fieldset>
          )}
        </fieldset>

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
