import type { OrgView, Skill, SkillInstallResult, SkillPreview, SkillSearchResult } from "@majhi/shared";
import { Download, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useSkillSearch, useSkills, useSkillsCommand, useSkillZipPreview } from "@/lib/skills-queries";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import {
  type AgentChoice,
  AgentToggles,
  agentChoices,
  Block,
  ErrorLine,
  NameList,
  SourceLink,
} from "./parts";

/** What the card on top shows: a preview, and whether committing it installs or updates. */
interface Review {
  kind: "install" | "update";
  preview: SkillPreview;
}

/** The Skills tab: install box, a card to review before anything lands, the directory, and what is installed. */
export function SkillsTab() {
  const skills = useSkills();
  const agents = agentChoices(useAgents().data);
  const orgs = useOrgs().data ?? [];
  const [review, setReview] = useState<Review>();
  const [done, setDone] = useState<string>();

  return (
    <div className="flex flex-col gap-4">
      <InstallBox
        orgs={orgs}
        onPreview={(preview) => {
          setDone(undefined);
          setReview({ kind: "install", preview });
        }}
      />
      {review && (
        <PreviewCard
          key={review.preview.previewId}
          review={review}
          onCancel={() => setReview(undefined)}
          onDone={(names, kind) => {
            setReview(undefined);
            setDone(
              kind === "update"
                ? `Updated ${names.join(", ")}.`
                : `Installed ${names.join(", ")}. Turn it on for an agent below.`,
            );
          }}
        />
      )}
      {done && (
        <p
          role="status"
          className="rounded-md border border-green-line bg-green-wash px-3 py-2 text-base text-green text-pretty"
        >
          {done}
        </p>
      )}
      <Browse
        installed={skills.data ?? []}
        onPreview={(preview) => {
          setDone(undefined);
          setReview({ kind: "install", preview });
        }}
      />
      <Installed
        skills={skills.data}
        error={skills.isError ? describeError(skills.error) : undefined}
        agents={agents}
        onUpdatePreview={(preview) => {
          setDone(undefined);
          setReview({ kind: "update", preview });
        }}
      />
    </div>
  );
}

function InstallBox({ orgs, onPreview }: { orgs: readonly OrgView[]; onPreview: (p: SkillPreview) => void }) {
  const install = useSkillsCommand("skills.install");
  const zip = useSkillZipPreview();
  const picker = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState("");
  const [org, setOrg] = useState("");
  const [over, setOver] = useState(false);
  const busy = install.isPending || zip.isPending;
  const error = install.error ?? zip.error;

  const accept = (result: { status: string }) => {
    if (result.status === "preview") onPreview(result as SkillPreview);
  };
  const review = () => {
    const text = source.trim();
    if (text === "" || busy) return;
    zip.reset();
    install.mutate({ source: text, ...(org === "" ? {} : { org }) }, { onSuccess: accept });
  };
  const takeZip = (file: File | undefined) => {
    if (file === undefined || busy) return;
    install.reset();
    zip.mutate({ file }, { onSuccess: accept });
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    takeZip(event.dataTransfer.files[0]);
  };

  return (
    <Block
      title="Install"
      note="Paste a GitHub link, owner/repo, a git URL, a link to a SKILL.md or archive, or a folder path. Or drop a .zip. You see what it holds before anything is installed."
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the Choose zip button does the same for the keyboard */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col gap-2.5 rounded-lg border border-dashed p-3 transition-colors",
          over ? "border-accent bg-accent-wash" : "border-line-strong",
        )}
      >
        <div className="flex flex-wrap gap-2.5">
          <label htmlFor="skill-source" className="sr-only">
            Skill link, name or folder path
          </label>
          <Input
            id="skill-source"
            className="h-10 min-w-[260px] flex-1"
            placeholder="https://github.com/owner/repo, owner/repo, or ~/Work/my-skill"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") review();
            }}
          />
          {orgs.length > 1 && (
            <Select
              aria-label="Git login for a private repo"
              className="h-10 w-[200px]"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
            >
              <option value="">Public repo</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  Private, {o.name} login
                </option>
              ))}
            </Select>
          )}
          <Button variant="primary" size="lg" disabled={source.trim() === "" || busy} onClick={review}>
            {install.isPending ? "Fetching" : "Review"}
          </Button>
        </div>
        <div className="flex items-center gap-2.5 text-sm text-fg-faint">
          <input
            ref={picker}
            type="file"
            accept=".zip,application/zip"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              takeZip(file);
            }}
          />
          <Button size="sm" disabled={busy} onClick={() => picker.current?.click()}>
            <Upload aria-hidden="true" />
            {zip.isPending ? "Reading zip" : "Choose zip"}
          </Button>
          <span>or drop a .zip of the skill folder here.</span>
        </div>
      </div>
      {error && <ErrorLine>{describeError(error)}</ErrorLine>}
    </Block>
  );
}

