import type { MrHost } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useGitLogins, useOrgs, useSaveSecret, useUpdateOrg, useUseGitLogin } from "@/lib/studio-queries";

const HOST_OF: Record<string, MrHost | undefined> = { github: "github", gitlab: "gitlab" };

/** The MR host a git host name belongs to, like `gitlab.example.com` -> gitlab. */
function mrHostOfName(name: string): MrHost | undefined {
  const label = name.split(/[.-]/).find((l) => HOST_OF[l] !== undefined);
  return label === undefined ? undefined : HOST_OF[label];
}

/**
 * Offers a `gh` or `glab` login found on this computer as the org's token, with one click. For Bitbucket,
 * which has no login to find, it asks for an Atlassian API token in a field. Nothing shows when the org
 * already has a token for the host.
 */
export function GitLoginOffer({
  org,
  orgName,
  host,
  onUsed,
}: {
  org: string;
  orgName: string;
  /** Limits the offer to one MR host. Without it every host with a login shows. */
  host?: MrHost | undefined;
  onUsed?: (host: MrHost, ref: string) => void;
}) {
  const logins = useGitLogins();
  const orgs = useOrgs();
  const use = useUseGitLogin();
  const tokens = orgs.data?.find((o) => o.id === org)?.mrTokens ?? {};
  const [failure, setFailure] = useState<string>();
  const found = (logins.data?.hosts ?? []).flatMap((h) =>
    h.logins
      .filter((l) => l.via !== "ssh")
      .flatMap((l) => {
        const mr = mrHostOfName(h.host) ?? (l.via === "gh" ? "github" : "gitlab");
        return (host === undefined || host === mr) &&
          tokens[mr] === undefined &&
          (l.via === "gh") === (mr === "github")
          ? [{ host: h.host, mr, via: l.via as "gh" | "glab", account: l.account }]
          : [];
      }),
  );
  return (
    <>
      {found.map((f) => (
        <p
          key={`${f.via}:${f.host}:${f.account}`}
          className="m-0 flex flex-wrap items-center gap-2 text-sm text-fg-soft"
        >
          <span>
            Found {f.via} login <span className="font-mono text-fg">{f.account}</span> on {f.host}. Use it for{" "}
            {orgName}?
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={use.isPending}
            onClick={() => {
              setFailure(undefined);
              use.mutate(
                { id: org, via: f.via, host: f.host },
                { onSuccess: (r) => onUsed?.(r.host, r.ref), onError: (e) => setFailure(describeError(e)) },
              );
            }}
          >
            Use
          </Button>
        </p>
      ))}
      {host === "bitbucket" && tokens.bitbucket === undefined && <BitbucketField org={org} />}
      {failure && (
        <p role="alert" className="m-0 text-sm text-red">
          {failure}
        </p>
      )}
    </>
  );
}

/** Bitbucket needs an Atlassian API token with Bitbucket scopes: `email:api-token`. It is saved as a secret for this org. */
function BitbucketField({ org }: { org: string }) {
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState<string>();
  const save = useSaveSecret();
  const orgs = useOrgs();
  const update = useUpdateOrg();
  const current = orgs.data?.find((o) => o.id === org)?.mrTokens ?? {};
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-fg-soft">
        {HOST_LABEL.bitbucket} needs an Atlassian API token with Bitbucket scopes. Paste it as email:token.
      </span>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Bitbucket API token"
          type="password"
          autoComplete="new-password"
          placeholder="Atlassian email:API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={value.trim() === "" || save.isPending || update.isPending}
          onClick={async () => {
            setFailure(undefined);
            try {
              const { ref } = await save.mutateAsync({
                value: value.trim(),
                label: `${org} bitbucket token`,
              });
              await update.mutateAsync({ id: org, mr_tokens: { ...current, bitbucket: ref } });
              setValue("");
            } catch (e) {
              setFailure(describeError(e));
            }
          }}
        >
          Save
        </Button>
      </div>
      {failure && (
        <p role="alert" className="m-0 text-sm text-red">
          {failure}
        </p>
      )}
    </div>
  );
}
