import {
  collapseHome,
  type HostInfo,
  type HostStatus,
  hostOsOf,
  keyringName,
  type RootScan,
} from "@majhi/shared";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { Dot, type DotTone, toneText } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { SshNotice } from "@/features/repos/ssh-notice";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { useSshReload } from "@/lib/queries";
import type { CardState, Tone } from "./model";

const DOT: Record<Tone, DotTone> = { green: "green", coral: "coral", blue: "neutral", neutral: "neutral" };

/** A state's lamp-free dot and its word, in the state's tone. */
export function StateWord({ state, className }: { state: CardState; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", stateText(state.tone), className)}>
      <Dot tone={DOT[state.tone]} size={7} />
      {state.pill}
    </span>
  );
}

export function stateText(tone: Tone): string {
  return tone === "green" ? toneText("green") : tone === "coral" ? "text-coral" : "text-fg-faint";
}

/** Each root with whether majhi can see it and what the last scan found, then Edit and Mount. */
export function RootsSection({
  roots,
  configured,
  home,
  state,
  actions,
}: {
  roots: readonly RootScan[] | undefined;
  configured: readonly string[];
  home: string;
  state: CardState;
  actions: ReactNode;
}) {
  const list: { path: string; scan: RootScan | undefined }[] =
    roots?.map((r) => ({ path: r.path, scan: r })) ?? configured.map((path) => ({ path, scan: undefined }));
  return (
    <DetailSection
      title="Folders"
      note={<StateWord state={state} className="text-sm" />}
      className="border-t-0"
      actions={actions}
    >
      {list.length === 0 ? (
        <p className="text-base text-fg-muted">No folders yet. Add the folders that hold your repos.</p>
      ) : (
        <ul aria-label="Project folders" className="m-0 flex max-w-[860px] list-none flex-col p-0">
          {list.map(({ path, scan }) => {
            const tone: DotTone =
              scan === undefined ? "neutral" : !scan.mounted || scan.error ? "coral" : "green";
            return (
              <li
                key={path}
                className="flex min-h-11 items-center gap-3 border-t border-line py-2 first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg" title={path}>
                  {collapseHome(path, home)}
                </span>
                {scan?.error && (
                  <span className="min-w-0 max-w-[40%] truncate text-sm text-coral" title={scan.error}>
                    {scan.error}
                  </span>
                )}
                <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", toneText(tone))}>
                  <Dot tone={tone} size={7} />
                  {scan === undefined ? "Checking" : scan.mounted ? "Mounted" : "Not mounted"}
                </span>
                <span className="tnum w-[72px] shrink-0 text-right text-xs text-fg-faint">
                  {scan === undefined ? "" : plural(scan.repos.length, "repo")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </DetailSection>
  );
}

const HOST_STATE: Record<"reachable" | "auth-failed" | "unreachable", { word: string; tone: DotTone }> = {
  reachable: { word: "Reachable", tone: "green" },
  "auth-failed": { word: "Took no key", tone: "coral" },
  unreachable: { word: "Unreachable", tone: "neutral" },
};

/** The keys the helper loaded, any that wait for a passphrase, and whether each git host took one. */
export function SshSection({ host, state }: { host: HostStatus | undefined; state: CardState }) {
  const reload = useSshReload();
  const toast = useToast();
  const hosts = host?.sshHosts ?? [];
  return (
    <>
      <DetailSection
        title="Keys"
        note={<StateWord state={state} className="text-sm" />}
        className="border-t-0"
        actions={
          <Button
            size="sm"
            disabled={reload.isPending}
            onClick={() =>
              reload.mutate(undefined, {
                onError: (error) => toast("Could not check", { detail: error.message, tone: "error" }),
              })
            }
          >
            {reload.isPending ? "Checking" : "Check again"}
          </Button>
        }
      >
        <p className="text-base text-fg-muted">{state.detail}</p>
        <SshNotice bare />
        <p className="max-w-[72ch] text-sm text-fg-faint text-pretty">{keysNote(host?.info)}</p>
      </DetailSection>
      <DetailSection
        title="Git hosts"
        note={hosts.length === 0 ? "Not checked yet" : plural(hosts.length, "host")}
      >
        {hosts.length > 0 && (
          <ul aria-label="Git hosts" className="m-0 flex max-w-[860px] list-none flex-col p-0">
            {hosts.map((h) => {
              const s = HOST_STATE[h.state];
              return (
                <li
                  key={h.host}
                  className="flex min-h-10 items-center gap-3 border-t border-line py-2 first:border-t-0"
                >
                  <span className="w-[220px] shrink-0 truncate font-mono text-sm text-fg" title={h.host}>
                    {h.host}
                  </span>
                  <span
                    className={cn("flex w-[110px] shrink-0 items-center gap-1.5 text-xs", toneText(s.tone))}
                  >
                    <Dot tone={s.tone} size={7} />
                    {s.word}
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-fg-muted text-pretty">{h.detail}</span>
                </li>
              );
            })}
          </ul>
        )}
      </DetailSection>
    </>
  );
}

/** What majhi does with SSH keys, and where a passphrase goes: the Keychain or keyring, else nowhere. */
function keysNote(info: HostInfo | undefined): string {
  const start = "majhi reads public keys only, and no private key is copied into a container.";
  if (info?.keyring?.kind !== "none") {
    return `${start} A passphrase goes to ${keyringName(hostOsOf(info))} once and never to a file.`;
  }
  const nowhere =
    "Until a keyring answers, a passphrase is kept nowhere, and its key locks again when the SSH agent stops.";
  return `${start} ${info.keyring.reason} ${nowhere}`;
}