/** What a source holds, shown before it is installed: name, description, files and where it came from. */
function PreviewCard({
  review,
  onCancel,
  onDone,
}: {
  review: Review;
  onCancel: () => void;
  onDone: (names: string[], kind: Review["kind"]) => void;
}) {
  const { preview } = review;
  const install = useSkillsCommand("skills.install");
  const update = useSkillsCommand("skills.update");
  const commit = review.kind === "update" ? update : install;
  const first = preview.skills[0]?.name ?? "";
  const confirm = () => {
    const onSuccess = (result: SkillInstallResult) => {
      if (result.status === "installed")
        onDone(
          result.skills.map((s) => s.name),
          review.kind,
        );
    };
    if (review.kind === "update") {
      update.mutate({ name: first, confirm: preview.previewId }, { onSuccess });
    } else {
      install.mutate({ confirm: preview.previewId }, { onSuccess });
    }
  };
  const { source } = preview;
  return (
    <Block
      title={review.kind === "update" ? "Review the update" : "Review before installing"}
      note={`${plural(preview.skills.length, "skill")} found. Skills are instructions and files an agent follows, so only install ones you trust.`}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={commit.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} disabled={commit.isPending}>
            <Download aria-hidden="true" />
            {commit.isPending ? "Installing" : review.kind === "update" ? "Update" : "Install"}
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
        <dt className="text-fg-faint">Source</dt>
        <dd className="min-w-0">
          <SourceLink source={source.source} />
        </dd>
        <dt className="text-fg-faint">Kind</dt>
        <dd className="text-fg-soft">{source.sourceType}</dd>
        {source.ref && (
          <>
            <dt className="text-fg-faint">Ref</dt>
            <dd className="font-mono text-fg-soft">{source.ref}</dd>
          </>
        )}
        {source.commit && (
          <>
            <dt className="text-fg-faint">Commit</dt>
            <dd className="font-mono text-fg-soft">{source.commit.slice(0, 12)}</dd>
          </>
        )}
      </dl>
      <ul aria-label="Skills in this source" className="flex flex-col gap-2.5">
        {preview.skills.map((skill) => (
          <li
            key={skill.name}
            className="flex flex-col gap-1.5 rounded-lg border border-line-strong bg-field p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-medium text-fg">{skill.name}</span>
              {skill.replaces && (
                <Badge tone="amber" title={`Installed from ${skill.replaces.source}`}>
                  Replaces the installed copy
                </Badge>
              )}
              <span className="ml-auto text-sm text-fg-faint">{plural(skill.files.length, "file")}</span>
            </div>
            <p className="text-base text-fg-muted text-pretty">{skill.description}</p>
            <NameList label={`Files of ${skill.name}`} names={skill.files.map((f) => f.path)} />
            {skill.replaces && skill.replaces.source !== source.source && (
              <p className="text-sm text-amber text-pretty">
                The installed copy came from {skill.replaces.source}. This one comes from {source.source}.
              </p>
            )}
          </li>
        ))}
      </ul>
      {commit.error && <ErrorLine>{describeError(commit.error)}</ErrorLine>}
    </Block>
  );
}

