import { type ComponentType, Fragment, lazy, type ReactNode, Suspense, useEffect, useRef } from "react";

/** A list of more than this many items is drawn only where it is on screen. */
export const VIRTUAL_OVER = 100;

export interface PaneItem {
  key: string;
}

// A lazy component cannot keep the list's item type; the list only passes the props through.
const VirtualList = lazy(() => import("./virtual-list")) as unknown as ComponentType<Props<PaneItem>>;

interface Props<T extends PaneItem> {
  items: readonly T[];
  render: (item: T) => ReactNode;
  selectedKey: string | undefined;
  label: string;
}

function PlainList<T extends PaneItem>({ items, render, selectedKey, label }: Props<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const selectedIndex = selectedKey === undefined ? -1 : items.findIndex((i) => i.key === selectedKey);
  useEffect(() => {
    if (selectedIndex < 0) return;
    scroller.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);
  return (
    <div ref={scroller} className="cs-scroll" role="listbox" aria-label={label}>
      {items.map((item) => (
        <Fragment key={item.key}>{render(item)}</Fragment>
      ))}
    </div>
  );
}

/**
 * The scrolling list inside a pane. A short list is drawn whole, with sticky group heads. A list of
 * over 100 items is virtualised (`virtual-list.tsx`). The selected item is kept in view as the keys move it.
 */
export function PaneList<T extends PaneItem>(props: Props<T>) {
  if (props.items.length <= VIRTUAL_OVER) return <PlainList {...props} />;
  return (
    <Suspense fallback={<PlainList {...props} items={props.items.slice(0, VIRTUAL_OVER)} />}>
      <VirtualList {...(props as unknown as Props<PaneItem>)} />
    </Suspense>
  );
}
