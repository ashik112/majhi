import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { parseOrgParam } from "@/features/shell/model";
import { useOrgs } from "./studio-queries";

/** The URL search for a link that keeps the org filter. */
export function orgSearch(org: string | undefined): { org?: string } {
  return org ? { org } : {};
}

/** The global org filter: `?org=<id>` in the URL, `undefined` for every org. Picking one shows the board. */
export function useOrgFilter(): { org: string | undefined; setOrg: (org: string | undefined) => void } {
  const search = useSearch({ strict: false }) as { org?: string };
  const orgs = useOrgs().data;
  const navigate = useNavigate();
  const org = parseOrgParam(search.org, orgs ?? []);
  const setOrg = useCallback(
    (next: string | undefined) => void navigate({ to: "/", search: orgSearch(next) }),
    [navigate],
  );
  return { org, setOrg };
}
