import type { Cadence } from "@majhi/shared";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CADENCE_CHOICES, cadenceFrom, choiceOf, WEEKDAYS } from "./model";

/** The cadence as a menu, with a weekday and a time where the choice needs them. `onCommit` fires when a value is settled. */
export function CadenceFields({
  cadence,
  withEvents,
  onChange,
  onCommit,
}: {
  cadence: Cadence;
  withEvents: boolean;
  onChange: (next: Cadence) => void;
  onCommit?: (next: Cadence) => void;
}) {
  const choices = CADENCE_CHOICES.filter((c) => c.id !== "events" || withEvents);
  const commit = onCommit ?? (() => undefined);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Select
        aria-label="Runs"
        className="w-[200px]"
        value={choiceOf(cadence)}
        onChange={(e) => {
          const next = cadenceFrom(e.target.value, cadence);
          onChange(next);
          commit(next);
        }}
      >
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>
      {cadence.kind === "weekly" && (
        <Select
          aria-label="Day"
          className="w-[130px]"
          value={cadence.day}
          onChange={(e) => {
            const next = { ...cadence, day: Number(e.target.value) };
            onChange(next);
            commit(next);
          }}
        >
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </Select>
      )}
      {(cadence.kind === "daily" || cadence.kind === "weekly") && (
        <Input
          aria-label="Time"
          type="time"
          className="w-[120px]"
          value={cadence.at}
          onChange={(e) => e.target.value && onChange({ ...cadence, at: e.target.value })}
          onBlur={() => commit(cadence)}
        />
      )}
    </div>
  );
}
