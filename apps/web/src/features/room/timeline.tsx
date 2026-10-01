import type { RoomItem } from "@majhi/shared";
import { ArrowDown } from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import {
  type ItemContext,
  NotesRow,
  OWNER_CARD_TYPES,
  PinnedPlan,
  RoomItemView,
  rowDomId,
} from "./items";
import type { RoomState } from "./model";
import { nearBottom, pinnedPlans } from "./model";
import type { OwnerContext } from "./owner-cards";
import { beatOf, gapAbove, rowsOf } from "./rows";

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
}: {
  state: RoomState;
  onLoadOlder: () => Promise<void>;
  onPermission: (item: string, option: string) => void;
  answering: string | undefined;
  task: { id: string; folder: string };
  owner?: OwnerContext | undefined;
  /** A search match to scroll to: older pages are loaded until it is there. */
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
  } | null>(null);

  const plans = useMemo(() => pinnedPlans(state.items), [state.items]);
  const list = useRef<HTMLOListElement>(null);
  // Pinned plans are drawn above the log, not in it.
  const rows = useMemo(() => {
    const pinnedIds = new Set(plans.map((p) => p.id));
    return rowsOf(
      state.items.filter(
        (item) => !waitsForOwner(item) && !pinnedIds.has(item.id),
      ),
    );
  }, [state.items, plans]);
  const beats = useMemo(() => rows.map(beatOf), [rows]);

  // Opening a long room draws the newest rows first and the rest a moment later, so the room is
  // on screen in the time of a short one. The rest joins above, with the view kept where it was.
  const [windowed, setWindowed] = useState(true);
  const hasRows = rows.length > 0;
  useEffect(() => {
    if (!windowed || !hasRows) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        startTransition(() => setWindowed(false)),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [windowed, hasRows]);
  const from =
    windowed && focusItem === undefined
      ? Math.max(0, rows.length - FIRST_PAINT_ROWS)
      : 0;
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
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // Images and clips load after the room scrolled to the bottom; keep the view there when it was.
  const onMediaLoad = useCallback(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, []);
  // The ids of the pinned plans as one string: `plans` is a new array whenever any item arrives, and
  // a context that changed with it would redraw every row of the room on every message.
  const pinnedKey = plans.map((p) => p.id).join("\n");
  // Per row, only what that row shows: the model of an agent's message, the task for the cards that act on it.
  // An agent's status line changes on every tool call; a row that took the whole list would redraw each time.
  const modelKey = state.agents
    .map((a) => `${a.agent}=${a.model ?? ""}`)
    .join("\n");
  const modelOf = useMemo(
    () =>
      new Map(
        modelKey
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => {
            const at = line.indexOf("=");
            return [
              line.slice(0, at),
              line.slice(at + 1) || undefined,
            ] as const;
          }),
      ),
    [modelKey],
  );
  const rowProps = (item: RoomItem) => ({
    liveModel: item.type === "agent" ? modelOf.get(item.agent) : undefined,
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
    if (before === null || pinned.current) {
      el.scrollTop = el.scrollHeight;
    } else if (before.last === last && state.items.length > before.count) {
      el.scrollTop += el.scrollHeight - before.height;
    } else if (before.last !== last || state.items.length !== before.count) {
      setUnseen(true);
    }
    previous.current = {
      count: state.items.length,
      last,
      height: el.scrollHeight,
    };
  });

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = nearBottom(el);
    if (pinned.current) setUnseen(false);
    if (el.scrollTop < 80) void onLoadOlder();
  }, [onLoadOlder]);

  // The snapshot can be shorter than the window; keep loading until the list scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run again after each page of items
  useEffect(() => {
    const el = scroller.current;
    if (el && state.more && el.scrollHeight <= el.clientHeight)
      void onLoadOlder();
  }, [state.more, state.items.length, onLoadOlder]);

  function toBottom() {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight });
    setUnseen(false);
  }

  // Scroll to a search match. The room holds the newest page; older ones load until the item is
  // in the list, then its row is centered and lit once.
  const rowOf = useMemo(() => {
    const byItem = new Map<string, string>();
    for (const row of rows) {
      if (row.kind === "item") byItem.set(row.item.id, row.key);
      else for (const item of row.items) byItem.set(item.id, row.key);
    }
    return byItem;
  }, [rows]);
  const loadingFocus = useRef(false);
  useEffect(() => {
    if (focusItem === undefined || !state.loaded) return;
    const key = rowOf.get(focusItem);
    if (key === undefined) {
      if (state.more && !loadingFocus.current) {
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
  }, [focusItem, state.loaded, state.more, rowOf, onLoadOlder, onFocused]);

  const waiting = useMemo(
    () => dockItems(state.items, owner?.task.status),
    [state.items, owner?.task.status],
  );

  return (
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
        {state.more && (
          <p className="text-center text-xs text-fg-faint">
            Loading earlier messages
          </p>
        )}
        {!state.loaded && state.items.length === 0 && (
          <p className="m-auto text-sm text-fg-faint">Connecting to the room</p>
        )}
        {state.loaded && state.items.length === 0 && (
          <p className="m-auto text-sm text-fg-faint">
            Nothing yet. Messages and tool calls show up here.
          </p>
        )}
        <ol
          ref={list}
          className="m-0 mt-auto flex w-full max-w-[920px] flex-col p-0"
        >
          {rows.slice(from).map((row, j) => {
            const i = from + j;
            const gap = gapAbove(
              i === 0 ? undefined : beats[i - 1],
              beats[i] ?? "line",
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
                className={gap}
                inLog
              />
            );
          })}
        </ol>
      </div>
      {/* Anchored to the bottom of the log, so it sits above the dock. */}
      <div className="relative h-0">
        {unseen && (
          <Button
            variant="secondary"
            size="sm"
            onClick={toBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-glass-strong shadow-pop"
          >
            <ArrowDown aria-hidden="true" />
            New messages
          </Button>
        )}
      </div>
      {waiting.length > 0 && (
        // Whatever waits for the owner stays here, above the message box, until it is answered,
        // so new messages never bury it. Answered, it goes back into the log in its place.
        <section
          aria-label="Needs you"
          className={cn(
            "mt-2 flex max-h-[60%] shrink-0 flex-col gap-2 overflow-hidden rounded-xl p-2.5",
            GLASS,
            "border-lamp-needs/30",
          )}
        >
          <span className="flex items-center gap-2 px-0.5 text-sm font-medium text-lamp-needs">
            <Lamp state="needs" size={7} />
            Needs you
            {waiting.length > 1 && (
              <span className="tnum font-mono text-xs">{waiting.length}</span>
            )}
          </span>
          <ol className="m-0 flex min-h-0 flex-col gap-2.5 overflow-y-auto p-0">
            {waiting.map((item: RoomItem) => (
              <RoomItemView
                key={item.id}
                item={item}
                ctx={ctx}
                {...rowProps(item)}
              />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/**
 * What the dock shows: the items that wait for the owner. An open question comes first and hides
 * "Ready for review", so two primary buttons never compete and the answer is asked for first.
 */
function dockItems(
  items: readonly RoomItem[],
  status: string | undefined,
): RoomItem[] {
  // A card that draws nothing for the task's state (a pause on a task that is not paused, a reply
  // row on a task in review or done) must not leave an empty box in the dock.
  const draws = (i: RoomItem) =>
    i.type === "paused"
      ? status === undefined || status === "paused"
      : i.type === "owner-question"
        ? status === undefined ||
          (status !== "done" && (i.choices.length > 0 || status !== "review"))
        : true;
  const waiting = items.filter((i) => waitsForOwner(i) && draws(i));
  const asked = waiting.some(
    (i) =>
      ANSWERS.has(i.type) ||
      (i.type === "owner-question" && i.choices.length > 0),
  );
  const shown = asked ? waiting.filter((i) => i.type !== "review") : waiting;
  const rank = (i: RoomItem) =>
    ANSWERS.has(i.type)
      ? 0
      : i.type === "review" || i.type === "paused"
        ? 2
        : 1;
  return [...shown].sort((a, b) => rank(a) - rank(b));
}

/** Items that are a question to the owner. */
const ANSWERS: ReadonlySet<RoomItem["type"]> = new Set([
  "ask",
  "choice",
  "approval",
  "permission",
]);

/** Items that wait for the owner's answer: shown in the "Needs you" dock, not in the log. */
function waitsForOwner(item: RoomItem): boolean {
  switch (item.type) {
    case "permission":
    case "approval":
    case "ask":
    case "choice":
    case "review":
    case "paused":
    case "owner-question":
      return item.state === "pending";
    default:
      return false;
  }
}
