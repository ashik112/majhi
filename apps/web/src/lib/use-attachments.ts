import { ATTACHMENT_TYPES_TEXT, type Attachment, attachmentAllowed, UPLOAD_MAX_BYTES } from "@majhi/shared";
import { type DragEvent, useCallback, useRef, useState } from "react";
import { uploadFile } from "./api";

export interface PendingAttachment {
  key: string;
  name: string;
  state: "uploading" | "ready" | "error";
  attachment?: Attachment;
  error?: string;
}

/** Files from a paste or drop event: images and files, in the order they came. */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files);
}

/** Why a file cannot be attached, or undefined when it can. Mirrors the server's checks so the reason shows at once. */
export function attachmentProblem(file: File): string | undefined {
  if (file.size > UPLOAD_MAX_BYTES)
    return `"${file.name}" is larger than ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB, the limit.`;
  if (!attachmentAllowed(file.name, file.type)) {
    return `"${file.name}" is not an allowed file type. Allowed: ${ATTACHMENT_TYPES_TEXT}.`;
  }
  return undefined;
}

export function attachmentIds(items: readonly PendingAttachment[]): string[] {
  return items.flatMap((item) => (item.attachment ? [item.attachment.id] : []));
}

/** Uploads files as they are added and keeps the list of chips. Ids go to `tasks.create` or `room.send`. */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const counter = useRef(0);

  const add = useCallback((files: readonly File[]) => {
    for (const file of files) {
      counter.current += 1;
      const key = `up-${counter.current}`;
      const patch = (next: Partial<PendingAttachment>) =>
        setItems((list) => list.map((item) => (item.key === key ? { ...item, ...next } : item)));
      const problem = attachmentProblem(file);
      if (problem) {
        setItems((list) => [...list, { key, name: file.name, state: "error", error: problem }]);
        continue;
      }
      setItems((list) => [...list, { key, name: file.name, state: "uploading" }]);
      uploadFile(file).then(
        (attachment) => patch({ state: "ready", attachment }),
        (error: unknown) =>
          patch({ state: "error", error: error instanceof Error ? error.message : "Upload failed" }),
      );
    }
  }, []);

  const remove = useCallback(
    (key: string) => setItems((list) => list.filter((item) => item.key !== key)),
    [],
  );
  const clear = useCallback(() => setItems([]), []);
  return { items, add, remove, clear, uploading: items.some((item) => item.state === "uploading") };
}

/**
 * Props that make an element accept dropped files, and whether a file is being dragged over it.
 * Only drags that carry files count, so dragging text around the page does nothing.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave also fire for every child element, so count them.
  const depth = useRef(0);
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  const dropProps = {
    onDragEnter(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave(event: DragEvent) {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      onFiles(filesFromClipboard(event.dataTransfer));
    },
  };
  return { dragging, dropProps };
}
