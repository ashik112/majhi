import {
  collapseHome,
  type MrHost,
  type ProjectCreate,
  ProjectFolderSchema,
  type ProjectPublish,
} from "@majhi/shared";
import { CircleCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { defaultOrgId } from "@/features/accounts/model";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useCreateProject, usePublishProject } from "@/lib/onboarding-queries";
import { useConfig } from "@/lib/queries";
import { ExternalButton, Tick, Waiting } from "../bits";
import { Problem, useStep } from "../step-frame";
import { WorkspaceSelect } from "./workspace-select";

type Outcome =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "publishing"; created: ProjectCreate; host: MrHost }
  | { kind: "done"; created: ProjectCreate; published?: { result: ProjectPublish; host: MrHost } }
  | { kind: "publish-failed"; created: ProjectCreate; host: MrHost; message: string }
  | { kind: "failed"; message: string };

/**
 * A new project: a folder with git on `main`, a README and a first commit, made on this computer.
 * "Also create it on GitHub" (off by default) publishes it right after, as a second call, so the
 * remote part follows the outbound rules on its own.
 */
export function NewProject() {
  const step = useStep();
  const create = useCreateProject();
  const publish = usePublishProject();
  const home = useConfig().data?.home ?? "";
  const workspaces = step.status.workspaces;
  const [name, setName] = useState("");
  const [orgPick, setOrg] = useState<string>();
  const org = orgPick ?? defaultOrgId(workspaces);
  const [description, setDescription] = useState("");
  const [remote, setRemote] = useState(false);
  const [hostPick, setHost] = useState<MrHost>();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [touched, setTouched] = useState(false);

  const workspace = workspaces.find((w) => w.id === org);
  const signed = (workspace?.git ?? []).filter((g) => g.signedIn);
  const host = signed.find((g) => g.kind === hostPick) ?? signed[0];
  const parsed = ProjectFolderSchema.safeParse(name);
  const nameProblem = touched && name !== "" && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const root = step.status.roots[0];
  const where = root && parsed.success ? `${collapseHome(root, home)}/${org}/${parsed.data}` : undefined;

  async function runPublish(created: ProjectCreate, kind: MrHost) {
    setOutcome({ kind: "publishing", created, host: kind });
    try {
      const published = await publish.mutateAsync({
        id: created.project.id,
        kind,
        ...(host?.host ? { host: host.host } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setOutcome({ kind: "done", created, published: { result: published, host: kind } });
    } catch (error) {
      setOutcome({ kind: "publish-failed", created, host: kind, message: describeError(error) });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!parsed.success) return;
    setOutcome({ kind: "creating" });
    let created: ProjectCreate;
    try {
      created = await create.mutateAsync({
        org,
        name: parsed.data,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
    } catch (error) {
      setOutcome({ kind: "failed", message: describeError(error) });
      return;
    }
    if (remote && host) await runPublish(created, host.kind);
    else setOutcome({ kind: "done", created });
  }

  if (outcome.kind === "done" || outcome.kind === "publishing" || outcome.kind === "publish-failed") {
    const project = outcome.created.project;
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-line-strong bg-card p-5">
        <p role="status" className="m-0 flex items-center gap-2.5 text-md text-fg">
          <CircleCheck aria-hidden="true" className="size-[18px] text-green" />
          <span>
            <span className="font-mono font-medium">{project.id}</span> is ready on{" "}
            <span className="font-mono">main</span>, with its first commit.
          </span>
        </p>
        <p className="m-0 truncate font-mono text-sm text-fg-faint" title={project.path}>
          {collapseHome(project.path, home)}
        </p>
        {outcome.kind === "publishing" && (
          <Waiting>Creating it on {HOST_LABEL[outcome.host]} and pushing main</Waiting>
        )}
        {outcome.kind === "publish-failed" && (
          <>
            <Problem>
              The project is saved on this computer, but {HOST_LABEL[outcome.host]} did not take it:{" "}
              {outcome.message}
            </Problem>
            <div>
              <Button onClick={() => void runPublish(outcome.created, outcome.host)}>
                Try {HOST_LABEL[outcome.host]} again
              </Button>
            </div>
          </>
        )}
        {outcome.kind === "done" && outcome.published && (
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <span className="text-base text-fg-soft">
              On {HOST_LABEL[outcome.published.host]} as{" "}
              <span className="font-mono">
                {outcome.published.result.remote.fullName ?? outcome.published.result.remote.url}
              </span>
              , with <span className="font-mono">{outcome.published.result.pushed}</span> pushed
            </span>
            {outcome.published.result.remote.webUrl && (
              <ExternalButton href={outcome.published.result.remote.webUrl} size="sm" variant="ghost">
                Open
              </ExternalButton>
            )}
          </div>
        )}
        {outcome.kind === "done" && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2.5"
              onClick={() => {
                setName("");
                setDescription("");
                setTouched(false);
                setOutcome({ kind: "idle" });
              }}
            >
              Make another
            </Button>
          </div>
        )}
      </div>
    );
  }

  const busy = outcome.kind === "creating";
  return (
    <form aria-label="New project" onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
      <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-4 max-[1180px]:grid-cols-1">
        <Field
          label="Name"
          error={nameProblem}
          hint={
            where ? (
              <span className="font-mono">{where}</span>
            ) : (
              "The folder name, and the repo name if you publish it."
            )
          }
        >
          {(p) => (
            <Input
              {...p}
              autoFocus
              className="h-10 font-mono text-body"
              placeholder="new-api"
              value={name}
              onBlur={() => setTouched(true)}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Workspace">
          {(p) => (
            <WorkspaceSelect
              workspaces={workspaces}
              value={org}
              onChange={(id) => {
                setOrg(id);
                setHost(undefined);
              }}
              className="h-10"
              label="Workspace"
              {...p}
            />
          )}
        </Field>
      </div>
      <Field label="Description" hint="Optional. One line for the README.">
        {(p) => (
          <Input
            {...p}
            className="h-10 text-body"
            placeholder="Billing API for the new checkout"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>

      <div className="flex flex-col gap-2.5 rounded-xl border border-line-strong bg-card p-4">
        <div className="flex items-center gap-3">
          <Tick
            id="publish-box"
            checked={remote && host !== undefined}
            disabled={host === undefined}
            label={`Also create it on ${host ? HOST_LABEL[host.kind] : "a git host"}`}
            onChange={setRemote}
          />
          <label htmlFor="publish-box" className="cursor-pointer text-body text-fg">
            Also create it on {host ? HOST_LABEL[host.kind] : "GitHub or GitLab"}
          </label>
          {signed.length > 1 && (
            <Select
              aria-label="Git host"
              value={host?.kind}
              onChange={(e) => setHost(e.target.value as MrHost)}
              className="ml-auto w-[140px]"
            >
              {signed.map((g) => (
                <option key={g.kind} value={g.kind}>
                  {HOST_LABEL[g.kind]}
                </option>
              ))}
            </Select>
          )}
        </div>
        <p className="m-0 pl-[30px] text-sm text-fg-muted text-pretty">
          {host
            ? `A private repo under @${host.account ?? "your account"}, with main pushed to it. Leave it off to keep the project on this computer: you can publish it later, or connect a repo you made by hand.`
            : `${workspace?.name ?? "This workspace"} is not signed in to a git host yet. You can publish the project later, or connect a repo you made by hand.`}
        </p>
      </div>

      {outcome.kind === "failed" && <Problem>{outcome.message}</Problem>}
      <div>
        <Button
          type="submit"
          variant={step.done ? "secondary" : "primary"}
          size="lg"
          disabled={busy || name === ""}
        >
          {busy
            ? "Creating"
            : remote && host
              ? `Create and publish on ${HOST_LABEL[host.kind]}`
              : "Create project"}
        </Button>
      </div>
    </form>
  );
}
