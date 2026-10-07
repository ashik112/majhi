import type { Repo } from "@majhi/shared";
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
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects, useRegisterProject } from "@/lib/task-queries";
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

/** Registers a repo as a project. A registered project is edited in place on its detail pane. */
export function RegisterDialog({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const orgs = useOrgs();
  const { org: orgFilter } = useOrgFilter();
  const projects = useProjects();
  const register = useRegisterProject();
  const toast = useToast();
  const others = projects.data ?? [];
  const taken = useMemo(() => others.map((p) => p.id), [others]);

  const [org, setOrg] = useState("");
  const [id, setId] = useState(() => suggestProjectId(repo.name, taken));
  const [aliases, setAliases] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [choice, setChoice] = useState<MrRemoteChoice>(() => choiceFromProject(undefined));
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();

  const orgList = orgs.data ?? [];
  const chosenOrg = org || (orgList.length === 0 ? "" : defaultOrgId(orgList, orgFilter));
  const idProblem = projectIdError(id, taken);
  const clashes = aliasClashes(aliases, others, id);
  const orgProblem = chosenOrg === "" ? "Pick the workspace this repo belongs to" : undefined;
  const aliasProblem =
    clashes.length > 0
      ? `${clashes.map((c) => `${c.alias} (${c.project})`).join(", ")} already in use`
      : undefined;
  const busy = register.isPending;

  function submit() {
    setSubmitted(true);
    setFailure(undefined);
    if (idProblem || orgProblem || aliasProblem) return;
    const trimmedBase = base.trim();
    const done = () => {
      toast("Project registered", { detail: id });
      onClose();
    };
    const remotes = buildRemotes(undefined, choice);
    const links = linksOf(dependsOn);
    const fail = (error: ApiRequestError) => setFailure([error.message, ...error.details].join(". "));
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

  return (
    <Modal label={`Register ${repo.name}`} onClose={onClose} className="flex w-[480px] flex-col open:flex">
      <form
        className="flex max-h-[calc(100dvh-32px)] min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex shrink-0 flex-col gap-1 border-b border-line-strong px-5 py-3.5">
          <h2 className="text-md font-semibold">Register {repo.name}</h2>
          <p className="truncate font-mono text-sm text-fg-faint" title={repo.path}>
            {repo.path}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4 scroll-fade">
          <Field label="Workspace" error={submitted ? orgProblem : undefined}>
            {(props) => (
              <Select {...props} value={chosenOrg} onChange={(event) => setOrg(event.target.value)}>
                <option value="">Choose a workspace</option>
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

          <Field
            label="Base branch (optional)"
            hint="Default: the workspace's base, then the repo's default branch."
          >
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
                    {remoteNames(repo, undefined).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {others.filter((p) => p.id !== id).length > 0 && (
              <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
                <legend className="mb-1 p-0 text-sm text-fg-faint">Depends on</legend>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {others
                    .filter((p) => p.id !== id)
                    .map((p) => (
                      <label key={p.id} className="flex min-w-0 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={dependsOn.includes(p.id)}
                          onChange={(event) =>
                            setDependsOn(
                              event.target.checked
                                ? [...dependsOn, p.id]
                                : dependsOn.filter((d) => d !== p.id),
                            )
                          }
                        />
                        <span className="truncate font-mono" title={p.id}>
                          {p.id}
                        </span>
                      </label>
                    ))}
                </div>
                <span className="text-xs text-fg-faint">
                  When a task changes both, the one it depends on merges first.
                </span>
              </fieldset>
            )}
          </fieldset>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-line-strong px-5 py-3">
          {failure && (
            <p role="alert" className="min-w-0 flex-1 text-sm text-red text-pretty">
              {failure}
            </p>
          )}
          <div className="ml-auto flex shrink-0 gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Register
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
