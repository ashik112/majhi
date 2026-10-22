import type { HostStatus, RootScan } from "@majhi/shared";

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
