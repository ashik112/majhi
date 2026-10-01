import type { GitAccount } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { describeError } from "@/lib/errors";
import { useGitLogins, useOrgs, useSetGitAccount, useUpdateOrg } from "@/lib/studio-queries";

/** Where a host's token is pasted: GitHub and GitLab can adopt a login, Bitbucket and GitLab take a paste. */
const PASTE_HINT = (host: string) =>
  host.includes("bitbucket") ? "username:app-password" : host.includes("github") ? "token" : "personal access token";

/** The git accounts of one org: who it pushes as per host, and whether its key, token and identity are ready. */
export function GitAccounts({ org }: { org: { id: string; name: string } }) {
  const view = useOrgs().data?.find((o) => o.id === org.id);
  const logins = useGitLogins();
  const { set, remove } = useSetGitAccount();
  const [pick, setPick] = useState("");
  const [failure, setFailure] = useState<string>();
  const accounts = view?.gitAccounts ?? [];
  const hosts = logins.data?.hosts ?? [];
  const sshOf = (a: GitAccount) =>
    hosts.find((h) => h.host === a.host)?.logins.some(
      (l) =>
        l.via === "ssh" &&
        l.account.toLowerCase() === a.account.toLowerCase() &&
        (a.ssh === undefined || (a.ssh === "default" ? l.alias === undefined : l.alias === a.ssh)),
    ) === true;
  // One option per detected account of a host, with the SSH route when it has one.
  const options = hosts.flatMap((h) => {
    const seen = new Set<string>();
    return h.logins.flatMap((l) => {
      const key = `${h.host}\n${l.account}\n${l.via === "ssh" ? (l.alias ?? "") : ""}`;
      const taken = accounts.some((a) => a.host === h.host && a.account.toLowerCase() === l.account.toLowerCase());
      if (seen.has(key) || taken) return [];
      seen.add(key);
      return [{ key, host: h.host, account: l.account, ssh: l.via === "ssh" ? (l.alias ?? "default") : undefined }];
    });
  });
  const run = (fn: () => Promise<unknown>) => {
    setFailure(undefined);
    fn().catch((e: unknown) => setFailure(describeError(e)));
  };
  return (
    <section className="mt-6 flex min-w-0 flex-col gap-3" aria-label="Git accounts">
      <h3 className="m-0 text-base font-semibold text-fg">Git accounts</h3>
      <p className="m-0 text-sm text-fg-faint">
        The account {org.name} pushes and opens merge requests as on each host.
      </p>
      {accounts.map((a) => (
        <AccountRow
          key={`${a.host}/${a.account}`}
          org={org.id}
          account={a}
          sshOk={sshOf(a)}
          hasIdentity={view?.identity !== undefined}
          onRemove={() => run(() => remove.mutateAsync({ id: org.id, host: a.host, account: a.account }))}
          onToken={(token) =>
            run(() =>
              set.mutateAsync({
                id: org.id,
                host: a.host,
                account: a.account,
                ...(a.ssh === undefined ? {} : { ssh: a.ssh }),
                token,
              }),
            )
          }
        />
      ))}
      <div className="flex items-center gap-2">
        <Select
          aria-label="Add a git account"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="max-w-sm"
        >
          <option value="">{options.length === 0 ? "No logins found on this Mac" : "Pick a detected login"}</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.account} on {o.host}
              {o.ssh === undefined ? "" : o.ssh === "default" ? "" : ` (${o.ssh})`}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pick === "" || set.isPending}
          onClick={() => {
            const o = options.find((x) => x.key === pick);
            if (o === undefined) return;
            run(async () => {
              await set.mutateAsync({
                id: org.id,
                host: o.host,
                account: o.account,
                ...(o.ssh === undefined ? {} : { ssh: o.ssh }),
              });
              setPick("");
            });
          }}
        >
          + Add
        </Button>
      </div>
      {failure && (
        <p role="alert" className="m-0 text-sm text-red">
          {failure}
        </p>
      )}
    </section>
  );
}

function AccountRow({
  org,
  account,
  sshOk,
  hasIdentity,
  onRemove,
  onToken,
}: {
  org: string;
  account: GitAccount;
  sshOk: boolean;
  hasIdentity: boolean;
  onRemove: () => void;
  onToken: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  const [name, setName] = useState(account.account);
  const [email, setEmail] = useState("");
  const update = useUpdateOrg();
  const [failure, setFailure] = useState<string>();
  const tag = (ok: boolean, good: string) => (
    <span className={ok ? "text-green" : "text-amber"}>{ok ? good : ""}</span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-mono text-fg">{account.account}</span>
        <span className="text-fg-faint">{account.host}</span>
        {tag(sshOk, "SSH ok")}
        {tag(account.token !== undefined, "token ok")}
        {tag(hasIdentity, "identity ok")}
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {!sshOk && (
        <p className="m-0 text-sm text-amber">
          No SSH key on this Mac logs in as {account.account}. Pushes for {org} are refused until one does.
        </p>
      )}
      {account.token === undefined && (
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Token for ${account.account}`}
            type="password"
            autoComplete="new-password"
            placeholder={PASTE_HINT(account.host)}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={token.trim() === ""}
            onClick={() => {
              onToken(token.trim());
              setToken("");
            }}
          >
            Save token
          </Button>
        </div>
      )}
      {!hasIdentity && (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Commit name" value={name} onChange={(e) => setName(e.target.value)} className="max-w-48" />
          <Input
            aria-label="Commit email"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="max-w-64"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={name.trim() === "" || email.trim() === "" || update.isPending}
            onClick={() => {
              setFailure(undefined);
              update.mutate(
                { id: org, identity: { name: name.trim(), email: email.trim() } },
                { onError: (e) => setFailure(describeError(e)) },
              );
            }}
          >
            Set identity
          </Button>
        </div>
      )}
      {failure && (
        <p role="alert" className="m-0 text-sm text-red">
          {failure}
        </p>
      )}
    </div>
  );
}
