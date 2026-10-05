import type { RoomItem } from "@majhi/shared";
import { ArrowDown } from "lucide-react";
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { dockItems, waitsForOwner } from "./dock";
import { type ItemContext, NotesRow, OWNER_CARD_TYPES, PinnedPlan, RoomItemView, rowDomId } from "./items";
import { RoomTaskContext } from "./media";
import type { RoomState } from "./model";
import { nearBottom, pinnedPlans } from "./model";
import type { OwnerContext } from "./owner-cards";
import { beatOf, foldSteps, gapAbove, rowsOf } from "./rows";
import { StepsRow } from "./steps-row";

/** Rows drawn on the first paint of a long room. */
const FIRST_PAINT_ROWS = 40;

/**
 * The room's messages. Stays pinned to the bottom while new items arrive, unless the owner scrolled
 * up; then a "New messages" pill brings them back. Scrolling to the top loads older items.
 */
export function Timeline({
  state,
  onLoadOlder,
  onPermission,
  answering,
  task,
  owner,
  focusItem,
  onFocused,
  onLoadAround,
  onLoadNewer,
  onJumpToLatest,
  jumpSignal = 0,
  foldSteps: fold = false,
}: {
  /** Reads as a conversation: the steps between messages fold into one line per run. */
  foldSteps?: boolean | undefined;
  state: RoomState;
  onLoadOlder: () => Promise<void>;
  /** Loads the page around a search match in place of the newest one; false when the room has no such item. */
  onLoadAround?: ((item: string) => Promise<boolean>) | undefined;
  /** While the room shows the page around a match: the next newer page. */
  onLoadNewer?: (() => Promise<void>) | undefined;
  /** Leaves the page around a match for the newest messages. */
  onJumpToLatest?: (() => void) | undefined;
  /** Changes when the room asked to go to the newest messages, so the view follows once they are in. */
  jumpSignal?: number | undefined;
  onPermission: (item: string, option: string) => void;
  answering: string | undefined;
  task: { id: string; folder: string };
  owner?: OwnerContext | undefined;
  /** A search match to scroll to: the page around it is loaded in place of the newest one. */
  focusItem?: string | undefined;
  /** The match was shown, or cannot be (it is not in this room any more). */
  onFocused?: (() => void) | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const previous = useRef<{
    count: number;
    last: string | undefined;
    height: number;
    newer: boolean;
  } | null>(null);
  // Around a search match the bottom is not the end of the room: the view must not follow it.
  const detached = useRef(false);
  detached.current = state.newer;
  const jumping = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new signal is the trigger
  useEffect(() => {
    if (jumpSignal > 0) jumping.current = true;
  }, [jumpSignal]);

  const plans = useMemo(() => pinnedPlans(state.items), [state.items]);
  const list = useRef<HTMLOListElement>(null);
  // Pinned plans are drawn above the log, not in it.
  const rows = useMemo(() => {
    const pinnedIds = new Set(plans.map((p) => p.id));
    const all = rowsOf(state.items.filter((item) => !waitsForOwner(item) && !pinnedIds.has(item.id)));
    return fold ? foldSteps(all) : all;
  }, [state.items, plans, fold]);
  const beats = useMemo(() => rows.map(beatOf), [rows]);

  // Opening a long room draws the newest rows first and the rest a moment later, so the room is
  // on screen in the time of a short one. The rest joins above, with the view kept where it was.
  const [windowed, setWindowed] = useState(true);
  const hasRows = rows.length > 0;
  useEffect(() => {
    if (!windowed || !hasRows) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => startTransition(() => setWindowed(false)));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [windowed, hasRows]);
  // A search match needs every row drawn, and clearing the address must not hide the rows above it again.
  const hadFocus = useRef(false);
  if (focusItem !== undefined) hadFocus.current = true;
  const from = windowed && !hadFocus.current ? Math.max(0, rows.length - FIRST_PAINT_ROWS) : 0;
  const heightBefore = useRef(0);
  heightBefore.current = scroller.current?.scrollHeight ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the older rows join
  useLayoutEffect(() => {
    const el = scroller.current;
    if (windowed || !el || pinned.current) return;
    el.scrollTop += el.scrollHeight - heightBefore.current;
  }, [windowed]);

  // Rows off screen start at an estimated height and take their real one once drawn, and a
  // message can grow while it streams. While the view is at the bottom, it stays there, so the last
  // message is never left half under the composer.
  useEffect(() => {
    const el = scroller.current;
    const content = list.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current && !detached.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // Images and clips load after the room scrolled to the bottom; keep the view there when it was.
  const onMediaLoad = useCallback(() => {
    const el = scroller.current;
    if (el && pinned.current && !detached.current) el.scrollTop = el.scrollHeight;
  }, []);
  // The ids of the pinned plans as one string: `plans` is a new array whenever any item arrives, and
  // a context that changed with it would redraw every row of the room on every message.
  const pinnedKey = plans.map((p) => p.id).join("\n");
  // Per row, only what that row shows: the model of an agent's message, the task for the cards that act on it.
  // An agent's status line changes on every tool call; a row that took the whole list would redraw each time.
  const modelKey = state.agents.map((a) => `${a.agent}=${a.model ?? ""}`).join("\n");
  const modelOf = useMemo(
    () =>
      new Map(
        modelKey
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1) || undefined] as const;
          }),
      ),
    [modelKey],
  );
  // A queued message shows what its agent is doing, so only queued rows follow the live state.
  const lead = owner?.task.team[0];
  const rowProps = (item: RoomItem) => ({
    liveModel: item.type === "agent" ? modelOf.get(item.agent) : undefined,
    waitingOn:
      item.type === "owner" && item.queued
        ? state.agents.find((a) => a.agent === (item.to ?? lead))
        : undefined,
    owner: OWNER_CARD_TYPES.has(item.type) ? owner : undefined,
  });
  const ctx = useMemo<ItemContext>(
    () => ({
      pinned: new Set(pinnedKey === "" ? [] : pinnedKey.split("\n")),
      onPermission,
      answering,
      task: { id: task.id, folder: task.folder, onLoad: onMediaLoad },
    }),
    [pinnedKey, onPermission, answering, task.id, task.folder, onMediaLoad],
  );

  // After every render that changed the items: stay at the bottom, keep the view when older
  // items were added above, or raise the pill when new items arrived below a scrolled-up view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const last = state.items.at(-1)?.id;
    const before = previous.current;
    const away = state.newer || before?.newer === true;
    if (jumping.current && !state.newer) {
      jumping.current = false;
      pinned.current = true;
      el.scrollTop = el.scrollHeight;
    } else if (before === null || (pinned.current && !away)) {
      el.scrollTop = el.scrollHeight;
    } else if (before.last === last && state.items.length > before.count) {
      el.scrollTop += el.scrollHeight - before.height;
    } else if (!away && (before.last !== last || state.items.length !== before.count)) {
      setUnseen(true);
    }
    previous.current = {
      count: state.items.length,
      last,
      height: el.scrollHeight,
      newer: state.newer,
    };
  });

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = nearBottom(el);
    if (pinned.current) setUnseen(false);
    if (el.scrollTop < 80) void onLoadOlder();
    if (detached.current && pinned.current) void onLoadNewer?.();
  }, [onLoadOlder, onLoadNewer]);

  // The snapshot can be shorter than the window; keep loading until the list scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run again after each page of items
  useEffect(() => {
    const el = scroller.current;
    if (el && state.more && el.scrollHeight <= el.clientHeight) void onLoadOlder();
    if (el && state.newer && el.scrollHeight <= el.clientHeight) void onLoadNewer?.();
  }, [state.more, state.newer, state.items.length, onLoadOlder, onLoadNewer]);

  function toBottom() {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight });
    setUnseen(false);
  }

  // Scroll to a search match. The room holds the newest page; the page around the match replaces it
  // (older ones load as you scroll up, newer ones as you scroll down), then its row is centered and
  // lit once. Without `onLoadAround`, older pages load until the item is in the list.
  const rowOf = useMemo(() => {
    const byItem = new Map<string, string>();
    for (const row of rows) {
      if (row.kind === "item") byItem.set(row.item.id, row.key);
      else for (const item of row.items) byItem.set(item.id, row.key);
    }
    return byItem;
  }, [rows]);
  const loadingFocus = useRef(false);
  const aroundTried = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focusItem === undefined || !state.loaded) return;
    const key = rowOf.get(focusItem);
    if (key === undefined) {
      if (onLoadAround !== undefined) {
        if (aroundTried.current === focusItem) return;
        aroundTried.current = focusItem;
        void onLoadAround(focusItem).then((found) => {
          if (!found) onFocused?.();
        });
      } else if (state.more && !loadingFocus.current) {
        loadingFocus.current = true;
        void onLoadOlder().finally(() => {
          loadingFocus.current = false;
        });
      } else if (!state.more) onFocused?.();
      return;
    }
    const el = document.getElementById(rowDomId(key));
    if (!el) return;
    pinned.current = false;
    el.scrollIntoView({ block: "center" });
    el.removeAttribute("data-found");
    void el.offsetWidth;
    el.setAttribute("data-found", "");
    onFocused?.();
  }, [focusItem, state.loaded, state.more, rowOf, onLoadOlder, onLoadAround, onFocused]);

  const waiting = useMemo(
    () => dockItems(state.items, owner?.task.status),
    [state.items, owner?.task.status],
  );

  return (
    <RoomTaskContext.Provider value={task.id}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {plans.length > 0 && (
          <div className="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto pb-2">
            {plans.map((plan) => (
              <PinnedPlan key={plan.id} plan={plan} />
            ))}
          </div>
        )}
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label="Room messages"
          aria-live="off"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus so the keyboard can scroll it
          tabIndex={0}
          className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-0.5 pt-1 pb-6 scroll-fade focus-visible:outline-none"
        >
          {state.more && <p className="text-center text-xs text-fg-faint">Loading earlier messages</p>}
          {!state.loaded && state.items.length === 0 && (
            <p className="m-auto text-sm text-fg-faint">Connecting to the room</p>
          )}
          {state.loaded && state.items.length === 0 && (
            <p className="m-auto text-sm text-fg-faint">Nothing yet. Messages and tool calls show up here.</p>
          )}
          <ol ref={list} className="m-0 mt-auto flex w-full max-w-[920px] flex-col p-0">
            {rows.slice(from).map((row, j) => {
              const i = from + j;
              const gap = gapAbove(i === 0 ? undefined : beats[i - 1], beats[i] ?? "line");
              if (row.kind === "steps")
                return (
                  <StepsRow key={row.key} count={row.count} className={gap}>
                    {row.items.map((item) => (
                      <RoomItemView
                        key={item.id}
                        item={item}
                        ctx={ctx}
                        {...rowProps(item)}
                        className="mt-0.5"
                      />
                    ))}
                  </StepsRow>
                );
              return row.kind === "notes" ? (
                <NotesRow
                  key={row.key}
                  rowKey={row.key}
                  quiet={row.quiet}
                  at={row.items[0]?.at ?? ""}
                  className={gap}
                />
              ) : (
                <RoomItemView
                  key={row.key}
                  item={row.item}
                  ctx={ctx}
                  {...rowProps(row.item)}
                  repeat={row.repeat}
                  className={gap}
                  inLog
                />
              );
            })}
          </ol>
        </div>
        {/* Anchored to the bottom of the log, so it sits above the dock. */}
        <div className="relative h-0">
          {state.newer ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onJumpToLatest}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-glass-strong shadow-pop"
            >
              <ArrowDown aria-hidden="true" />
              Latest messages
            </Button>
          ) : (
            unseen && (
              <Button
                variant="secondary"
                size="sm"
                onClick={toBottom}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-glass-strong shadow-pop"
              >
                <ArrowDown aria-hidden="true" />
                New messages
              </Button>
            )
          )}
        </div>
        {waiting.length > 0 && (
          // Whatever waits for the owner stays here, above the message box, until it is answered,
          // so new messages never bury it. Answered, it goes back into the log in its place.
          <section
            aria-label="Needs you"
            className={cn(
              "mt-2 flex max-h-[60%] shrink-0 flex-col overflow-y-auto rounded-xl px-3 py-0.5",
              GLASS,
              "border-lamp-needs/30",
            )}
          >
            <ol className="m-0 flex min-h-0 flex-col divide-y divide-line p-0">
              {waiting.map((item: RoomItem) => (
                <RoomItemView key={item.id} item={item} ctx={ctx} {...rowProps(item)} />
              ))}
            </ol>
          </section>
        )}
      </div>
    </RoomTaskContext.Provider>
  );
}
