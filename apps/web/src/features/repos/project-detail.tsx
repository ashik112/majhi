import {
  collapseHome,
  type MrHost,
  MrHostSchema,
  type OrgView,
  type ProjectView,
  type Repo,
} from "@majhi/shared";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { OpenInEditor } from "@/components/open-in-editor";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Select } from "@/components/ui/select";
import { Dot } from "@/components/ui/status-dot";
import { orgLabel } from "@/features/accounts/model";
import type { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { HOST_LABEL } from "@/lib/hosts";
import { useUpdateProject } from "@/lib/task-queries";
import {
  aliasClashes,
  buildRemotes,
  choiceFromProject,
  linksOf,
  type MrRemoteChoice,
  remoteNames,
  stubRepo,
} from "./project-model";
import { CopyPath } from "./project-row";
import { SshAliasPicker } from "./ssh-alias-picker";

const GRID = "grid gap-3 @[460px]:grid-cols-2";
const IDLE: SaveState = { kind: "idle" };

/** Saves one section through `projects.update`, keeping the fields the section does not own as they are. */
function useSectionSave(project: ProjectView) {
  const update = useUpdateProject();
  const [state, setState] = useState<SaveState>(IDLE);
  const save = (patch: {
    org?: string;
    aliases?: string[];
    base?: string;
    remotes?: ProjectView["remotes"] | null;
    links?: ProjectView["links"] | null;
  }) => {
    setState({ kind: "saving" });
    const base = patch.base ?? project.base ?? "";
    update.mutate(
      {
        id: project.id,
        org: patch.org ?? project.org,
        aliases: patch.aliases ?? [...project.aliases],
        ...(base.trim() !== "" ? { base: base.trim() } : {}),
        ...(patch.remotes !== undefined ? { remotes: patch.remotes } : {}),
        ...(patch.links !== undefined ? { links: patch.links } : {}),
      },
      {
        onSuccess: () => setState({ kind: "saved" }),
        onError: (e: ApiRequestError) => setState({ kind: "error", message: e.message, details: e.details }),
      },
    );
  };
  return { state, setState, save };
}

/** A registered project: where it is, its task-box names and base, its remotes and where MRs go, and its links. */
export function ProjectDetail({
  project,
  repo,
  projects,
  orgs,
  home,
  onRemove,
}: {
  project: ProjectView;
  repo: Repo | undefined;
  projects: readonly ProjectView[];
  orgs: readonly OrgView[];
  home: string;
  onRemove: () => void;
}) {
  const org = orgLabel(project.org, orgs);
  const key = orgs.find((o) => o.id === project.org)?.key ?? project.org;
  const path = collapseHome(project.path, home);
  return (
    <DetailPane
      label={`Project ${project.id}`}
      head={
        <div className="flex min-w-0 items-center gap-3">
          <OrgBadge label={badgeLetters(key)} color={org.color} className="size-8 rounded-lg text-xs" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="truncate font-mono text-md leading-6 font-semibold">{project.id}</h2>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
              <span className="shrink-0">{org.name}</span>
              <span aria-hidden="true" className="text-fg-dim">
                ·
              </span>
              <span className="min-w-0 truncate font-mono text-fg-faint" title={project.path}>
                {path}
              </span>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 pl-1",
                  project.exists ? "text-green" : "text-red",
                )}
              >
                <Dot tone={project.exists ? "green" : "red"} size={7} />
                {project.exists ? "On disk" : "Missing"}
              </span>
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <OpenInEditor path={project.path} name={project.id} size="icon-sm" variant="ghost" />
            <CopyPath name={project.id} path={project.path} home={home} />
            <Button size="sm" variant="ghost" aria-label={`Remove project ${project.id}`} onClick={onRemove}>
              Remove
            </Button>
          </div>
        </div>
      }
    >
      {!project.exists && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-red-line bg-red-wash px-3 py-2 text-sm text-fg-soft"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-red" />
          <span className="text-pretty">
            No git repo at <span className="font-mono">{path}</span>. Tasks cannot use this project until the
            repo is back at this path, or you remove the project and register the repo where it is now.
          </span>
        </p>
      )}
      <NamesSection project={project} repo={repo} projects={projects} orgs={orgs} />
      <RemotesSection project={project} repo={repo} />
      <LinksSection project={project} projects={projects} />
    </DetailPane>
  );
}

