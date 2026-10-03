import { DEFAULT_GIT_HOST, gitTokenHelp, type MrHost, type PasteReason } from "@majhi/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { describeError } from "@/lib/errors";
import { HOST_LABEL } from "@/lib/hosts";
import { useSignInToken } from "@/lib/onboarding-queries";
import { ExternalButton } from "@/onboarding/bits";
import { Problem } from "@/onboarding/step-frame";
import { Outcome, type SignInWorkspace } from "./sign-in";

/**
 * A token for one workspace, made on the host's own page: the exact steps from `gitTokenHelp`, a
 * link that fills in the name and scopes where the host allows it, then the fields. majhi asks the
 * host whose token it is before it saves anything. Bitbucket takes the Atlassian email too; GitLab
 * takes another host for a self-hosted one.
 */
export function TokenPaste({
  workspace,
  kind,
  host: firstHost,
  reason,
  names,
  onClose,
}: {
  workspace: SignInWorkspace;
  kind: MrHost;
  host: string;
  reason: PasteReason;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const save = useSignInToken();
  const [host, setHost] = useState(firstHost);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const typedHost = host.trim().toLowerCase() || DEFAULT_GIT_HOST[kind];
  const help = gitTokenHelp(kind, typedHost, workspace.id, reason);
  const label = HOST_LABEL[kind];
  const needsEmail = help.fields.includes("email");
  const ready = token.trim() !== "" && (!needsEmail || email.trim() !== "");
  const status = save.data;

  if (status?.state === "done" || status?.state === "confirm") {
    return <Outcome status={status} workspace={workspace} names={names} onClose={onClose} />;
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    save.mutate(
      {
        org: workspace.id,
        kind,
        ...(kind === "gitlab" && typedHost !== DEFAULT_GIT_HOST.gitlab ? { host: typedHost } : {}),
        token: token.trim(),
        ...(needsEmail ? { email: email.trim() } : {}),
      },
      { onSuccess: (s) => s.state === "failed" || setToken("") },
    );
  };

  return (
    <section aria-label={`${label} token for ${workspace.name}`} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-md font-semibold text-fg">
          {kind === "bitbucket" ? "Sign in with a Bitbucket API token" : `Paste a ${label} token`}
        </h3>
        {help.note && kind !== "bitbucket" && (
          <p className="m-0 text-base text-fg-muted text-pretty">
            {help.note}
            {help.install && (
              <>
                {" "}
                <a
                  href={help.install.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg-soft underline decoration-line-control underline-offset-[3px] hover:text-fg"
                >
                  {help.install.label}
                </a>
              </>
            )}
          </p>
        )}
      </div>
      {kind === "gitlab" && (
        <Field label="GitLab host" hint="gitlab.com, or your company's own GitLab">
          {(p) => (
            <Input
              {...p}
              className="h-10 max-w-[320px] font-mono"
              autoComplete="off"
              spellCheck={false}
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          )}
        </Field>
      )}
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {help.steps.map((text, i) => (
          <li key={text} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-control font-mono text-xs text-fg-muted tabular-nums"
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
              <p className="m-0 text-base text-fg-soft text-pretty">{text}</p>
              {i === 0 && (
                <div>
                  <ExternalButton href={help.link.url} size="md">
                    {help.link.label}
                  </ExternalButton>
                </div>
              )}
              {kind === "bitbucket" && /scopes below/.test(text) && (
                <>
                  <Scopes scopes={help.scopes} />
                  {help.note && <p className="m-0 text-sm text-fg-faint">{help.note}</p>}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} aria-label={`${label} token`} className="flex flex-col gap-3">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {needsEmail && (
            <Field label="Atlassian account email">
              {(p) => (
                <Input
                  {...p}
                  className="h-10"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label={kind === "bitbucket" ? "API token" : "Token"}>
            {(p) => (
              <Input
                {...p}
                className="h-10 font-mono"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder="Paste the token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            )}
          </Field>
        </div>
        {save.error && <Problem>{describeError(save.error)}</Problem>}
        {status?.state === "failed" && <Problem>{status.reason}</Problem>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="lg" disabled={!ready || save.isPending}>
            {save.isPending ? "Checking" : "Check and save"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}

/** The scope names to tick on Atlassian's page. */
function Scopes({ scopes }: { scopes: readonly string[] }) {
  return (
    <ul aria-label="Scopes" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {scopes.map((s) => (
        <li
          key={s}
          className="flex h-7 items-center rounded-md border border-line bg-field px-2.5 font-mono text-sm text-fg"
        >
          {s}
        </li>
      ))}
    </ul>
  );
}
