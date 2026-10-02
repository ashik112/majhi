import type { OnboardingStatus } from "@majhi/shared";
import { useMemo, useRef } from "react";
import { useOnboardingStatus } from "@/lib/onboarding-queries";
import { useConfig, useHostStatus } from "@/lib/queries";
import { useAccounts, useAgents, useOrgs } from "@/lib/studio-queries";
import { useProjects } from "@/lib/task-queries";
import { deriveStatus } from "./model";

export interface Journey {
  /** Undefined until the server status, or every read the browser works it out from, has loaded. */
  status: OnboardingStatus | undefined;
  /** Where the status came from: the server, or the browser when the server could not answer. */
  source: "server" | "browser";
}

/**
 * What is set up, step by step. `onboarding.status` when the server answers it; otherwise the same
 * rules applied to the config, accounts, agents, orgs and projects the app already reads.
 */
export function useJourney(): Journey {
  const config = useConfig();
  const loaded = config.data?.status === "loaded";
  const server = useOnboardingStatus(loaded);
  // A refetch puts a query that never answered back to pending, so count any failure so far: the
  // browser keeps working the status out until the server answers once.
  const failed = server.data === undefined && (server.isError || server.errorUpdateCount > 0);
  const fallback = failed || config.data?.status === "first-run";
  const accounts = useAccounts(loaded && fallback);
  const agents = useAgents(loaded && fallback);
  const orgs = useOrgs();
  const projects = useProjects(loaded && fallback);
  const host = useHostStatus();

  const roots = config.data?.status === "loaded" ? config.data.config.workspaces : undefined;
  const derived = useMemo(() => {
    if (config.data?.status === "first-run") {
      return deriveStatus({
        roots: [],
        accounts: [],
        agents: [],
        orgs: orgs.data ?? [],
        projects: [],
        hostHelper: host.data?.connected ?? false,
      });
    }
    if (!fallback || !roots || !accounts.data || !agents.data || !orgs.data || !projects.data)
      return undefined;
    return deriveStatus({
      roots,
      accounts: accounts.data,
      agents: agents.data,
      orgs: orgs.data,
      projects: projects.data,
      hostHelper: host.data?.connected ?? false,
    });
  }, [config.data?.status, fallback, roots, accounts.data, agents.data, orgs.data, projects.data, host.data]);

  // Keep the last answer while a read reloads, so a step on screen never unmounts mid-flow.
  const last = useRef<Journey>({ status: undefined, source: "browser" });
  const now: Journey =
    server.data && !fallback
      ? { status: server.data, source: "server" }
      : { status: derived, source: "browser" };
  if (now.status) last.current = now;
  return now.status ? now : last.current;
}
