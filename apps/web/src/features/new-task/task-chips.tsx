import type { TaskSummary } from "@majhi/shared";
import { ChoiceChip } from "@/components/ui/choice-chip";

/**
 * Open tasks as chips, as in the demo's "Depends on" row: None, then one chip per task.
 * `selected` is a list; with `single` a new pick replaces the old one.
 */
export function TaskChips({
  label,
  tasks,
  selected,
  onChange,
  single = false,
}: {
  label: string;
  tasks: readonly TaskSummary[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  single?: boolean;
}) {
  return (
    <fieldset
      aria-label={label}
      className="m-0 flex max-h-[104px] min-w-0 flex-wrap gap-1.5 overflow-y-auto border-0 p-0"
    >
      <ChoiceChip
        pressed={selected.length === 0}
        className="h-8 rounded-lg px-2.5 text-xs"
        onClick={() => onChange([])}
      >
        None
      </ChoiceChip>
      {tasks.map((t) => {
        const on = selected.includes(t.id);
        return (
          <ChoiceChip
            key={t.id}
            pressed={on}
            title={t.title}
            className="h-8 max-w-[240px] rounded-lg px-2.5 text-xs"
            onClick={() =>
              onChange(
                single ? (on ? [] : [t.id]) : on ? selected.filter((x) => x !== t.id) : [...selected, t.id],
              )
            }
          >
            <span className="font-mono">{t.id}</span>
            <span className="min-w-0 truncate text-fg-faint">{t.title}</span>
          </ChoiceChip>
        );
      })}
    </fieldset>
  );
}
