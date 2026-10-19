import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useRef } from "react";
import type { PaneItem } from "./pane-list";

/**
 * The list of a pane when it has over 100 items: only what is on screen (and a few items around it)
 * is in the page, and an item that opens in place is measured again. Its own chunk: a short list never
 * needs the virtualiser.
 */
export default function VirtualList<T extends PaneItem>({
  items,
  render,
  selectedKey,
  label,
}: {
  items: readonly T[];
  render: (item: T) => ReactNode;
  selectedKey: string | undefined;
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const selectedIndex = selectedKey === undefined ? -1 : items.findIndex((i) => i.key === selectedKey);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 52,
    overscan: 10,
    getItemKey: (index) => items[index]?.key ?? index,
  });

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  return (
    <div ref={scroller} className="cs-scroll" role="listbox" aria-label={label}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index];
          if (item === undefined) return null;
          return (
            <div
              key={item.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${v.start}px)`,
              }}
            >
              {render(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
