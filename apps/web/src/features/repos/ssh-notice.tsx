import { type SshHostCheck, type SshStatus, sshUnlockCommand } from "@majhi/shared";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useHostStatus, useSshReload, useSshUnlock } from "@/lib/queries";

/** True when majhi's git cannot reach hosts over SSH yet: no key loaded, or a key waits for its passphrase. */
export function sshNeedsAttention(ssh: SshStatus | undefined): ssh is SshStatus {
  return ssh !== undefined && (ssh.loaded === 0 || ssh.needsPassphrase.length > 0);
}

/**
 * One calm notice on the Projects and Hub setup pages. It shows nothing while SSH works, or while the host
 * helper has not reported yet.
 */
export function SshNotice({ className }: { className?: string }) {
  const status = useHostStatus().data;
  const ssh = status?.info?.ssh;
  const failing = (status?.sshHosts ?? []).filter((h) => h.state === "auth-failed");
  const reload = useSshReload();
  const toast = useToast();
  const keys = sshNeedsAttention(ssh) ? ssh : undefined;
  if (keys === undefined && failing.length === 0) return null;

  const checkAgain = () =>
    reload.mutate(undefined, {
      onSuccess: (next) => {
        if (!sshNeedsAttention(next)) toast("SSH keys are loaded");
      },
      onError: (error) => toast("Could not check", { detail: error.message, tone: "error" }),
    });

  return (
    <section
      aria-labelledby="ssh-notice-title"
      className={cn(
        "flex shrink-0 flex-col gap-3 rounded-xl border border-amber-line bg-amber-wash px-4 py-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <KeyRound aria-hidden="true" className="size-4 shrink-0 text-amber" />
        <h2 id="ssh-notice-title" className="min-w-0 flex-1 text-base font-medium text-fg">
          majhi cannot reach your git hosts over SSH yet.
        </h2>
        <Button variant="secondary" size="sm" onClick={checkAgain} disabled={reload.isPending}>
          {reload.isPending ? "Checking" : "Check again"}
        </Button>
      </div>

      {keys === undefined ? (
        <FailingHosts hosts={failing} />
      ) : keys.needsPassphrase.length > 0 ? (
        <>
          <ul className="flex flex-col gap-2">
            {keys.needsPassphrase.map((key) => (
              <li key={key}>
                <UnlockCard sshKey={key} />
              </li>
            ))}
          </ul>
          <details className="text-sm text-fg-faint">
            <summary className="w-fit cursor-pointer select-none hover:text-fg-muted">
              or run it yourself
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {keys.needsPassphrase.map((key) => (
                <CommandLine key={key} command={sshUnlockCommand(key)} />
              ))}
            </div>
          </details>
        </>
      ) : (
        <p className="text-sm text-fg-muted text-pretty">
          {keys.error ?? "No SSH key was found in ~/.ssh."} Add a key to ~/.ssh and to your git host, then
          check again.
        </p>
      )}
    </section>
  );
}

/** A passphrase field for one key. The value is cleared as soon as it is sent. */
function UnlockCard({ sshKey }: { sshKey: string }) {
  const unlock = useSshUnlock();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | undefined>();
  const toast = useToast();
  const fieldId = `ssh-pass-${sshKey}`;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (passphrase === "" || unlock.isPending) return;
    const sent = passphrase;
    setPassphrase("");
    setError(undefined);
    unlock.mutate(
      { key: sshKey, passphrase: sent },
      {
        onSuccess: () => toast("SSH key unlocked", { detail: sshKey }),
        onError: (e) => setError(e.message),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor={fieldId} className="text-sm text-fg">
          Unlock SSH key <span className="font-mono text-fg-muted">{sshKey}</span>
        </label>
        <Input
          id={fieldId}
          type="password"
          autoComplete="off"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="Passphrase"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          className="w-64"
        />
        <Button type="submit" variant="primary" size="md" disabled={passphrase === "" || unlock.isPending}>
          {unlock.isPending ? "Unlocking" : "Unlock"}
        </Button>
      </div>
      {error && (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
    </form>
  );
}

/** Hosts that answered but took none of the keys ssh offered. */
function FailingHosts({ hosts }: { hosts: readonly SshHostCheck[] }) {
  return (
    <ul className="flex flex-col gap-1 text-sm text-fg-muted">
      {hosts.map((h) => (
        <li key={h.host}>
          <span className="font-mono text-fg">{h.host}</span> did not accept any SSH key. Check that its key
          is added on the host, then check again.
        </li>
      ))}
    </ul>
  );
}
