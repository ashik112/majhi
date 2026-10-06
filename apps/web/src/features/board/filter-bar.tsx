import { type OriginKind, TASK_TYPE_LABEL, TASK_TYPES, type TaskType } from "@majhi/shared";
import { ChevronDown } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Menu } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { ORIGIN_KINDS, ORIGIN_LABEL, OriginIcon } from "../tasks-ui/origin-mark";
import { TYPE_ICON, typeColor } from "../tasks-ui/type-meta";
import type { SectionId } from "./home-model";

/** A press with the mouse hands the keys back to the board (Enter, 1 to 3 skip a focused button); a key press keeps the focus. */
const handBack = (event: MouseEvent<HTMLButtonElement>) => {
  if (event.detail > 0) event.currentTarget.blur();
};

/** The three chip filters of the board. The workspace filter is the chips in the top bar. */
export interface Chips {
  type: TaskType | undefined;
  area: string | undefined;
  source: OriginKind | undefined;
}

export const NO_CHIPS: Chips = { type: undefined, area: undefined, source: undefined };

export const chipsActive = (chips: Chips): boolean =>
  chips.type !== undefined || chips.area !== undefined || chips.source !== undefined;

/** A section the owner turns on from the right of the bar, with how many rows it holds. */
export interface Toggle {
  section: SectionId;
  label: string;
  count: number;
  on: boolean;
}

const CHIP =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm whitespace-nowrap transition-colors duration-150";
const chipTone = (pressed: boolean) =>
  pressed
    ? "border-accent-line bg-accent-wash text-fg"
    : "border-line-strong bg-card text-fg-muted hover:border-line-hover hover:text-fg";

/** A pick-one filter as a button that opens a menu: its name and the current pick. */
function PickChip({
  label,
  value,
  all,
  items,
  disabled,
  title,
}: {
  label: string;
  /** The pick, or undefined for All. */
  value: string | undefined;
  all: { label: string; onSelect: () => void };
  items: readonly { label: string; checked: boolean; onSelect: () => void; icon?: ReactNode }[];
  disabled?: boolean | undefined;
  title?: string | undefined;
}) {
  return (
    <Menu
      label={label}
      align="left"
      maxHeight={360}
      items={[{ label: all.label, checked: value === undefined, onSelect: all.onSelect }, ...items]}
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          {...props}
          disabled={disabled}
          title={title}
          className={cn(CHIP, chipTone(value !== undefined), "disabled:cursor-default disabled:opacity-55")}
        >
          <span className="text-fg-faint">{label}</span>
          <b className="font-medium text-fg">{value ?? "All"}</b>
          <ChevronDown aria-hidden="true" className="size-3 text-fg-faint" />
        </button>
      )}
    />
  );
}

/**
 * The second line of the board's header: filter by type (an icon each, the pressed one names itself),
 * by area and by source, and at the right the sections kept out of the board until turned on.
 */
export function FilterBar({
  chips,
  onChips,
  areaNames,
  toggles,
  onToggle,
}: {
  chips: Chips;
  onChips: (next: Chips) => void;
  /** Every area some task on the board touches. Empty without a wiki. */
  areaNames: readonly string[];
  toggles: readonly Toggle[];
  onToggle: (section: SectionId) => void;
}) {
  return (
    <fieldset
      aria-label="Filters"
      className="m-0 flex min-w-0 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-0 px-3 py-1.5"
    >
      <span className="text-xs text-fg-faint">Type</span>
      <button
        type="button"
        aria-pressed={chips.type === undefined}
        onClick={(event) => {
          onChips({ ...chips, type: undefined });
          handBack(event);
        }}
        className={cn(CHIP, "px-2", chipTone(chips.type === undefined))}
      >
        All
      </button>
      {TASK_TYPES.map((type) => {
        const Icon = TYPE_ICON[type];
        const on = chips.type === type;
        return (
          <button
            key={type}
            type="button"
            aria-pressed={on}
            title={TASK_TYPE_LABEL[type]}
            aria-label={TASK_TYPE_LABEL[type]}
            onClick={(event) => {
              onChips({ ...chips, type: on ? undefined : type });
              handBack(event);
            }}
            className={cn(CHIP, "px-[7px]", chipTone(on))}
          >
            <Icon
              aria-hidden="true"
              className="size-4"
              style={{ color: typeColor(type) }}
              strokeWidth={1.8}
            />
            {on && <span className="font-medium">{TASK_TYPE_LABEL[type]}</span>}
          </button>
        );
      })}
      <PickChip
        label="Area"
        value={chips.area}
        all={{ label: "All areas", onSelect: () => onChips({ ...chips, area: undefined }) }}
        items={areaNames.map((name) => ({
          label: name,
          checked: chips.area === name,
          onSelect: () => onChips({ ...chips, area: name }),
        }))}
        disabled={areaNames.length === 0 && chips.area === undefined}
        title={
          areaNames.length === 0 ? "No areas yet: the wiki names them once a task changes files" : undefined
        }
      />
      <PickChip
        label="Source"
        value={chips.source === undefined ? undefined : ORIGIN_LABEL[chips.source]}
        all={{ label: "All sources", onSelect: () => onChips({ ...chips, source: undefined }) }}
        items={ORIGIN_KINDS.map((kind) => ({
          label: ORIGIN_LABEL[kind],
          checked: chips.source === kind,
          icon: <OriginIcon kind={kind} className="size-3.5 text-fg-faint" />,
          onSelect: () => onChips({ ...chips, source: kind }),
        }))}
      />
      {chipsActive(chips) && (
        <button
          type="button"
          onClick={(event) => {
            onChips(NO_CHIPS);
            handBack(event);
          }}
          className="h-7 cursor-pointer rounded-md px-2 text-sm text-fg-muted hover:text-fg"
        >
          Clear
        </button>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {toggles.map((t) => (
          <button
            key={t.section}
            type="button"
            aria-pressed={t.on}
            onClick={(event) => {
              onToggle(t.section);
              handBack(event);
            }}
            className={cn(CHIP, chipTone(t.on))}
          >
            {t.label}
            <span className="tnum font-mono text-xs text-fg-faint">{t.count}</span>
          </button>
        ))}
      </span>
    </fieldset>
  );
}
