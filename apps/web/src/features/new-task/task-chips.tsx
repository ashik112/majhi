import type { TaskSummary } from "@majhi/shared";
import { Plus, X } from "lucide-react";
import { Menu } from "@/components/ui/menu";

/**
 * A compact task picker: the chosen tasks as chips, and "Choose" for a menu of open tasks.
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
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const toggle = (id: string) => {
    const on = selected.includes(id);
    if (single) onChange(on ? [] : [id]);
    else onChange(on ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <fieldset aria-label={label} className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
      {selected.map((id) => (
        <span
          key={id}
          className="flex h-8 max-w-[280px] items-center gap-1.5 rounded-lg border border-blue-line bg-blue-wash pr-1 pl-2.5 text-xs"
        >
          <span className="shrink-0 whitespace-nowrap font-mono">{id}</span>
          <span className="min-w-0 truncate text-fg-muted">{byId.get(id)?.title}</span>
          <button
            type="button"
            aria-label={`Remove ${id}`}
            onClick={() => toggle(id)}
            className="grid size-6 cursor-pointer place-items-center rounded-sm text-fg-faint hover:text-fg"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      ))}
      <Menu
        label={`Choose ${label.toLowerCase()}`}
        align="left"
        items={tasks.map((t) => ({
          label: `${t.id} · ${t.title.length > 60 ? `${t.title.slice(0, 59)}…` : t.title}`,
          checked: selected.includes(t.id),
          onSelect: () => toggle(t.id),
        }))}
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            {...props}
            aria-label={`Choose ${label.toLowerCase()}`}
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line-control px-2.5 text-xs text-fg-muted hover:border-line-hover hover:text-fg"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {selected.length === 0 ? "Choose" : single ? "Change" : "Add"}
          </button>
        )}
      />
    </fieldset>
  );
}
