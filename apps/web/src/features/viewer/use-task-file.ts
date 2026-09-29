import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { type FileRef, fileCandidates, fileRefParam, fileRefUrl, looksBinary, TEXT_LIMIT } from "./model";

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

async function fetchMeta(taskId: string, ref: FileRef): Promise<FileMeta> {
  const res = await fetch(`${fileRefUrl(taskId, ref)}?meta=1`, { cache: "no-store" });
  if (!res.ok) throw await failure(res);
  return MetaSchema.parse(await res.json());
}

async function fetchText(taskId: string, ref: FileRef): Promise<FileText> {
  const res = await fetch(fileRefUrl(taskId, ref), {
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
function keepSameFile<T>(key: string) {
  return (previous: T | undefined, query: { queryKey: readonly unknown[] } | undefined) =>
    query?.queryKey[3] === key ? previous : undefined;
}

/**
 * Finds the place a file is in: the one `?file=` names, else the task folder or another repo of
 * the task. A path in a brief or a message may live in either.
 */
export function useResolvedRef(taskId: string, ref: FileRef, projects: readonly string[]) {
  const candidates = fileCandidates(ref, projects);
  return useQuery({
    queryKey: ["task-file", "resolve", taskId, fileRefParam(ref), projects.join(",")],
    queryFn: async (): Promise<FileRef> => {
      for (const candidate of candidates) {
        const found = await fetchMeta(taskId, candidate).then(
          () => true,
          () => false,
        );
        if (found) return candidate;
      }
      return ref;
    },
    enabled: candidates.length > 1,
    staleTime: 30_000,
    retry: false,
  });
}

/** `stamp` changes when the agent edits the file; a new stamp loads it again. */
export function useFileMeta(taskId: string, ref: FileRef, stamp: string | undefined) {
  const key = fileRefParam(ref);
  return useQuery({
    queryKey: ["task-file", "meta", taskId, key, stamp ?? ""],
    queryFn: () => fetchMeta(taskId, ref),
    placeholderData: keepSameFile<FileMeta>(key),
    retry: false,
  });
}

export function useFileText(taskId: string, ref: FileRef, stamp: string | undefined, enabled: boolean) {
  const key = fileRefParam(ref);
  return useQuery({
    queryKey: ["task-file", "text", taskId, key, stamp ?? ""],
    queryFn: () => fetchText(taskId, ref),
    placeholderData: keepSameFile<FileText>(key),
    enabled,
    retry: false,
  });
}
