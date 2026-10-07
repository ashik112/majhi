import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * How much of the crumbs line fits. `full`: the type and area chips sit on the line after the origin.
 * `title`: it is too wide, so the chips move to the title row. `short`: still too wide, so the
 * workspace shows as its tile only. `tight`: the origin is its icon only. The line is measured, not
 * guessed: it moves down a step while
 * something is cut (a name that ellipsizes, or the line itself running past its box) and starts from
 * `full` again whenever its width or its content changes.
 */
export type CrumbFit = "full" | "title" | "short" | "tight";

const NEXT: Record<CrumbFit, CrumbFit> = { full: "title", title: "short", short: "tight", tight: "tight" };

/** Marks a piece whose text can be cut by an ellipsis: the measure looks at it. */
export const CLIP_ATTR = "data-clip";

export function useCrumbFit(line: RefObject<HTMLElement | null>, content: string): CrumbFit {
  const [width, setWidth] = useState(0);
  // The fit belongs to one width and one content: a different one starts from `full` again.
  const key = `${width}|${content}`;
  const [state, setState] = useState<{ key: string; fit: CrumbFit }>({ key, fit: "full" });
  const fit: CrumbFit = state.key === key ? state.fit : "full";

  useLayoutEffect(() => {
    const el = line.current;
    if (el === null) return;
    const observer = new ResizeObserver(() =>
      setWidth((now) => (Math.abs(el.clientWidth - now) < 1 ? now : el.clientWidth)),
    );
    observer.observe(el);
    setWidth((now) => (Math.abs(el.clientWidth - now) < 1 ? now : el.clientWidth));
    return () => observer.disconnect();
  }, [line]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key and the fit are the triggers
  useLayoutEffect(() => {
    const el = line.current;
    if (el === null) return;
    const cut =
      el.scrollWidth > el.clientWidth + 1 ||
      [...el.querySelectorAll<HTMLElement>(`[${CLIP_ATTR}]`)].some((t) => t.scrollWidth > t.clientWidth + 1);
    if (cut && fit !== "tight") setState({ key, fit: NEXT[fit] });
  }, [fit, key, line]);

  return fit;
}
