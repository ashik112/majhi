import type { OrgView, Skill, SkillInstallResult, SkillPreview, SkillSearchResult } from "@majhi/shared";
import { Download, Search, Upload } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useSkillSearch, useSkillsCommand, useSkillZipPreview } from "@/lib/skills-queries";
import { Block, ErrorLine, NameList, SourceLink } from "./parts";

/** What the card on top shows: a preview, and whether committing it installs or updates. */
export interface Review {
  kind: "install" | "update";
  preview: SkillPreview;
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
      title="Add from link"
      note="A GitHub link, owner/repo, a git URL, a link to a SKILL.md or archive, or a folder path. Or drop a .zip. You review it before anything is installed."
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
      title="Discover"
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

export { Browse as SkillBrowse, InstallBox as SkillInstallBox, PreviewCard as SkillPreviewCard };
