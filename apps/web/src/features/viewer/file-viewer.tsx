import type { RoomItem, TaskRepo } from "@majhi/shared";
import { codeLanguageOf, type ViewerKind, viewerKindOfPath } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, ExternalLink, RefreshCw, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { OpenInEditor } from "@/components/open-in-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { DiffView } from "@/features/room/diff-view";
import { dirOf } from "@/features/room/links";
import { Markdown } from "@/features/room/markdown";
import { formatAgo, formatBytes } from "@/lib/format";
import { useCopy } from "@/lib/use-copy";
import type { AppSearch } from "@/router";
import { CodeView } from "./code-view";
import {
  type FileRef,
  fileEditStamp,
  fileRefParam,
  fileRefUrl,
  findChange,
  parseFileRef,
  TEXT_LIMIT,
  type ViewerCite,
} from "./model";
import { useFileMeta, useFileText, useResolvedRef } from "./use-task-file";

type Mode = "rendered" | "raw";
type ChangeView = "changes" | "full";
type DiffContentLike = Parameters<typeof DiffView>[0]["diff"];

/**
 * The file viewer: a drawer over the task view, opened by `?file=<path>`. Markdown is rendered
 * (or shown raw), code is highlighted, and pages and svg are never shown here: they run only in
 * the sandboxed tab the "Open page" button opens.
 */
export function FileViewer({
  taskId,
  folder,
  path,
  items,
  repos,
}: {
  taskId: string;
  folder: string;
  /** The `?file=` value. */
  path: string;
  items: readonly RoomItem[];
  repos: readonly TaskRepo[];
}) {
  const navigate = useNavigate();
  const close = () =>
    navigate({
      to: ".",
      search: (prev: AppSearch) => {
        const { file: _open, fileTask: _task, ...rest } = prev;
        return rest;
      },
    });
  return (
    <Modal
      label={`File ${parseFileRef(path).path}`}
      onClose={close}
      className="fixed top-3 right-3 bottom-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none w-[60vw] min-w-[min(560px,100vw)] max-w-[calc(100vw-24px)] flex-col open:flex rounded-2xl"
    >
      <Resolving taskId={taskId} folder={folder} param={path} items={items} repos={repos} onClose={close} />
    </Modal>
  );
}

/** A path from a brief or a message may be in the task folder or in a repo: find where, then show it. */
function Resolving({
  taskId,
  folder,
  param,
  items,
  repos,
  onClose,
}: {
  taskId: string;
  folder: string;
  param: string;
  items: readonly RoomItem[];
  repos: readonly TaskRepo[];
  onClose: () => void;
}) {
  const requested = useMemo(() => parseFileRef(param), [param]);
  const projects = useMemo(() => repos.map((r) => r.project), [repos]);
  const resolved = useResolvedRef(taskId, requested, projects);
  if (resolved.isPending && resolved.fetchStatus !== "idle") {
    return (
      <div role="status" aria-busy="true" className="p-6 text-base text-fg-faint">
        Looking for {requested.path}
      </div>
    );
  }
  const ref = resolved.data ?? requested;
  return (
    <Viewer
      key={fileRefParam(ref)}
      taskId={taskId}
      folder={folder}
      fileRef={ref}
      items={items}
      repos={repos}
      onClose={onClose}
    />
  );
}

