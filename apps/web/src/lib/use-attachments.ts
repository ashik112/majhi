import { type Attachment, UPLOAD_MAX_BYTES } from "@majhi/shared";
import { useCallback, useRef, useState } from "react";
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
      if (file.size > UPLOAD_MAX_BYTES) {
        setItems((list) => [...list, { key, name: file.name, state: "error", error: "Larger than 20 MB" }]);
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
