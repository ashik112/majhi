import { type MediaRef, mediaKindOfPath, taskFileUrl, type ViewerKind } from "@majhi/shared";
import { Link, useRouterState } from "@tanstack/react-router";
import { ExternalLink, FileCode2, FileText, Film, Globe, ImageIcon, Music } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";

/** The task whose room is showing, so a file link opens the viewer on any page. */
export const RoomTaskContext = createContext<string | undefined>(undefined);

import { createPortal } from "react-dom";
import { Modal } from "@/components/ui/modal";

/** What the room needs to show a task's files: its id for the files endpoint, and its folder to read absolute paths. */
export interface TaskFiles {
  id: string;
  folder: string;
  /** Links to files open them from this project (its worktree, else its checkout). */
  project?: string | undefined;
  /** Called when media finished loading, so the room can stay at the bottom. */
  onLoad?: () => void;
}

const isTaskUrl = (src: string) => src.startsWith("/api/tasks/");

/** An image at most 480 px wide. Click opens it full size; Esc closes. */
export function ImageView({
  src,
  alt,
  onLoad,
}: {
  src: string;
  alt: string;
  onLoad?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const label = alt || "image";
  return (
    <>
      <button
        type="button"
        aria-label={`View ${label} full size`}
        onClick={() => setOpen(true)}
        className="block max-w-full cursor-zoom-in rounded-md border border-line-strong bg-sunken p-0 hover:border-line-hover"
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={onLoad}
          className="block max-h-[320px] max-w-[min(480px,100%)] rounded-md object-contain"
        />
      </button>
      {open &&
        // The dialog sits in the top layer; a portal keeps it out of the paragraph the image is in.
        createPortal(
          <Modal label={label} onClose={() => setOpen(false)} className="bg-sunken">
            <img
              src={src}
              alt={alt}
              className="block max-h-[calc(100dvh-64px)] max-w-[calc(100vw-64px)] object-contain"
            />
          </Modal>,
          document.body,
        )}
    </>
  );
}

function VideoView({ src, name, onLoad }: { src: string; name: string; onLoad?: (() => void) | undefined }) {
  return (
    // biome-ignore lint/a11y/useMediaCaption: agent-made clips have no caption track
    <video
      controls
      preload="metadata"
      aria-label={name}
      src={src}
      onLoadedMetadata={onLoad}
      className="block max-h-[320px] max-w-[min(480px,100%)] rounded-md border border-line-strong bg-sunken"
    />
  );
}

function AudioView({ src, name }: { src: string; name: string }) {
  return (
    // biome-ignore lint/a11y/useMediaCaption: agent-made audio has no caption track
    <audio controls preload="metadata" aria-label={name} src={src} className="block w-[min(360px,100%)]" />
  );
}

/** A compact card for a page, file or link. It opens in a new tab; pages run sandboxed. */
export function FileCard({ href, name, kind }: { href: string; name: string; kind: MediaRef["kind"] }) {
  const Icon =
    kind === "link"
      ? Globe
      : kind === "page"
        ? FileCode2
        : kind === "video"
          ? Film
          : kind === "audio"
            ? Music
            : FileText;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${name}`}
      className="inline-flex max-w-[min(360px,100%)] items-center gap-2 rounded-md border border-line-strong bg-card px-2.5 py-1.5 align-middle text-base text-fg-soft no-underline hover:border-line-hover hover:bg-raised"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <span className="min-w-0 truncate">{name}</span>
      <span className="ml-1 flex shrink-0 items-center gap-1 text-sm text-fg-faint">
        Open
        <ExternalLink aria-hidden="true" className="size-3" />
      </span>
    </a>
  );
}

const FILE_ICON = {
  markdown: FileText,
  pdf: FileText,
  text: FileCode2,
  page: FileCode2,
  image: ImageIcon,
  video: Film,
  audio: Music,
} as const;

/**
 * A link to a file of the task folder that opens in the in-app viewer (`?file=`). Inline, it is
 * text with a small icon and never changes the line height. As a card it stands on its own line.
 */
export function TaskFileLink({
  path,
  kind,
  label,
  card = false,
  project,
}: {
  path: string;
  kind: ViewerKind;
  label: ReactNode;
  card?: boolean;
  project?: string | undefined;
}) {
  const Icon = FILE_ICON[kind];
  const task = useContext(RoomTaskContext);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const file = project ? `repo:${project}/${path}` : path;
  // On the task's own page its viewer opens; anywhere else the app's viewer, told which task.
  const own = task === undefined || pathname.startsWith(`/t/${task}`);
  return (
    <Link
      to="."
      search={(prev: object) => ({ ...prev, file, ...(own ? {} : { fileTask: task }) })}
      title={path}
      aria-label={card && typeof label === "string" ? `Open ${label}` : undefined}
      className={card ? "md-file-card" : "md-link md-file-link"}
    >
      <Icon aria-hidden="true" className={card ? "size-4 shrink-0 text-fg-muted" : "md-file-icon"} />
      {card ? <span className="min-w-0 truncate">{label}</span> : label}
      {card && <span className="ml-1 shrink-0 text-sm text-fg-faint">View</span>}
    </Link>
  );
}

/** One file of the task folder or one web address, shown by what it is. */
export function MediaView({ media, onLoad }: { media: MediaRef; onLoad?: (() => void) | undefined }) {
  const local = isTaskUrl(media.src);
  if (local && media.kind === "image") return <ImageView src={media.src} alt={media.name} onLoad={onLoad} />;
  if (local && media.kind === "video") return <VideoView src={media.src} name={media.name} onLoad={onLoad} />;
  if (local && media.kind === "audio") return <AudioView src={media.src} name={media.name} />;
  // Web images and clips are not loaded into the room: the owner opens them on purpose.
  return (
    <FileCard
      href={media.src}
      name={media.name}
      kind={media.kind === "image" && !local ? "link" : media.kind}
    />
  );
}

/** Media from a markdown target that is a path in the task folder: `taskPath` is relative to it. */
export function TaskFileView({
  taskId,
  taskPath,
  name,
  onLoad,
}: {
  taskId: string;
  taskPath: string;
  name: string;
  onLoad?: (() => void) | undefined;
}) {
  const kind = mediaKindOfPath(taskPath);
  return <MediaView media={{ kind, name, src: taskFileUrl(taskId, taskPath) }} onLoad={onLoad} />;
}
