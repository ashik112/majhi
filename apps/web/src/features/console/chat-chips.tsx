import type { OrgView } from "@majhi/shared";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { MajhiMark } from "@/components/ui/majhi-mark";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";
import { type ChatChip, WORK_STATE_LAMP, type WorkState, workspaceName } from "./model";
import { ConsoleLamp, WorkspaceTag } from "./parts";

/** The space between chips, the same as `.cs-chips` in console.css. */
const GAP = 4;

/**
 * Which chips fit. `widths` are the chips' natural widths, `more` is the width of the "+N more" chip.
 * When all of them fit, all are shown and there is no "+N more". Otherwise the chip for the open chat
 * is always kept, the rest fill the room in order, and what is left goes under "+N more".
 */
export function fitChips(widths: readonly number[], more: number, room: number, pinned: number): Set<number> {
  const total = widths.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, widths.length - 1);
  if (total <= room) return new Set(widths.keys());
  const shown = new Set<number>();
  let used = more;
  const pin = widths[pinned];
  if (pin !== undefined) {
    shown.add(pinned);
    used += GAP + pin;
  }
  for (const [i, w] of widths.entries()) {
    if (i === pinned) continue;
    if (used + GAP + w > room) break;
    shown.add(i);
    used += GAP + w;
  }
  return shown;
}

export function Chip({
  chip,
  pressed,
  stateOf,
  hues,
  orgs,
  onPick,
}: {
  chip: ChatChip;
  pressed: boolean;
  stateOf: WorkState | undefined;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <button type="button" className="cs-chip" aria-pressed={pressed} onClick={() => onPick(chip.id)}>
      <ChipMark chip={chip} stateOf={stateOf} hues={hues} orgs={orgs} />
      <span className="cs-t">{chip.title}</span>
      {chip.unread > 0 && <span className="cs-unread">{chip.unread}</span>}
    </button>
  );
}

function ChipMark({
  chip,
  stateOf,
  hues,
  orgs,
}: {
  chip: ChatChip;
  stateOf: WorkState | undefined;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
}) {
  if (chip.kind === "captain") {
    return (
      <span className="cs-mark" data-size="sm">
        <MajhiMark />
      </span>
    );
  }
  if (chip.kind === "task" && stateOf !== undefined) return <ConsoleLamp state={WORK_STATE_LAMP[stateOf]} />;
  if (chip.kind === "conversation") {
    return <WorkspaceTag name={workspaceName(orgs, chip.org)} org={chip.org} hues={hues} />;
  }
  return null;
}

interface Shared {
  chips: readonly ChatChip[];
  selected: string;
  stateOf: (id: string) => WorkState | undefined;
  hues: ReadonlyMap<string, number>;
  orgs: readonly OrgView[] | undefined;
  onPick: (id: string) => void;
}

/**
 * The chips of the chat pane on one line. The ones that do not fit fold into a "+N more" chip that
 * always stays in view; nothing is counted by hand. The chips are measured in a hidden copy, so the
 * count follows the pane's width, the fonts and the unread numbers.
 */