/** The viewer's content: the header and the file. A task's drawer and a wiki source both put it in a modal. */
export function Viewer({
  taskId,
  folder,
  fileRef,
  items,
  repos,
  cite,
  onClose,
}: {
  taskId: string;
  folder: string;
  fileRef: FileRef;
  items: readonly RoomItem[];
  repos: readonly TaskRepo[];
  /** A wiki source: the cited lines are marked and the view scrolls to them. */
  cite?: ViewerCite;
  onClose: () => void;
}) {
  const path = fileRef.path;
  // A changed file is read from the task folder (its worktree lives there) for the full view.
  const source: FileRef = useMemo(
    () => (fileRef.kind === "changes" ? { kind: "task", path } : fileRef),
    [fileRef, path],
  );
  const change = useMemo(
    () => (fileRef.kind === "changes" ? findChange(items, repos, folder, path) : undefined),
    [fileRef.kind, items, repos, folder, path],
  );
  const [view, setView] = useState<ChangeView>("changes");
  const showingDiff = fileRef.kind === "changes" && view === "changes";
  const kind = viewerKindOfPath(path);
  const stamp = useMemo(
    () => (source.kind === "task" ? fileEditStamp(items, folder, path) : undefined),
    [items, folder, path, source.kind],
  );
  const meta = useFileMeta(taskId, source, stamp);
  const wantsText = !showingDiff && (kind === "markdown" || kind === "text" || kind === "page");
  const text = useFileText(taskId, source, stamp, wantsText);
  const copy = useCopy();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("rendered");

  const url = fileRefUrl(taskId, source);
  const name = path.split("/").pop() ?? path;
  const refreshing = meta.isFetching || text.isFetching;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["task-file", "meta", taskId] });
    await queryClient.invalidateQueries({ queryKey: ["task-file", "text", taskId] });
  }

  const error = showingDiff ? undefined : (meta.error ?? text.error);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-2.5 border-b border-line-strong px-5 pt-3.5 pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-md font-semibold" title={name}>
              {name}
            </h2>
            <p className="tnum truncate font-mono text-xs text-fg-faint" title={path}>
              {path}
              {meta.data && (
                <>
                  {" · "}
                  {formatBytes(meta.data.size)}
                  {" · "}
                  <span title={new Date(meta.data.modified).toLocaleString()}>
                    modified {formatAgo(meta.data.modified, Date.now())}
                  </span>
                </>
              )}
            </p>
            {cite !== undefined && <CiteTags path={path} cite={cite} />}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close viewer" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {fileRef.kind === "changes" && (
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              segments={[
                { value: "changes", label: "Changes" },
                { value: "full", label: "Full file" },
              ]}
            />
          )}
          {kind === "markdown" && !showingDiff && (
            <Segmented
              label="View as"
              value={mode}
              onChange={setMode}
              segments={[
                { value: "rendered", label: "Rendered" },
                { value: "raw", label: "Raw" },
              ]}
            />
          )}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => copy(path)}>
            <Copy aria-hidden="true" />
            Copy path
          </Button>
          {fileRef.kind !== "repo" && fileRef.kind !== "wiki" && (
            <OpenInEditor path={path.startsWith("/") ? path : `${folder}/${path}`} />
          )}
          <Button asChild size="sm" variant="secondary">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              Open in new tab
            </a>
          </Button>
          {fileRef.kind !== "wiki" && (
            <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing}>
              <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />
              Refresh
            </Button>
          )}
        </div>
      </header>
      {cite?.changed === true && (
        <p
          role="status"
          className="shrink-0 border-b border-amber-line bg-amber-wash px-5 py-2 text-sm text-fg-soft"
        >
          Changed in a newer commit. The lines may have moved.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {showingDiff ? (
          <Diffs diffs={change?.diffs ?? []} deleted={change?.change === "delete"} />
        ) : error ? (
          <Notice title="Could not open this file">{error.message}</Notice>
        ) : (
          <Body
            taskId={taskId}
            folder={folder}
            fileRef={source}
            path={path}
            kind={kind}
            mode={mode}
            url={url}
            name={name}
            text={text.data}
            loading={wantsText ? text.isPending : meta.isPending}
            mark={cite?.lines}
          />
        )}
      </div>
    </div>
  );
}

/** The small tags under a wiki source's path: what it cites, at which commit, and that it is read only. */
function CiteTags({ path, cite }: { path: string; cite: ViewerCite }) {
  const language = codeLanguageOf(path);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5">
      {language !== undefined && <Badge mono>{language}</Badge>}
      <Badge mono>
        {cite.lines[0] === cite.lines[1]
          ? `line ${cite.lines[0]}`
          : `lines ${cite.lines[0]}-${cite.lines[1]}`}{" "}
        cited
      </Badge>
      <Badge mono>{cite.commit.slice(0, 7)}</Badge>
      <Badge>read only</Badge>
    </p>
  );
}