/** Org, aliases and base branch. */
function NamesSection({
  project,
  repo,
  projects,
  orgs,
}: {
  project: ProjectView;
  repo: Repo | undefined;
  projects: readonly ProjectView[];
  orgs: readonly OrgView[];
}) {
  const initial = { org: project.org, aliases: [...project.aliases], base: project.base ?? "" };
  const [draft, setDraft] = useState(initial);
  const { state, setState, save } = useSectionSave(project);
  const clashes = aliasClashes(draft.aliases, projects, project.id);
  const aliasProblem =
    clashes.length > 0
      ? `${clashes.map((c) => `${c.alias} (${c.project})`).join(", ")} already in use`
      : undefined;
  const dirty =
    draft.org !== initial.org ||
    draft.base.trim() !== initial.base ||
    draft.aliases.join("\n") !== initial.aliases.join("\n");
  const set = (patch: Partial<typeof draft>) => {
    if (state.kind !== "saving") setState(IDLE);
    setDraft((d) => ({ ...d, ...patch }));
  };
  return (
    <SaveSection
      title="Settings"
      className="border-t-0"
      dirty={dirty}
      state={state}
      onDiscard={() => {
        setDraft(initial);
        setState(IDLE);
      }}
      onSave={() => {
        if (aliasProblem) return;
        save({ org: draft.org, aliases: draft.aliases, base: draft.base });
      }}
    >
      <div className={GRID}>
        <Field label="Org">
          {(props) => (
            <Select {...props} value={draft.org} onChange={(e) => set({ org: e.target.value })}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Base branch"
          hint={
            repo?.branch
              ? `Blank uses the org's base, then the repo's default. Checked out now: ${repo.branch}.`
              : "Blank uses the org's base, then the repo's default."
          }
        >
          {(props) => (
            <Input
              {...props}
              value={draft.base}
              onChange={(e) => set({ base: e.target.value })}
              placeholder="main"
              className="font-mono"
            />
          )}
        </Field>
        <Field
          label="Aliases"
          hint="Other words for it in the task box, like backend or api. Enter adds one."
          error={aliasProblem}
          className="@[460px]:col-span-2"
        >
          {(props) => (
            <ChipsInput
              {...props}
              label="Aliases"
              value={draft.aliases}
              onChange={(aliases) => set({ aliases })}
              placeholder="backend"
            />
          )}
        </Field>
      </div>
    </SaveSection>
  );
}

/** The repo's remotes as git has them, then the remote MRs go to, its host and the SSH alias pushes use. */
function RemotesSection({ project, repo }: { project: ProjectView; repo: Repo | undefined }) {
  const initial = choiceFromProject(project);
  const [choice, setChoice] = useState<MrRemoteChoice>(initial);
  const { state, setState, save } = useSectionSave(project);
  const known = repo ?? stubRepo(project);
  const dirty = choice.name !== initial.name || choice.host !== initial.host || choice.ssh !== initial.ssh;
  const set = (patch: Partial<MrRemoteChoice>) => {
    if (state.kind !== "saving") setState(IDLE);
    setChoice((c) => ({ ...c, ...patch }));
  };
  return (
    <SaveSection
      title="Remotes and merge requests"
      dirty={dirty}
      state={state}
      onDiscard={() => {
        setChoice(initial);
        setState(IDLE);
      }}
      onSave={() => {
        const remotes = buildRemotes(project.remotes, choice);
        if (remotes === undefined) return setState({ kind: "saved" });
        save({ remotes });
      }}
    >
      {known.remotes.length === 0 ? (
        <p className="text-sm text-fg-faint">
          {repo
            ? "The repo has no remote, so nothing can be pushed."
            : "The repo was not found, so its remotes are unknown."}
        </p>
      ) : (
        <ul aria-label={`Remotes of ${project.id}`} className="flex flex-col">
          {known.remotes.map((remote) => (
            <li
              key={remote.name}
              className="grid min-h-9 grid-cols-[88px_120px_minmax(0,1fr)_auto] items-center gap-3 border-t border-line py-1.5 text-sm first:border-t-0"
            >
              <span className="truncate font-mono text-fg">{remote.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-fg-soft">
                <HostGlyph host={remote.host} className="size-3.5" />
                <span className="truncate">{HOST_LABEL[remote.host]}</span>
              </span>
              <span className="min-w-0 truncate font-mono text-xs text-fg-faint" title={remote.url}>
                {remote.url}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs">
                {remote.sshAlias && <span className="font-mono text-fg-muted">{remote.sshAlias}</span>}
                {remote.name === initial.name && <span className="text-accent-text">MRs</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 @[460px]:grid-cols-2 @[760px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
        <Field label="Open MRs against" hint="Default: origin.">
          {(props) => (
            <Select {...props} value={choice.name} onChange={(e) => set({ name: e.target.value })}>
              {remoteNames(known, project).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Host" hint="Auto reads it from the URL.">
          {(props) => (
            <Select
              {...props}
              value={choice.host}
              onChange={(e) => {
                const parsed = MrHostSchema.safeParse(e.target.value);
                set({ host: parsed.success ? parsed.data : "" });
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
        <Field
          label="SSH alias"
          hint="A Host from your SSH config. Pushes go through it."
          className="@[460px]:col-span-2 @[760px]:col-span-1"
        >
          {(props) => (
            <SshAliasPicker
              fieldProps={{ id: props.id, "aria-describedby": props["aria-describedby"] }}
              value={choice.ssh}
              onChange={(ssh) => set({ ssh })}
              suggested={known.remotes.flatMap((r) => (r.sshAlias ? [r.sshAlias] : []))}
            />
          )}
        </Field>
      </div>
    </SaveSection>
  );
}

/** The projects this one depends on: when a task changes both, the one it depends on merges first. */
function LinksSection({ project, projects }: { project: ProjectView; projects: readonly ProjectView[] }) {
  const initial = project.links.map((l) => l.to);
  const [dependsOn, setDependsOn] = useState<string[]>(initial);
  const { state, setState, save } = useSectionSave(project);
  const others = projects.filter((p) => p.id !== project.id);
  const dirty = [...dependsOn].sort().join("\n") !== [...initial].sort().join("\n");
  const toggle = (id: string) => {
    if (state.kind !== "saving") setState(IDLE);
    setDependsOn((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  };
  return (
    <SaveSection
      title="Depends on"
      note="When a task changes both, the one it depends on merges first."
      dirty={dirty}
      state={state}
      onDiscard={() => {
        setDependsOn(initial);
        setState(IDLE);
      }}
      onSave={() => {
        const links = linksOf(dependsOn);
        save({ links: links.length > 0 ? links : null });
      }}
    >
      {others.length === 0 ? (
        <p className="text-sm text-fg-faint">No other project to link to yet.</p>
      ) : (
        <fieldset
          aria-label={`Projects ${project.id} depends on`}
          className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
        >
          {others.map((p) => (
            <ChoiceChip
              key={p.id}
              mono
              pressed={dependsOn.includes(p.id)}
              onClick={() => toggle(p.id)}
              className="min-h-8"
            >
              {p.id}
            </ChoiceChip>
          ))}
        </fieldset>
      )}
    </SaveSection>
  );
}