export function ChatChips(props: Shared & { tools: ReactNode }) {
  const { chips, selected } = props;
  const strip = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<string>();
  const pinned = Math.max(
    0,
    chips.findIndex((c) => c.id === selected),
  );

  const measure = useCallback(() => {
    const box = strip.current;
    const hidden = copy.current;
    if (box === null || hidden === null) return;
    const widths = Array.from(hidden.querySelectorAll<HTMLElement>("[data-chip]"), (el) => el.offsetWidth);
    const more = hidden.querySelector<HTMLElement>("[data-more]")?.offsetWidth ?? 0;
    const fits = fitChips(widths, more, box.clientWidth, pinned);
    setShown(
      chips
        .filter((_, i) => fits.has(i))
        .map((c) => c.id)
        .join("\n"),
    );
  }, [chips, pinned]);

  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const watch = new ResizeObserver(measure);
    if (strip.current !== null) watch.observe(strip.current);
    if (copy.current !== null) watch.observe(copy.current);
    return () => watch.disconnect();
  }, [measure]);

  const visible = shown === undefined ? undefined : new Set(shown.split("\n"));
  const shownChips = visible === undefined ? chips : chips.filter((c) => visible.has(c.id));
  const hiddenCount = chips.length - shownChips.length;
  // What the hidden chats hold unread, so "+N more" never hides a message.
  const hiddenUnread = chips.filter((c) => !shownChips.includes(c)).reduce((sum, c) => sum + c.unread, 0);
  const chipProps = (chip: ChatChip) => ({
    chip,
    pressed: chip.id === selected,
    stateOf: chip.kind === "task" ? props.stateOf(chip.id) : undefined,
    hues: props.hues,
    orgs: props.orgs,
    onPick: props.onPick,
  });
  return (
    <div className="cs-chips">
      <div ref={strip} className="cs-strip">
        {shownChips.map((chip) => (
          <Chip key={chip.id} {...chipProps(chip)} />
        ))}
        {hiddenCount > 0 && <MoreChip count={hiddenCount} unread={hiddenUnread} {...props} />}
      </div>
      {props.tools}
      <div ref={copy} className="cs-measure" aria-hidden="true" inert>
        {chips.map((chip) => (
          <span key={chip.id} data-chip>
            <Chip {...chipProps(chip)} />
          </span>
        ))}
        <span data-more>
          <span className="cs-chip">
            +{chips.length} more<span className="cs-unread">00</span>
          </span>
        </span>
      </div>
    </div>
  );
}

/** "+N more": opens a floating list of every chat, with a search box. */
function MoreChip(props: Shared & { count: number; unread: number }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({
    open,
    close,
    trigger,
    align: "right",
    maxHeight: 420,
  });
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="cs-chip cs-more-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        +{props.count} more
        {props.unread > 0 && <span className="cs-unread">{props.unread}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="dialog"
            aria-label="All chats"
            style={style}
            className={cn("cs-picker z-[var(--z-float)] flex w-[340px] flex-col rounded-lg", GLASS_STRONG)}
          >
            <ChatPicker
              {...props}
              onPick={(chat) => {
                setOpen(false);
                props.onPick(chat);
              }}
              onClose={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            />
          </div>,
          container,
        )}
    </>
  );
}

/** A search box and every chat under it; the arrow keys move, Enter opens, Esc closes. */
function ChatPicker(props: Shared & { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  // The list opens to be typed in. Focus waits a frame, until the panel is placed and visible: a hidden one takes none.
  useEffect(() => {
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const needle = query.trim().toLowerCase();
  const found = props.chips.filter(
    (c) =>
      needle === "" ||
      c.title.toLowerCase().includes(needle) ||
      (c.kind !== "captain" && workspaceName(props.orgs, c.org).toLowerCase().includes(needle)),
  );
  const active = Math.min(at, Math.max(0, found.length - 1));
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the active row changes
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, query]);
  return (
    <>
      <input
        ref={search}
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={found[active] === undefined ? undefined : `${id}-${found[active].id}`}
        aria-label="Search chats"
        placeholder="Search chats"
        value={query}
        className="cs-picker-search"
        onChange={(event) => {
          setQuery(event.target.value);
          setAt(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setAt((found.length + active + step) % Math.max(1, found.length));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const chat = found[active];
            if (chat !== undefined) props.onPick(chat.id);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            props.onClose();
          }
        }}
      />
      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Chats" className="cs-picker-list">
        {found.length === 0 && <p className="cs-picker-empty">No chat matches.</p>}
        {found.map((chat, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the search box holds the focus and takes the keys
          <div
            key={chat.id}
            id={`${id}-${chat.id}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            data-current={chat.id === props.selected || undefined}
            className="cs-opt"
            onMouseEnter={() => setAt(i)}
            onClick={() => props.onPick(chat.id)}
          >
            <ChipMark
              chip={chat}
              stateOf={chat.kind === "task" ? props.stateOf(chat.id) : undefined}
              hues={props.hues}
              orgs={props.orgs}
            />
            <span className="cs-t">{chat.title}</span>
            {chat.unread > 0 && <span className="cs-unread">{chat.unread}</span>}
          </div>
        ))}
      </div>
    </>
  );
}