function Diffs({ diffs, deleted }: { diffs: readonly DiffContentLike[]; deleted: boolean }) {
  if (diffs.length === 0) {
    return (
      <Notice title={deleted ? "This file was deleted" : "No recorded edits"}>
        Switch to Full file to read it as it is now.
      </Notice>
    );
  }
  return (
    // A block, not a flex column: flex items with overflow hidden shrink to fit and clip, so nothing scrolled.
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
      {diffs.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: edits to one file keep their order
        <DiffView key={i} diff={d} compact fill />
      ))}
    </div>
  );
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-[420px] flex-col gap-1 text-center">
        <h3 className="text-body font-semibold">{title}</h3>
        {children && <p className="text-base text-fg-muted text-pretty">{children}</p>}
      </div>
    </div>
  );
}

function Body({
  taskId,
  folder,
  fileRef,
  path,
  kind,
  mode,
  url,
  name,
  text,
  loading,
  mark,
}: {
  taskId: string;
  folder: string;
  fileRef: FileRef;
  path: string;
  kind: ViewerKind;
  mode: Mode;
  url: string;
  name: string;
  text: ReturnType<typeof useFileText>["data"];
  loading: boolean;
  mark?: readonly [number, number] | undefined;
}) {
  // Links inside a file of a repo point into that repo, which the viewer does not follow.
  const task = useMemo(
    () => (fileRef.kind === "repo" || fileRef.kind === "wiki" ? undefined : { id: taskId, folder }),
    [taskId, folder, fileRef.kind],
  );
  if (kind === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-sunken p-4">
        <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (kind === "pdf") {
    return <iframe title={name} src={url} className="min-h-0 flex-1 border-0 bg-sunken" />;
  }
  if (kind === "video") {
    return (
      <div className="flex flex-1 items-center justify-center bg-sunken p-4">
        {/* biome-ignore lint/a11y/useMediaCaption: agent-made clips have no caption track */}
        <video controls src={url} aria-label={name} className="max-h-full max-w-full" />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        {/* biome-ignore lint/a11y/useMediaCaption: agent-made audio has no caption track */}
        <audio controls src={url} aria-label={name} className="w-full max-w-[480px]" />
      </div>
    );
  }
  if (loading || text === undefined) {
    return (
      <div role="status" aria-busy="true" className="p-6 text-base text-fg-faint">
        Loading {name}
      </div>
    );
  }
  if (text.binary) {
    return (
      <Notice title="This file is not text">
        majhi cannot show it here. Open it in a new tab or copy its path.
      </Notice>
    );
  }
  const limited = text.truncated && (
    <p
      role="status"
      className="shrink-0 border-b border-amber-line bg-amber-wash px-4 py-1.5 text-sm text-amber"
    >
      Showing the first {formatBytes(TEXT_LIMIT)} of {formatBytes(text.total)}. Open in a new tab for the
      rest.
    </p>
  );
  if (kind === "markdown" && mode === "rendered") {
    return (
      <>
        {limited}
        <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
          {text.text.trim() === "" ? (
            <p className="text-base text-fg-faint">This file is empty.</p>
          ) : (
            <div className="mx-auto max-w-[780px]">
              <Markdown text={text.text} task={task} baseDir={dirOf(path)} size="document" />
            </div>
          )}
        </div>
      </>
    );
  }
  const source = (
    <>
      {limited}
      <CodeView text={text.text} lang={codeLanguageOf(path)} label={name} mark={mark} />
    </>
  );
  if (kind === "page") {
    return (
      <>
        <div className="flex shrink-0 items-center gap-3 border-b border-line-strong px-4 py-2.5">
          <Button asChild size="sm" variant="primary">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              Open page
            </a>
          </Button>
          <p className="min-w-0 text-sm text-fg-muted text-pretty">
            Pages run in their own tab, sandboxed, and cannot reach majhi. Below is the source.
          </p>
        </div>
        {source}
      </>
    );
  }
  return source;
}
