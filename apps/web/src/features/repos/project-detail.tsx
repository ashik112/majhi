import {
  ContainerMemorySchema,
  collapseHome,
  type GitStatus,
  type OrgView,
  type ProjectCard,
  type ProjectView,
  type Repo,
} from "@majhi/shared";
import { CircleAlert, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { OpenInEditor } from "@/components/open-in-editor";
import { Button } from "@/components/ui/button";
import { ChipsInput } from "@/components/ui/chips-input";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Select } from "@/components/ui/select";
import { Dot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { orgLabel } from "@/features/accounts/model";
import { DeploySection } from "@/features/deploy/deploy-section";
import type { ApiRequestError } from "@/lib/api";
import { useProjectCards } from "@/lib/card-queries";
import { cn } from "@/lib/cn";
import { badgeLetters } from "@/lib/format";
import { HOST_LABEL } from "@/lib/hosts";
import { useGitStatus, useOrgs, useUpdateOrg } from "@/lib/studio-queries";
import { useUpdateProject } from "@/lib/task-queries";
import { useSearchParam } from "@/pages/parts/url-state";
import { ProjectCardSection } from "./project-card";
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

const GRID = "grid gap-3 @[460px]:grid-cols-2";
const IDLE: SaveState = { kind: "idle" };

/** The Deploys section. Opened from a link to `section=deploys` (a deploy's task), it scrolls into view once. */
function DeploysAnchor({ project }: { project: ProjectView }) {
  const [section, setSection] = useSearchParam("section");
  const top = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the link lands
  useEffect(() => {
    if (section !== "deploys") return;
    top.current?.scrollIntoView({ block: "start" });
    setSection(undefined);
  }, []);
  return (
    <div ref={top}>
      <DeploySection project={project} />
    </div>
  );
}

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
    commits?: ProjectView["commits"] | null;
    handoff?: ProjectView["handoff"] | null;
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
        ...(patch.commits !== undefined ? { commits: patch.commits } : {}),
        ...(patch.handoff !== undefined ? { handoff: patch.handoff } : {}),
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
                  "flex shrink-0 items-center gap-1.5 pl-1 whitespace-nowrap",
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
      {project.exists && (
        <div className="mt-4">
          <ProjectCardSection project={project.id} />
        </div>
      )}
      <DeploysAnchor project={project} />
      <ProtectionSection project={project} />
      <NamesSection project={project} repo={repo} projects={projects} orgs={orgs} />
      <HandoffSection project={project} />
      <RemotesSection project={project} repo={repo} />
      <LinksSection project={project} projects={projects} />
    </DetailPane>
  );
}

/**
 * Protected (infra): majhi never adds it to a task by itself, agents get it read-only, and it ships
 * only alone when the owner types its name. A project that looks like infra is offered it.
 */
function ProtectionSection({ project }: { project: ProjectView }) {
  const update = useUpdateProject();
  const [error, setError] = useState<string>();
  const set = (on: boolean) => {
    setError(undefined);
    update.mutate(
      {
        id: project.id,
        org: project.org,
        aliases: [...project.aliases],
        ...(project.base === undefined ? {} : { base: project.base }),
        protected: on,
      },
      { onError: (e: ApiRequestError) => setError(e.message) },
    );
  };
  return (
    <section aria-label="Protection" className="mt-4 flex flex-col gap-1.5">
      {project.looksLikeInfra === true && !project.protected && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-line bg-amber-wash px-3 py-2 text-sm text-fg-soft">
          <Lock aria-hidden="true" className="size-3.5 shrink-0 text-amber" />
          <span className="min-w-0 flex-1 text-pretty">
            This looks like infra. Protect it so majhi never merges or pushes it without you.
          </span>
          <Button size="sm" variant="secondary" disabled={update.isPending} onClick={() => set(true)}>
            Protect it
          </Button>
        </p>
      )}
      <Switch
        label="Protected (infra): majhi never merges or pushes it without you"
        checked={project.protected}
        disabled={update.isPending}
        onChange={set}
      />
      <p className="text-xs text-fg-faint text-pretty">
        Only you can add it to a task. Agents get it read-only unless you allow writes for a task. It ships
        alone, after you type its name.
      </p>
      {error && (
        <p role="alert" className="text-xs text-red text-pretty">
          {error}
        </p>
      )}
    </section>
  );
}

type AttributionChoice = "default" | "on" | "off";

/** The project's own attribution setting as the select shows it. */
function attributionChoice(project: ProjectView): AttributionChoice {
  const on = project.commits?.attribution;
  return on === undefined ? "default" : on ? "on" : "off";
}

