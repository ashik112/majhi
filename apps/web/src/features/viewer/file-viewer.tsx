import type { RoomItem } from "@majhi/shared";
import { codeLanguageOf, taskFileUrl, type ViewerKind, viewerKindOfPath } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, ExternalLink, RefreshCw, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { dirOf } from "@/features/room/links";
import { Markdown } from "@/features/room/markdown";
import { formatAgo, formatBytes } from "@/lib/format";
import { useCopy } from "@/lib/use-copy";
import type { AppSearch } from "@/router";
import { CodeView } from "./code-view";
import { fileEditStamp, TEXT_LIMIT } from "./model";
import { useFileMeta, useFileText } from "./use-task-file";

type Mode = "rendered" | "raw";

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
}: {
  taskId: string;
  folder: string;
  path: string;
  items: readonly RoomItem[];
}) {
  const navigate = useNavigate();
  const close = () =>
    navigate({
      to: ".",
      search: (prev: AppSearch) => {
        const { file: _open, ...rest } = prev;
        return rest;
      },
    });
  return (
    <Modal
      label={`File ${path}`}
      onClose={close}
      className="fixed top-0 right-0 bottom-0 left-auto m-0 h-dvh max-h-none w-[60vw] min-w-[min(560px,100vw)] max-w-none flex-col open:flex rounded-none rounded-l-2xl border-y-0 border-r-0 bg-canvas"
    >
      <Viewer taskId={taskId} folder={folder} path={path} items={items} onClose={close} />
    </Modal>
  );
}

function Viewer({
  taskId,
  folder,
  path,
  items,
  onClose,
}: {
  taskId: string;
  folder: string;
  path: string;
  items: readonly RoomItem[];
  onClose: () => void;
}) {
  const kind = viewerKindOfPath(path);
  const stamp = useMemo(() => fileEditStamp(items, folder, path), [items, folder, path]);
  const meta = useFileMeta(taskId, path, stamp);
  const wantsText = kind === "markdown" || kind === "text" || kind === "page";
  const text = useFileText(taskId, path, stamp, wantsText);
  const copy = useCopy();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("rendered");
  // A new file starts rendered again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the path changes
  useEffect(() => setMode("rendered"), [path]);

  const url = taskFileUrl(taskId, path);
  const name = path.split("/").pop() ?? path;
  const refreshing = meta.isFetching || text.isFetching;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["task-file", "meta", taskId, path] });
    await queryClient.invalidateQueries({ queryKey: ["task-file", "text", taskId, path] });
  }

  const error = meta.error ?? text.error;
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
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close viewer" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kind === "markdown" && (
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
          <Button asChild size="sm" variant="secondary">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              Open in new tab
            </a>
          </Button>
          <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing}>
            <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <Notice title="Could not open this file">{error.message}</Notice>
        ) : (
          <Body
            taskId={taskId}
            folder={folder}
            path={path}
            kind={kind}
            mode={mode}
            url={url}
            name={name}
            text={text.data}
            loading={wantsText ? text.isPending : meta.isPending}
          />
        )}
      </div>
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
  path,
  kind,
  mode,
  url,
  name,
  text,
  loading,
}: {
  taskId: string;
  folder: string;
  path: string;
  kind: ViewerKind;
  mode: Mode;
  url: string;
  name: string;
  text: ReturnType<typeof useFileText>["data"];
  loading: boolean;
}) {
  const task = useMemo(() => ({ id: taskId, folder }), [taskId, folder]);
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
      <CodeView text={text.text} lang={codeLanguageOf(path)} label={name} />
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
