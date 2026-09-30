import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ALL_ORGS, parseOrgParam } from "@/features/shell/model";
import { useOrgs } from "./studio-queries";

/**
 * The global org filter is app state, remembered in this browser, not a URL parameter: as `?org=`
 * it rode along on every link and followed the owner to pages that group by org anyway. The
 * sidebar shows it; the board and usage follow it.
 */
const KEY = "majhi.org";
const listeners = new Set<() => void>();

function read(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

let memory = read();

function write(org: string | undefined): void {
  memory = org;
  try {
    if (org === undefined) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, org);
  } catch {
    // Storage can be blocked; the filter then lasts until the page reloads.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Links used to carry the filter as `?org=`; they no longer do. Kept so callers need no change. */
export function orgSearch(_org: string | undefined): { org?: string } {
  return {};
}

/** The global org filter, `undefined` for every org. Picking one shows the board. */
export function useOrgFilter(): { org: string | undefined; setOrg: (org: string | undefined) => void } {
  const stored = useSyncExternalStore(subscribe, () => memory);
  const orgs = useOrgs().data;
  const navigate = useNavigate();
  const org = parseOrgParam(stored, orgs ?? []);
  const setOrg = useCallback(
    (next: string | undefined) => {
      write(next);
      void navigate({ to: "/" });
    },
    [navigate],
  );
  return { org, setOrg };
}

/**
 * An old link with `?org=` still works: its org becomes the filter and the parameter leaves the
 * URL. Mounted once, in the app shell.
 */
export function useAdoptOrgParam(): void {
  const search = useSearch({ strict: false }) as { org?: string };
  const navigate = useNavigate();
  useEffect(() => {
    if (search.org === undefined) return;
    write(search.org === ALL_ORGS ? undefined : search.org);
    void navigate({
      to: ".",
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const { org: _dropped, ...rest } = prev;
        return rest;
      },
    });
  }, [search.org, navigate]);
}
