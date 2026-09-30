import type { Fact, MemoryEvent } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { EventList } from "./event-list";
import { isAutomatic } from "./model";

const FIRST = 8;

/** What curation kept, dropped, retired or merged on its own, with the reason and Undo. */
export function AutoDecisions({
  events,
  facts,
  error,
}: {
  events: readonly MemoryEvent[];
  facts: ReadonlyMap<number, Fact>;
  error: Error | null;
}) {
  const [all, setAll] = useState(false);
  const auto = events.filter(isAutomatic);
  const shown = all ? auto : auto.slice(0, FIRST);
  return (
    <section aria-label="Recent automatic decisions" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-semibold">Recent automatic decisions</h2>
        <span className="text-sm text-fg-faint">
          Curation keeps, drops or merges lessons by itself. Only global lessons and contradictions wait for
          you. Undo puts any step back.
        </span>
      </div>
      {error && <p className="m-0 text-sm text-red">{describeError(error)}</p>}
      <EventList
        events={shown}
        facts={facts}
        label="Automatic decisions"
        empty="Nothing was decided automatically yet."
      />
      {auto.length > FIRST && (
        <div>
          <Button size="sm" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${auto.length}`}
          </Button>
        </div>
      )}
    </section>
  );
}
