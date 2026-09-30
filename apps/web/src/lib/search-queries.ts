import type { RoomSearchHit } from "@majhi/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/** Fewer letters than this match too much to be worth a request. */
export const MIN_SEARCH_LENGTH = 2;

/** The value, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Room items matching the typed words, across all tasks or one org's. Idle until there is enough to search. */
export function useRoomSearch(query: string, org: string | undefined) {
  const text = useDebounced(query.trim());
  const enabled = text.length >= MIN_SEARCH_LENGTH;
  return useQuery<RoomSearchHit[], ApiRequestError>({
    queryKey: [...queryKeys.tasks, "search", text, org ?? null],
    queryFn: () => cmd("room.search", { query: text, ...(org === undefined ? {} : { org }) }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
