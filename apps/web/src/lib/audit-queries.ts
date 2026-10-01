import type { AuditList } from "@majhi/shared";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type { AuditFilters } from "@/features/audit/model";
import { listInput } from "@/features/audit/model";
import { type ApiRequestError, cmd } from "./api";

const PAGE = 100;

/** The audit log for these filters, newest first. Each page asks for the rows older than the last one. */
export function useAuditLog(filters: AuditFilters) {
  return useInfiniteQuery<AuditList, ApiRequestError, { pages: AuditList[] }, unknown[], number | undefined>({
    queryKey: ["audit", filters],
    queryFn: ({ pageParam }) =>
      cmd("audit.list", {
        ...listInput(filters),
        ...(pageParam === undefined ? {} : { before: pageParam }),
        limit: PAGE,
      }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}
