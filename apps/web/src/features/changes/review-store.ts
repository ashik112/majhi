import { useSyncExternalStore } from "react";
import { z } from "zod";
import type { ReviewComment } from "./model";

/** A task's review in progress: the comments and the overall note, kept until it is sent. */
export interface ReviewDraft {
  note: string;
  comments: readonly ReviewComment[];
}

const EMPTY: ReviewDraft = { note: "", comments: [] };

const DraftSchema = z.object({
  note: z.string().default(""),
  comments: z.array(
    z.object({
      id: z.string(),
      repo: z.string(),
      path: z.string(),
      side: z.enum(["new", "old"]),
      line: z.number().int(),
      kind: z.enum(["add", "ctx", "del"]),
      text: z.string(),
      body: z.string(),
    }),
  ),
});

/** The part of `Storage` the store uses. Storage can be blocked: then drafts last until the page reloads. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyOf = (task: string) => `majhi.review.${task}`;

let counter = 0;
function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Review drafts per task id, outside any component so they outlive a tab switch, and in storage so
 * they outlive a reload. Snapshots are stable objects, replaced on every change.
 */
export function createReviewStore(storage: DraftStorage | undefined) {
  const drafts = new Map<string, ReviewDraft>();
  const listeners = new Set<() => void>();

  function load(task: string): ReviewDraft {
    try {
      const raw = storage?.getItem(keyOf(task));
      if (raw) {
        const parsed = DraftSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      }
    } catch {
      // Blocked or corrupt: start empty.
    }
    return EMPTY;
  }

  function get(task: string): ReviewDraft {
    let draft = drafts.get(task);
    if (!draft) {
      draft = load(task);
      drafts.set(task, draft);
    }
    return draft;
  }

  function set(task: string, draft: ReviewDraft): void {
    // The note shows only beside comments, so it goes with the last one rather than linger unseen.
    const empty = draft.comments.length === 0;
    drafts.set(task, empty ? EMPTY : draft);
    try {
      if (empty) storage?.removeItem(keyOf(task));
      else storage?.setItem(keyOf(task), JSON.stringify(draft));
    } catch {
      // Not saved to storage; the draft still holds for this visit.
    }
    for (const listener of listeners) listener();
  }

  return {
    get,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(task: string, comment: Omit<ReviewComment, "id">): ReviewComment {
      const added = { ...comment, id: newId() };
      const draft = get(task);
      set(task, { ...draft, comments: [...draft.comments, added] });
      return added;
    },
    edit(task: string, id: string, body: string): void {
      const draft = get(task);
      set(task, { ...draft, comments: draft.comments.map((c) => (c.id === id ? { ...c, body } : c)) });
    },
    remove(task: string, id: string): void {
      const draft = get(task);
      set(task, { ...draft, comments: draft.comments.filter((c) => c.id !== id) });
    },
    setNote(task: string, note: string): void {
      set(task, { ...get(task), note });
    },
    /** After a review is sent or discarded. */
    clear(task: string): void {
      set(task, EMPTY);
    },
  };
}

export type ReviewStore = ReturnType<typeof createReviewStore>;

function browserStorage(): DraftStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export const reviewStore = createReviewStore(browserStorage());

/** The task's review draft, live. */
export function useReviewDraft(task: string): ReviewDraft {
  return useSyncExternalStore(reviewStore.subscribe, () => reviewStore.get(task));
}
