import { type Health, type ReloadDecision, reloadDecision } from "@majhi/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getHealth } from "./api";

/** How often an open tab asks `/health` which build the server serves. */
const BUILD_POLL_MS = 30_000;

/** The id this tab's bundle was built with (index.html's `majhi-build` meta). Undefined in dev. */
export const MY_BUILD: string | undefined =
  document.querySelector<HTMLMetaElement>('meta[name="majhi-build"]')?.content || undefined;

/** The build the events socket's hello frame named last. */
let helloBuild: string | undefined;
const listeners = new Set<() => void>();

export function setHelloBuild(build: string | undefined): void {
  if (build === helloBuild) return;
  helloBuild = build;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** True while any composer or text box of the page holds text that was not sent. */
export function hasUnsentText(): boolean {
  for (const box of document.querySelectorAll("textarea")) {
    if (box.value.trim() !== "") return true;
  }
  return false;
}

const RELOADED_KEY = "majhi.build-reload";
/** A tab reloads itself for a build at most once a minute, so a stale cache cannot loop. */
const RELOAD_GAP_MS = 60_000;

function reloadedRecently(server: string): boolean {
  try {
    const [id, at] = (sessionStorage.getItem(RELOADED_KEY) ?? "").split("@");
    return id === server && Date.now() - Number(at) < RELOAD_GAP_MS;
  } catch {
    return false;
  }
}

function markReloaded(server: string): void {
  try {
    sessionStorage.setItem(RELOADED_KEY, `${server}@${Date.now()}`);
  } catch {
    // Without storage the tab still reloads; the guard is only for a loop.
  }
}

/**
 * Watches the server's build (the events hello, and `/health` as it is polled). A different build
 * reloads the tab at once when no text is unsent; otherwise it returns "ask", for the bar, and
 * reloads by itself as soon as the composers are empty.
 */
export function useStaleBuild(): { decision: ReloadDecision; reload: () => void } {
  const hello = useSyncExternalStore(subscribe, () => helloBuild);
  // The events hello says it on every connect; `/health` is the check for a feed that stays up.
  const health = useQuery<Health>({
    queryKey: ["build-watch"],
    queryFn: ({ signal }) => getHealth(signal),
    // The hello names the build on every connect, and a new build restarts the server: ask only until it has.
    enabled: hello === undefined,
    refetchInterval: BUILD_POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  }).data;
  const server = hello ?? health?.build;
  const [tick, setTick] = useState(0);
  const decision = reloadDecision({ mine: MY_BUILD, server, unsent: hasUnsentText() });
  // While the two differ, look again every second: the owner sending the text makes it safe.
  const differs = decision !== "none";
  useEffect(() => {
    if (!differs) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [differs]);
  const reload = () => window.location.reload();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-runs the check every second while the builds differ.
  useEffect(() => {
    if (decision !== "reload" || server === undefined || reloadedRecently(server)) return;
    markReloaded(server);
    reload();
  }, [decision, server, tick]);
  return { decision, reload };
}
