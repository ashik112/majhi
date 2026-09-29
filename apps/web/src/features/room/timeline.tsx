import type { RoomItem } from "@majhi/shared";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ItemContext, PinnedPlan, RoomItemView } from "./items";
import type { RoomState } from "./model";
import { nearBottom, pinnedPlans } from "./model";

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
}: {
  state: RoomState;
  onLoadOlder: () => Promise<void>;
  onPermission: (item: string, option: string) => void;
  answering: string | undefined;
  task: { id: string; folder: string };
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const previous = useRef<{ count: number; last: string | undefined; height: number } | null>(null);

  const plans = useMemo(() => pinnedPlans(state.items), [state.items]);
  // Images and clips load after the room scrolled to the bottom; keep the view there when it was.
  const onMediaLoad = useCallback(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, []);
  const ctx = useMemo<ItemContext>(
    () => ({
      agents: state.agents,
      pinned: new Set(plans.map((p) => p.id)),
      onPermission,
      answering,
      task: { id: task.id, folder: task.folder, onLoad: onMediaLoad },
    }),
    [state.agents, plans, onPermission, answering, task.id, task.folder, onMediaLoad],
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
    previous.current = { count: state.items.length, last, height: el.scrollHeight };
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
    if (el && state.more && el.scrollHeight <= el.clientHeight) void onLoadOlder();
  }, [state.more, state.items.length, onLoadOlder]);

  function toBottom() {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight });
    setUnseen(false);
  }

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
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-0.5 py-1 focus-visible:outline-none"
      >
        {state.more && <p className="text-center text-xs text-fg-faint">Loading earlier messages</p>}
        {!state.loaded && state.items.length === 0 && (
          <p className="m-auto text-sm text-fg-faint">Connecting to the room</p>
        )}
        {state.loaded && state.items.length === 0 && (
          <p className="m-auto text-sm text-fg-faint">Nothing yet. Messages and tool calls show up here.</p>
        )}
        <ol className="m-0 mt-auto flex flex-col gap-3.5 p-0">
          {state.items.map((item: RoomItem) => (
            <RoomItemView key={item.id} item={item} ctx={ctx} />
          ))}
        </ol>
      </div>
      {unseen && (
        <Button
          variant="secondary"
          size="sm"
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-card shadow-pop"
        >
          <ArrowDown aria-hidden="true" />
          New messages
        </Button>
      )}
    </div>
  );
}
