import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { useMakeSshKey, useSshPublicKeys } from "@/lib/queries";
import { useCopy } from "@/lib/use-copy";

/** What majhi tried: the keys a host accepted that name no account. */
export interface TriedKey {
  alias?: string | undefined;
  fingerprint?: string | undefined;
}

const short = (fingerprint: string) => fingerprint.replace(/^SHA256:/, "").slice(0, 12);

/**
 * The exact step when a host does not know this computer's SSH key: the key to paste, which keys
 * majhi tried, and the host's page that takes it. With no key at all, a button makes one.
 */
export function SshKeyStep({
  host,
  keysPage,
  tried,
}: {
  host?: string | undefined;
  /** The host's add-key page. Absent for a host majhi does not know. */
  keysPage?: string | undefined;
  tried?: readonly TriedKey[] | undefined;
}) {
  const keys = useSshPublicKeys();
  const make = useMakeSshKey();
  const copy = useCopy();
  const list = keys.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      {host !== undefined && tried !== undefined && tried.length > 0 && (
        <span className="text-sm text-fg-faint">
          {host} accepted{" "}
          {tried.map((t, i) => (
            <span key={`${t.alias ?? "default"}-${t.fingerprint ?? i}`}>
              {i > 0 && ", "}
              {t.alias === undefined ? "the default key" : `the key of ${t.alias}`}
              {t.fingerprint === undefined ? "" : ` (${short(t.fingerprint)})`}
            </span>
          ))}
          . It does not say which account owns it.
        </span>
      )}
      {list.length === 0 ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
          This computer has no SSH key yet.
          <Button size="sm" disabled={make.isPending} onClick={() => make.mutate()}>
            <KeyRound aria-hidden="true" />
            {make.isPending ? "Making a key" : "Make a key"}
          </Button>
        </span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {list.map((k) => (
            <li key={k.path} className="flex flex-col gap-1">
              <span className="text-sm text-fg-faint">
                Add this key as <span className="font-mono text-fg-muted">{k.path}</span>
                {k.fingerprint === undefined ? "" : ` (${short(k.fingerprint)})`}
              </span>
              <div className="flex items-start gap-2 rounded-md border border-line-strong bg-sunken py-1.5 pr-1 pl-3">
                <code className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{k.publicKey}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Copy the public key ${k.path}`}
                  onClick={() => void copy(k.publicKey, k.path)}
                >
                  <Copy aria-hidden="true" />
                  Copy
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {make.error && (
        <p role="alert" className="m-0 text-sm text-red">
          {describeError(make.error)}
        </p>
      )}
      {host !== undefined && keysPage !== undefined && (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-faint">
          <Button asChild size="sm">
            <a href={keysPage} target="_blank" rel="noopener noreferrer">
              Add the key on {host}
              <ExternalLink aria-hidden="true" />
            </a>
          </Button>
          then Detect again.
        </span>
      )}
    </div>
  );
}