function Browse({
  installed,
  onPreview,
}: {
  installed: readonly Skill[];
  onPreview: (p: SkillPreview) => void;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const search = useSkillSearch(query);
  const install = useSkillsCommand("skills.install");
  const [from, setFrom] = useState<string>();
  const pick = (result: SkillSearchResult) => {
    setFrom(result.id);
    install.mutate(
      { source: result.install.source, ...(result.install.skill ? { skill: result.install.skill } : {}) },
      { onSuccess: (r) => r.status === "preview" && onPreview(r) },
    );
  };
  return (
    <Block
      title="Browse"
      note="Search the skills.sh directory. Each result names its source repo: read it before you install."
    >
      <form
        className="flex gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(text);
        }}
      >
        <label htmlFor="skill-search" className="sr-only">
          Search skills
        </label>
        <Input
          id="skill-search"
          className="h-10 flex-1"
          placeholder="Search skills, like testing or react"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="lg" disabled={text.trim().length < 2}>
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>
      {search.isError && <ErrorLine>{describeError(search.error)}</ErrorLine>}
      {install.isError && <ErrorLine>{describeError(install.error)}</ErrorLine>}
      {search.isFetching && <Skeleton className="h-12 rounded-md" aria-busy="true" />}
      {search.data && !search.isFetching && (
        <>
          {search.data.length === 0 && <p className="text-base text-fg-faint">Nothing found for {query}.</p>}
          <ul aria-label="Search results" className="flex flex-col divide-y divide-line-strong">
            {search.data.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-mono text-base text-fg">{r.name}</span>
                  <span className="text-sm text-fg-muted">
                    from <SourceLink source={r.source} />
                    {r.installs !== undefined && ` · ${r.installs.toLocaleString()} installs`}
                  </span>
                </div>
                {installed.some((s) => s.name === (r.install.skill ?? r.name)) ? (
                  <Badge tone="green">Installed</Badge>
                ) : (
                  <Button size="sm" disabled={install.isPending} onClick={() => pick(r)}>
                    {install.isPending && from === r.id ? "Fetching" : "Review"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Block>
  );
}

function Installed({
  skills,
  error,
  agents,
  onUpdatePreview,
}: {
  skills: readonly Skill[] | undefined;
  error: string | undefined;
  agents: readonly AgentChoice[];
  onUpdatePreview: (p: SkillPreview) => void;
}) {
  const enable = useSkillsCommand("skills.enable");
  const disable = useSkillsCommand("skills.disable");
  const update = useSkillsCommand("skills.update");
  const remove = useSkillsCommand("skills.remove");
  const toast = useToast();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [updating, setUpdating] = useState<string>();
  const [removing, setRemoving] = useState<Skill>();
  const key = (name: string, agent: string) => `${name}:${agent}`;

  const toggle = (skill: Skill, agent: string, next: boolean) => {
    setPending((prev) => new Set(prev).add(key(skill.name, agent)));
    (next ? enable : disable).mutate(
      { name: skill.name, agent },
      {
        onError: (e) =>
          toast(`Could not change ${skill.name} for @${agent}`, { detail: describeError(e), tone: "error" }),
        onSettled: () =>
          setPending((prev) => {
            const copy = new Set(prev);
            copy.delete(key(skill.name, agent));
            return copy;
          }),
      },
    );
  };
  const refresh = (skill: Skill) => {
    setUpdating(skill.name);
    update.mutate(
      { name: skill.name },
      {
        onSuccess: (r) => {
          if (r.status === "preview") onUpdatePreview(r);
          else toast(`${skill.name} is already the newest copy.`);
        },
        onError: (e) => toast(`Could not check ${skill.name}`, { detail: describeError(e), tone: "error" }),
        onSettled: () => setUpdating(undefined),
      },
    );
  };

  return (
    <Block
      title="Installed"
      note="Skills in ~/.majhi/skills. An agent gets only the ones turned on for it, in its next run."
    >
      {error && <ErrorLine>Could not load skills: {error}</ErrorLine>}
      {skills === undefined && !error && <Skeleton className="h-16 rounded-md" aria-busy="true" />}
      {skills?.length === 0 && <p className="text-base text-fg-faint">No skills installed yet.</p>}
      <ul aria-label="Installed skills" className="flex flex-col divide-y divide-line-strong">
        {skills?.map((skill) => (
          <li key={skill.name} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-base font-medium text-fg">{skill.name}</span>
              <Badge>{skill.sourceType}</Badge>
              <span className="text-sm text-fg-faint">{plural(skill.files.length, "file")}</span>
              <div className="ml-auto flex gap-1.5">
                <Button
                  size="sm"
                  disabled={updating !== undefined}
                  onClick={() => refresh(skill)}
                  aria-label={`Update ${skill.name}`}
                >
                  <RefreshCw aria-hidden="true" />
                  {updating === skill.name ? "Checking" : "Update"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRemoving(skill)}
                  aria-label={`Remove ${skill.name}`}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              </div>
            </div>
            <p className="text-base text-fg-muted text-pretty">{skill.description}</p>
            <p className="text-sm text-fg-faint">
              From <SourceLink source={skill.source} />
              {skill.commit && ` at ${skill.commit.slice(0, 7)}`}
              {skill.agents.length > 0
                ? ` · used by ${skill.agents.map((a) => `@${a}`).join(", ")}`
                : " · not turned on for any agent"}
            </p>
            <AgentToggles
              agents={agents}
              on={skill.agents}
              noun="skill"
              pending={new Set(agents.filter((a) => pending.has(key(skill.name, a.id))).map((a) => a.id))}
              onToggle={(agent, next) => toggle(skill, agent, next)}
            />
          </li>
        ))}
      </ul>
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          body={
            removing.agents.length === 0
              ? "No agent uses it. The files are deleted from ~/.majhi/skills."
              : `It is deleted from ~/.majhi/skills, and ${removing.agents.map((a) => `@${a}`).join(", ")} lose${removing.agents.length === 1 ? "s" : ""} it.`
          }
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error ? describeError(remove.error) : undefined}
          onCancel={() => {
            remove.reset();
            setRemoving(undefined);
          }}
          onConfirm={() =>
            remove.mutate({ name: removing.name }, { onSuccess: () => setRemoving(undefined) })
          }
        />
      )}
    </Block>
  );
}
