import { taskFileUrl } from "@majhi/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { looksBinary, TEXT_LIMIT } from "./model";

const MetaSchema = z.object({ size: z.number(), modified: z.string() });
export type FileMeta = z.infer<typeof MetaSchema>;

export interface FileText {
  text: string;
  /** Bytes in the file, which is more than `text` holds when it was cut at the limit. */
  total: number;
  truncated: boolean;
  binary: boolean;
}

async function failure(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = z.object({ error: z.string() }).safeParse(body);
  return new Error(parsed.success ? parsed.data.error : `The server answered ${res.status}.`);
}

async function fetchMeta(taskId: string, path: string): Promise<FileMeta> {
  const res = await fetch(`${taskFileUrl(taskId, path)}?meta=1`, { cache: "no-store" });
  if (!res.ok) throw await failure(res);
  return MetaSchema.parse(await res.json());
}

async function fetchText(taskId: string, path: string): Promise<FileText> {
  const res = await fetch(taskFileUrl(taskId, path), {
    cache: "no-store",
    headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` },
  });
  if (!res.ok) throw await failure(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const range = /\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "");
  const total = range ? Number(range[1]) : bytes.length;
  if (looksBinary(bytes)) return { text: "", total, truncated: false, binary: true };
  return {
    text: new TextDecoder("utf-8").decode(bytes),
    total,
    truncated: total > bytes.length,
    binary: false,
  };
}

/** Keeps the last answer for the same file while a newer one loads, so the view does not flash empty. */
function keepSameFile<T>(path: string) {
  return (previous: T | undefined, query: { queryKey: readonly unknown[] } | undefined) =>
    query?.queryKey[3] === path ? previous : undefined;
}

/** `stamp` changes when the agent edits the file; a new stamp loads it again. */
export function useFileMeta(taskId: string, path: string, stamp: string | undefined) {
  return useQuery({
    queryKey: ["task-file", "meta", taskId, path, stamp ?? ""],
    queryFn: () => fetchMeta(taskId, path),
    placeholderData: keepSameFile<FileMeta>(path),
    retry: false,
  });
}

export function useFileText(taskId: string, path: string, stamp: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["task-file", "text", taskId, path, stamp ?? ""],
    queryFn: () => fetchText(taskId, path),
    placeholderData: keepSameFile<FileText>(path),
    enabled,
    retry: false,
  });
}
