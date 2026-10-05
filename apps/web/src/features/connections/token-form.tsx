import {
  type ConnectTokenResult,
  DEFAULT_GIT_HOST,
  FAILURE_LINE,
  gitTokenHelp,
  type MrHost,
  type ServiceEntry,
  serviceById,
} from "@majhi/shared";
import { CircleCheck, ExternalLink } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { useSignInConfirm } from "@/lib/onboarding-queries";

/** What a token of one service is made of: the page, the steps and the scopes to tick. */
interface Recipe {
  title: string;
  link: { label: string; url: string };
  altLink?: { label: string; url: string } | undefined;
  steps: readonly string[];
  scopes: readonly string[];
  email: boolean;
  note?: string | undefined;
}

/**
 * A pasted token, for a git host (public or self-hosted) or a token service. The page that makes the
 * token opens with its scopes ticked where the service allows it. The token is checked with real
 * calls before anything is saved, and a wrong one saves nothing and says why, with the fix.
 */
export function TokenForm({
  org,
  git,
  service,
  onDone,
}: {
  org: string;
  /** A git host: its kind and, for a self-hosted server, its host. */
  git?: { kind: MrHost; host?: string | undefined } | undefined;
  /** A token service (Linear, Sentry, DigitalOcean). */
  service?: ServiceEntry | undefined;
  /** Connected: the connection's id when majhi has it. */
  onDone: (connection?: string) => void;
}) {
  const connect = useConnectionCommand("connections.connectToken");
  const confirm = useSignInConfirm();
  const kind = git?.kind;
  const [host, setHost] = useState(git?.host ?? "");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [priv, setPriv] = useState(false);
  const [result, setResult] = useState<ConnectTokenResult>();
  const publicHost = kind === undefined ? undefined : DEFAULT_GIT_HOST[kind];
  const typedHost = host.trim().toLowerCase();
  const selfHosted = kind !== undefined && typedHost !== "" && typedHost !== publicHost;
  const shownHost = kind === undefined ? undefined : selfHosted ? typedHost : publicHost;

  const recipe: Recipe | undefined =
    kind !== undefined && shownHost !== undefined
      ? (() => {
          const help = gitTokenHelp(kind, shownHost, org, "chosen");
          return {
            title: `Paste a ${kind === "github" ? "GitHub" : kind === "gitlab" ? "GitLab" : "Bitbucket"} token`,
            link: help.link,
            altLink: help.altLink,
            steps: help.steps,
            scopes: help.scopes,
            email: help.fields.includes("email"),
            note: help.note,
          };
        })()
      : service?.token === undefined
        ? undefined
        : {
            title: `Paste a ${service.name} token`,
            link: service.token.page,
            steps: service.token.steps,
            scopes: service.token.scopes,
            email: false,
            note: undefined,
          };
  if (recipe === undefined) return null;
  const serviceId =
    git === undefined
      ? service?.id
      : { github: "github", gitlab: "gitlab-git", bitbucket: "bitbucket" }[git.kind];
  const ready = token.trim() !== "" && (!recipe.email || email.trim() !== "") && serviceId !== undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || serviceId === undefined) return;
    connect.mutate(
      {
        org,
        service: serviceId,
        ...(selfHosted ? { host: typedHost } : {}),
        ...(priv ? { allowPrivate: true } : {}),
        token: token.trim(),
        ...(recipe.email ? { email: email.trim() } : {}),
      },
      {
        onSuccess: (out) => {
          setResult(out);
          if (out.state === "connected") {
            setToken("");
            onDone(out.connection);
          }
        },
      },
    );
  };

  if (result?.state === "confirm") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-base text-fg-soft text-pretty">
          <span className="font-mono">@{result.account}</span> is already used by{" "}
          {result.alsoUsedBy.join(" and ")}. If this workspace uses it too, work in both can reach the same
          repos.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate(result.signIn, { onSuccess: () => onDone() })}
          >
            {confirm.isPending ? "Saving" : "Use it here too"}
          </Button>
          <Button variant="ghost" onClick={() => setResult(undefined)}>
            Cancel
          </Button>
        </div>
        {confirm.error && (
          <p role="alert" className="text-base text-red text-pretty">
            {describeError(confirm.error)}
          </p>
        )}
      </div>
    );
  }
  const failure = result?.state === "failed" ? result : undefined;
  return (
    <section aria-label={recipe.title} className="flex min-w-0 flex-col gap-4">
      {kind !== undefined && (
        <Field
          label={
            kind === "github"
              ? "GitHub Enterprise host"
              : kind === "gitlab"
                ? "Self-managed GitLab host"
                : "Bitbucket Server host"
          }
          hint={`Leave empty for ${publicHost}.`}
        >
          {(p) => (
            <Input
              {...p}
              className="max-w-[320px] font-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder={`git.acme.test`}
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                setResult(undefined);
              }}
            />
          )}
        </Field>
      )}
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {recipe.steps.map((text, i) => (
          <li key={text} className="flex gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line-control font-mono text-xs text-fg-muted tabular-nums"
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="text-base text-fg-soft text-pretty">{text}</p>
              {i === 0 && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" asChild>
                    <a href={recipe.link.url} target="_blank" rel="noreferrer noopener">
                      <ExternalLink aria-hidden="true" />
                      {recipe.link.label}
                    </a>
                  </Button>
                  {recipe.altLink !== undefined && (
                    <Button size="sm" variant="ghost" asChild>
                      <a href={recipe.altLink.url} target="_blank" rel="noreferrer noopener">
                        {recipe.altLink.label}
                      </a>
                    </Button>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {recipe.scopes.length > 0 && (
        <ul aria-label="Scopes to tick" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {recipe.scopes.map((s) => (
            <li
              key={s}
              className="flex h-6 items-center rounded-md border border-line bg-field px-2 font-mono text-xs text-fg"
            >
              {s}
            </li>
          ))}
        </ul>
      )}
      {recipe.note !== undefined && <p className="text-sm text-fg-faint text-pretty">{recipe.note}</p>}
      <form onSubmit={submit} aria-label="Token form" className="flex min-w-0 flex-col gap-3">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {recipe.email && (
            <Field label="Atlassian account email">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Token">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono"
                placeholder="Paste the token"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setResult(undefined);
                }}
              />
            )}
          </Field>
        </div>
        {failure !== undefined && (
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-lg border border-red-line bg-red-wash p-3"
          >
            <p className="text-base font-medium text-red">{FAILURE_LINE[failure.failure.reason]}.</p>
            <p className="text-base text-fg-soft text-pretty">{failure.failure.fix ?? failure.message}</p>
            {failure.failure.reason === "blocked-host" && (
              <Switch
                label="This server is on my own network"
                checked={priv}
                onChange={setPriv}
                title="Lets majhi send the token to a private address. Metadata addresses are never allowed."
              />
            )}
            {failure.failure.fixUrl !== undefined && (
              <div>
                <Button size="sm" asChild>
                  <a href={failure.failure.fixUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink aria-hidden="true" />
                    Open the page
                  </a>
                </Button>
              </div>
            )}
          </div>
        )}
        {connect.error && (
          <p role="alert" className="text-base text-red text-pretty">
            {describeError(connect.error)}
          </p>
        )}
        {result?.state === "connected" ? (
          <p role="status" className="flex items-center gap-2 text-base text-fg">
            <CircleCheck aria-hidden="true" className="size-4 text-green" />
            Connected{result.account === undefined ? "" : ` as ${result.account}`}.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={!ready || connect.isPending}>
              {connect.isPending ? "Checking" : "Check and connect"}
            </Button>
            <span className="text-sm text-fg-faint">
              majhi calls{" "}
              {shownHost ??
                (service?.token === undefined ? "the service" : new URL(service.token.page.url).host)}{" "}
              with it first. A wrong token saves nothing.
            </span>
          </div>
        )}
      </form>
    </section>
  );
}

/** The catalog entry of a git host, for a card that offers its token. */
export function gitEntry(kind: MrHost): ServiceEntry | undefined {
  return serviceById({ github: "github", gitlab: "gitlab-git", bitbucket: "bitbucket" }[kind]);
}
