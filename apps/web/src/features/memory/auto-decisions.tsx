import type { Fact, MemoryEvent } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { describeError } from "@/lib/errors";
import { EventList } from "./event-list";
import { isAutomatic } from "./model";

const FIRST = 6;

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
    <DetailSection
      title="Automatic decisions"
      note="Curation keeps, drops or merges lessons by itself. Undo puts any step back."
      actions={
        auto.length > FIRST && (
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${auto.length}`}
          </Button>
        )
      }
    >
      {error && <p className="text-sm text-red">{describeError(error)}</p>}
      <EventList
        flat
        events={shown}
        facts={facts}
        label="Automatic decisions"
        empty="Nothing was decided automatically yet."
      />
    </DetailSection>
  );
}