/** Org, aliases, base branch and agent attribution in commits. */
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
  const initial = {
    org: project.org,
    aliases: [...project.aliases],
    base: project.base ?? "",
    commits: attributionChoice(project),
  };
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
    draft.commits !== initial.commits ||
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
        save({
          org: draft.org,
          aliases: draft.aliases,
          base: draft.base,
          commits: draft.commits === "default" ? null : { attribution: draft.commits === "on" },
        });
      }}
    >
      <div className={GRID}>
        <Field label="Workspace">
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
              ? `Blank uses the workspace's base, then the repo's default. Checked out now: ${repo.branch}.`
              : "Blank uses the workspace's base, then the repo's default."
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
          label="Agent attribution in commits"
          hint="The agent is the committer and each commit names its task. Off: your identity alone."
        >
          {(props) => (
            <Select
              {...props}
              value={draft.commits}
              onChange={(e) => set({ commits: e.target.value as AttributionChoice })}
            >
              <option value="default">Use the workspace's setting</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </Select>
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

const HANDOFF_ROWS = [
  { key: "test", label: "Test", placeholder: "pnpm exec vitest run --changed {base}" },
  { key: "build", label: "Build", placeholder: "pnpm build" },
  { key: "lint", label: "Lint", placeholder: "pnpm lint" },
  { key: "typecheck", label: "Typecheck", placeholder: "pnpm typecheck" },
] as const;

/** Where a check's command comes from: this project's own setting, the repo's CI, or the project card. */
function sourceOf(
  key: (typeof HANDOFF_ROWS)[number]["key"],
  own: string,
  card: ProjectCard | undefined,
): { command: string | undefined; from: string; env: string[] } {
  if (own.trim() !== "") return { command: own.trim(), from: "set here", env: [] };
  const ci = card?.checks.find((c) => c.kind === key);
  if (ci !== undefined)
    return {
      command: ci.command,
      from: `${ci.from}${ci.workdir === undefined ? "" : `, in ${ci.workdir}`}`,
      env: Object.entries(ci.env).map(([k, v]) => `${k}=${v}`),
    };
  const fromCard = card?.commands[key];
  return fromCard === undefined
    ? { command: undefined, from: "nothing found: no check runs", env: [] }
    : { command: fromCard, from: "from the project card", env: [] };
}

/** The commands the check before ship runs, where each came from, and how much memory a check may use. */
function HandoffSection({ project }: { project: ProjectView }) {
  const initial = {
    test: project.handoff?.test ?? "",
    build: project.handoff?.build ?? "",
    lint: project.handoff?.lint ?? "",
    typecheck: project.handoff?.typecheck ?? "",
  };
  const [draft, setDraft] = useState(initial);
  const { state, setState, save } = useSectionSave(project);
  const card = useProjectCards().data?.get(project.id);
  const orgs = useOrgs();
  const updateOrg = useUpdateOrg();
  const org = orgs.data?.find((o) => o.id === project.org);
  const savedMemory = org?.checks?.memory ?? "";
  const [memory, setMemory] = useState(savedMemory);
  const memoryProblem =
    memory.trim() === "" || ContainerMemorySchema.safeParse(memory.trim()).success
      ? undefined
      : "Use a size like 6g or 8192m";
  const dirty =
    HANDOFF_ROWS.some((r) => draft[r.key].trim() !== initial[r.key]) || memory.trim() !== savedMemory;
  // Opened from a link that points here (a check that ran out of memory): bring the section into view.
  const [section, setSection] = useSearchParam("section");
  const top = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the link lands
  useEffect(() => {
    if (section !== "checks") return;
    top.current?.scrollIntoView({ block: "start" });
    setSection(undefined);
  }, []);
  return (
    <div ref={top}>
      <SaveSection
        title="Check before ship"
        dirty={dirty}
        state={state}
        onDiscard={() => {
          setDraft(initial);
          setMemory(savedMemory);
          setState(IDLE);
        }}
        onSave={() => {
          if (memoryProblem !== undefined) return;
          const lines = Object.fromEntries(
            HANDOFF_ROWS.flatMap((r) => (draft[r.key].trim() === "" ? [] : [[r.key, draft[r.key].trim()]])),
          );
          if (memory.trim() !== savedMemory) {
            setState({ kind: "saving" });
            updateOrg.mutate(
              { id: project.org, checks: memory.trim() === "" ? null : { memory: memory.trim() } },
              {
                onSuccess: () => {
                  if (HANDOFF_ROWS.some((r) => draft[r.key].trim() !== initial[r.key]))
                    save({ handoff: Object.keys(lines).length === 0 ? null : lines });
                  else setState({ kind: "saved" });
                },
                onError: (e: ApiRequestError) =>
                  setState({ kind: "error", message: e.message, details: e.details }),
              },
            );
            return;
          }
          save({ handoff: Object.keys(lines).length === 0 ? null : lines });
        }}
      >
        <p className="mb-3 text-sm text-fg-soft text-pretty">
          Blank rows run what the repo&apos;s own CI runs, with its environment, else the project card&apos;s
          command. A command that rewrites files (<span className="font-mono">--fix</span>,{" "}
          <span className="font-mono">--write</span>) runs in its read-only form. In Test,{" "}
          <span className="font-mono">{"{base}"}</span> becomes the commit the task branched from.
        </p>
        <div className="grid gap-3">
          {HANDOFF_ROWS.map((r) => {
            const source = sourceOf(r.key, draft[r.key], card);
            return (
              <Field
                key={r.key}
                label={r.label}
                hint={`${source.from[0]?.toUpperCase() ?? ""}${source.from.slice(1)}${source.env.length === 0 ? "" : `. Runs with ${source.env.join(" ")}`}`}
              >
                {(props) => (
                  <Input
                    {...props}
                    value={draft[r.key]}
                    onChange={(e) => {
                      if (state.kind !== "saving") setState(IDLE);
                      setDraft((d) => ({ ...d, [r.key]: e.target.value }));
                    }}
                    placeholder={source.command ?? r.placeholder}
                    className="font-mono"
                  />
                )}
              </Field>
            );
          })}
          <Field
            label="Memory per check"
            hint={`The most one check of ${org?.name ?? "this workspace"} may use. A check that hits it says so. Blank: a quarter of this machine, at least 6g`}
            error={memoryProblem}
          >
            {(props) => (
              <Input
                {...props}
                value={memory}
                onChange={(e) => {
                  if (state.kind !== "saving") setState(IDLE);
                  setMemory(e.target.value);
                }}
                placeholder="8g"
                className="font-mono"
              />
            )}
          </Field>
        </div>
      </SaveSection>
    </div>
  );
}

/** The repo's remotes as git has them, who each one pushes as, and the remote MRs go to. */
function RemotesSection({ project, repo }: { project: ProjectView; repo: Repo | undefined }) {
  const initial = choiceFromProject(project);
  const [choice, setChoice] = useState<MrRemoteChoice>(initial);
  const { state, setState, save } = useSectionSave(project);
  const known = repo ?? stubRepo(project);
  const git = useGitStatus(project.org);
  const dirty = choice.name !== initial.name;
  // Opened from a link that points here (Ship's "Fix it in Projects"): show the MR remote at once.
  const [section, setSection] = useSearchParam("section");
  const mrField = useRef<string>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the link lands
  useEffect(() => {
    if (section !== "remotes" || mrField.current === undefined) return;
    const field = document.getElementById(mrField.current);
    field?.scrollIntoView({ block: "center" });
    field?.focus({ preventScroll: true });
    setSection(undefined);
  }, []);
  return (
    <SaveSection
      title="Remotes"
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
              <span className="flex min-w-0 max-w-[240px] shrink-0 items-center gap-2 text-xs">
                <PushesAs org={project.org} remote={remote} status={git.data} />
                {remote.name === initial.name && <span className="shrink-0 text-accent-text">MRs</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className={GRID}>
        <Field label="Open MRs against" hint="Default: origin.">
          {(props) => {
            mrField.current = props.id;
            return (
              <Select
                {...props}
                value={choice.name}
                onChange={(e) => {
                  if (state.kind !== "saving") setState(IDLE);
                  setChoice({ name: e.target.value });
                }}
              >
                {remoteNames(known, project).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            );
          }}
        </Field>
      </div>
    </SaveSection>
  );
}

/**
 * Who a remote pushes as: the workspace's git account for its host, and how it reaches the host. A host
 * with no account links to the workspace's git accounts, where one step adds it.
 */
function PushesAs({
  org,
  remote,
  status,
}: {
  org: string;
  remote: Repo["remotes"][number];
  status: GitStatus | undefined;
}) {
  if (status === undefined || remote.hostName === undefined) return null;
  const account = status.accounts.find((a) => a.host === remote.hostName);
  if (account === undefined) {
    return (
      <PageLink
        page="orgs"
        search={{ org }}
        className="inline-flex min-w-0 items-center gap-1 truncate text-amber underline-offset-2 hover:underline"
      >
        <Dot tone="amber" size={7} />
        <span className="truncate">No git account for {remote.hostName}</span>
      </PageLink>
    );
  }
  const how = PUSH_LABEL[account.push.state];
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-fg-muted"
      title={`${account.account} on ${account.host}`}
    >
      <Dot tone={account.push.state === "missing" ? "amber" : "green"} size={7} />
      <span className="truncate font-mono">{account.account}</span>
      <span className="shrink-0 text-fg-faint">{how}</span>
    </span>
  );
}

const PUSH_LABEL: Record<GitStatus["accounts"][number]["push"]["state"], string> = {
  ssh: "SSH key",
  https: "saved login",
  unknown: "not checked",
  missing: "no SSH key",
};

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
