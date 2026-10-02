import {
  type EmojiPickerListComponents,
  type EmojiPickerListEmojiProps,
  EmojiPicker as Picker,
} from "frimousse";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { createContext, useContext, useId } from "react";
import { createPortal } from "react-dom";
import { EMOJI_FONT } from "@/components/agent-avatar";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";

/**
 * Where the picker reads its emoji data: majhi serves the pinned `emojibase-data` files itself (see
 * `emojibase()` in vite.config.ts), so the picker works offline and never calls a CDN.
 */
const EMOJIBASE_URL = "/emojibase";
const COLUMNS = 8;

/** The agent's emoji now, ringed in the grid. */
const CurrentEmoji = createContext<string | undefined>(undefined);

function PickerEmoji({ emoji, ...props }: EmojiPickerListEmojiProps) {
  const current = useContext(CurrentEmoji);
  return (
    <button
      {...props}
      className={cn(
        "flex h-8 w-[calc(100%/var(--frimousse-list-columns))] cursor-pointer items-center justify-center rounded-md text-[20px] leading-none",
        emoji.isActive && "bg-selected",
        emoji.emoji === current && "ring-1 ring-accent-line ring-inset",
      )}
    >
      {emoji.emoji}
    </button>
  );
}

/** Module level, so the list keeps its rows between renders. */
const LIST: EmojiPickerListComponents = {
  CategoryHeader: ({ category, ...props }) => (
    <div
      {...props}
      className="bg-glass-strong px-1 pt-2 pb-1 text-xs font-medium tracking-[0.08em] text-fg-faint uppercase"
    >
      {category.label}
    </div>
  ),
  Row: ({ children, ...props }) => (
    <div {...props} className="scroll-my-1.5">
      {children}
    </div>
  ),
  Emoji: PickerEmoji,
};

/**
 * A floating emoji picker anchored to `trigger`: search on top, the emoji grid by category, and a
 * footer that names the emoji under the pointer or offers to remove the current one. Arrow keys move
 * through the grid from the search box and Enter picks; Escape closes and returns focus to `trigger`.
 */
export function EmojiPickerPanel({
  open,
  onClose,
  trigger,
  label,
  current,
  onPick,
  onRemove,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  trigger: RefObject<HTMLElement | null>;
  /** The panel's accessible name, "Emoji for @globex-builder". */
  label: string;
  current: string | undefined;
  onPick: (emoji: string) => void;
  /** Shown as "Remove emoji" while there is a current emoji. */
  onRemove?: (() => void) | undefined;
  busy?: boolean;
}) {
  const id = useId();
  const { panel, style, container } = useAnchoredPanel({ open, close: onClose, trigger, maxHeight: 380 });
  if (!open) return null;

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
    trigger.current?.focus();
  }

  return createPortal(
    <div
      ref={panel}
      popover="manual"
      id={id}
      role="dialog"
      aria-label={label}
      style={style}
      onKeyDown={onKeyDown}
      className={cn("z-50 flex w-[300px] flex-col overflow-hidden rounded-xl", GLASS_STRONG)}
    >
      <Picker.Root
        columns={COLUMNS}
        emojibaseUrl={EMOJIBASE_URL}
        onEmojiSelect={({ emoji }) => onPick(emoji)}
        className="flex h-[340px] min-h-0 flex-col"
      >
        <div className="shrink-0 p-2 pb-1.5">
          <Picker.Search
            autoFocus
            aria-label="Search emoji"
            placeholder="Search emoji"
            className={cn(
              "h-8 w-full min-w-0 rounded-md border border-line-control bg-field px-2.5 text-base text-fg",
              "placeholder:text-fg-faint transition-[border-color] duration-150 hover:border-line-hover",
              "focus-visible:border-accent focus-visible:outline-none",
              "[&::-webkit-search-cancel-button]:hidden",
            )}
          />
        </div>
        <Picker.Viewport className="relative min-h-0 flex-1 px-1.5 outline-none scroll-fade-end">
          <Picker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-fg-faint">
            Loading emoji
          </Picker.Loading>
          <Picker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-fg-faint">
            {({ search }) => <>No emoji for "{search}"</>}
          </Picker.Empty>
          <CurrentEmoji.Provider value={current}>
            <Picker.List className="pb-1.5 select-none" components={LIST} />
          </CurrentEmoji.Provider>
        </Picker.Viewport>
        <Footer current={current} onRemove={onRemove} busy={busy} />
      </Picker.Root>
    </div>,
    container,
  );
}

function Footer({
  current,
  onRemove,
  busy,
}: {
  current: string | undefined;
  onRemove: (() => void) | undefined;
  busy: boolean;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-t border-line px-2.5">
      <Picker.ActiveEmoji>
        {({ emoji }): ReactNode =>
          emoji ? (
            <>
              <span
                aria-hidden="true"
                className="text-[20px] leading-none"
                style={{ fontFamily: EMOJI_FONT }}
              >
                {emoji.emoji}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{emoji.label}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm text-fg-faint">
              {busy ? "Saving" : "Pick an emoji"}
            </span>
          )
        }
      </Picker.ActiveEmoji>
      {current && onRemove && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove} className="ml-auto">
          Remove emoji
        </Button>
      )}
    </div>
  );
}
