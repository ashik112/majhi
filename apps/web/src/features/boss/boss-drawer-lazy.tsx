import { lazy } from "react";

const load = () => import("./boss-drawer");

/** The Captain drawer's code, read only when the drawer is opened (or about to be: see `preloadBossDrawer`). */
export const LazyBossDrawer = lazy(() => load().then((m) => ({ default: m.BossDrawer })));

/** Starts reading the drawer's code, when the pointer reaches the button that opens it. */
export function preloadBossDrawer(): void {
  void load();
}
