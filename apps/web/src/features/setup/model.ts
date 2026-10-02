import type { AccountView, AgentEntry, HostStatus, OrgView, RootScan } from "@majhi/shared";
import { accountsNeedingYou } from "../shell/model";

export type Tone = "green" | "coral" | "blue" | "neutral";

export interface CardState {
  pill: string;
  tone: Tone;
  detail: string;
}

/** Workspace roots: ready when every root is mounted and scanned. */
export function rootsCard(roots: readonly RootScan[] | undefined, collapsed: readonly string[]): CardState {
  if (roots === undefined) return { pill: "Checking", tone: "neutral", detail: collapsed.join(", ") };
  const unmounted = roots.filter((r) => !r.mounted).length;
  const failed = roots.filter((r) => r.mounted && r.error).length;
  const repos = roots.reduce((n, r) => n + r.repos.length, 0);
  const detail = `${collapsed.join(", ")}\n${repos} ${repos === 1 ? "repo" : "repos"} found`;
  if (unmounted > 0) return { pill: "Needs mount", tone: "coral", detail };
  if (failed > 0) return { pill: "Scan failed", tone: "coral", detail };
  return { pill: "Ready", tone: "green", detail };
}

/** SSH keys as the host helper reports them. Without the helper nothing is known. */
export function sshCard(host: HostStatus | undefined): CardState {
  if (host === undefined) return { pill: "Checking", tone: "neutral", detail: "Asking the host helper" };
  if (!host.connected) {
    return {
      pill: "Helper offline",
      tone: "neutral",
      detail: "The host helper loads your SSH keys. It is not connected.",
    };
  }
  const ssh = host.info?.ssh;
  if (ssh === undefined)
    return { pill: "Checking", tone: "neutral", detail: "Waiting for the first key check" };
  const failing = (host.sshHosts ?? []).filter((h) => h.state === "auth-failed");
  if (ssh.loaded === 0 || ssh.needsPassphrase.length > 0 || failing.length > 0) {
    const detail =
      ssh.needsPassphrase.length > 0
        ? `${ssh.needsPassphrase.length} ${ssh.needsPassphrase.length === 1 ? "key needs" : "keys need"} its passphrase`
        : ssh.loaded === 0
          ? "No SSH key loaded"
          : `${failing.map((h) => h.host).join(", ")} took no key`;
    return { pill: "Needs you", tone: "coral", detail };
  }
  return {
    pill: "Ready",
    tone: "green",
    detail: `${ssh.loaded} ${ssh.loaded === 1 ? "key" : "keys"} loaded`,
  };
}

export function accountsCard(accounts: readonly AccountView[] | undefined): CardState {
  if (accounts === undefined) return { pill: "Checking", tone: "neutral", detail: "" };
  if (accounts.length === 0)
    return { pill: "None yet", tone: "coral", detail: "Add an account so agents can run" };
  const need = accountsNeedingYou(accounts).length;
  const count = `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
  return need > 0
    ? { pill: "Needs you", tone: "coral", detail: `${count}, ${need} ${need === 1 ? "needs" : "need"} you` }
    : { pill: "Ready", tone: "green", detail: count };
}

export function agentsCard(agents: readonly AgentEntry[] | undefined, orgs: readonly OrgView[]): CardState {
  if (agents === undefined) return { pill: "Checking", tone: "neutral", detail: "" };
  const ok = agents.filter((a) => a.status === "ok");
  const broken = agents.length - ok.length;
  const scopes = new Set(ok.map((a) => (a.status === "ok" ? a.agent.frontmatter.scope : "")));
  const orgScopes = orgs.filter((o) => scopes.has(o.id)).length;
  const detail = `${ok.length} ${ok.length === 1 ? "agent" : "agents"}${
    orgScopes > 0 ? ` across ${orgScopes} ${orgScopes === 1 ? "workspace" : "workspaces"}` : ""
  }`;
  if (broken > 0) return { pill: "Needs you", tone: "coral", detail: `${detail}, ${broken} with errors` };
  return { pill: ok.length > 0 ? "Ready" : "None yet", tone: ok.length > 0 ? "green" : "coral", detail };
}

/** The boss agent and how its account is doing. */
export function bossCard(
  agents: readonly AgentEntry[] | undefined,
  accounts: readonly AccountView[] | undefined,
): CardState & { id?: string } {
  if (agents === undefined) return { pill: "Checking", tone: "neutral", detail: "" };
  const boss = agents.find((a): a is Extract<AgentEntry, { status: "ok" }> => a.status === "ok" && a.isBoss);
  if (!boss) return { pill: "No boss", tone: "coral", detail: "Choose the agent that runs setup" };
  const f = boss.agent.frontmatter;
  const account = accounts?.find((a) => a.id === f.account);
  const detail = `@${f.id} · ${f.account} · ${f.model ?? "account default"}`;
  const ok =
    account?.status === "healthy" || account?.status === "running-high" || account?.status === "relogin-soon";
  return {
    id: f.id,
    detail,
    pill: ok ? "Healthy" : account ? "Needs you" : "No account",
    tone: ok ? "green" : "coral",
  };
}

/** How many of the five cards are ready. */
export function readyCount(cards: readonly CardState[]): number {
  return cards.filter((c) => c.tone === "green").length;
}
