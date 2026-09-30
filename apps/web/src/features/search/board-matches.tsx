import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { orgSearch } from "@/lib/org-filter";
import { MIN_SEARCH_LENGTH, useRoomSearch } from "@/lib/search-queries";
import { HitRow } from "./hit-row";

/** Under the board's search field: messages and tool output in any room that match what is typed. */
export function BoardMatches({ query, org }: { query: string; org: string | undefined }) {
  const search = useRoomSearch(query, org);
  const hits = query.trim().length >= MIN_SEARCH_LENGTH ? (search.data ?? []) : [];
  if (hits.length === 0) return null;
  return (
    <section
      aria-label="Matches in messages and tool output"
      className={cn("shrink-0 rounded-2xl p-2", GLASS)}
    >
      <h2 className="px-3 py-1 text-xs font-semibold tracking-wide text-fg-faint uppercase">
        In messages and tool output
      </h2>
      <ul className="max-h-[28dvh] overflow-y-auto">
        {hits.map((hit) => (
          <li key={`${hit.task}:${hit.item}`}>
            <Link
              to="/t/$taskId"
              params={{ taskId: hit.task }}
              search={orgSearch(org)}
              className="block rounded-md px-3 py-2 outline-none hover:bg-selected/60 focus-visible:bg-selected"
            >
              <HitRow hit={hit} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
