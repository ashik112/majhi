import {
  type ConnectAccess,
  type ConnectionType,
  DEFAULT_GIT_HOST,
  FAILURE_LINE,
  type OrgView,
  type ProbeMcpResult,
  type ServiceEntry,
  scopesAt,
} from "@majhi/shared";
import { ExternalLink } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SignIn } from "@/features/git-signin/sign-in";
import { useConnectCatalog, useConnectCommand, useConnectStatus } from "@/lib/connect-queries";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { ConnectFlowCard, ScopeList } from "./connect-flow";
import { NewConnection } from "./new-connection";
import { defaultProducts, ProductPicker } from "./product-picker";
import { TokenForm } from "./token-form";

const hasSend = (s: ServiceEntry) => s.scopes.some((x) => x.level === "send");
const hasWrite = (s: ServiceEntry) => s.scopes.some((x) => x.access === "write");

/**
 * One click: the service's own page signs majhi in. The attempt ends connected only when a real call
 * with the new sign-in passed, and otherwise says why and leaves the connection to fix.
 */
export function OneClickBody({
  org,
  entry,
  onDone,
}: {
  org: string;
  entry: ServiceEntry;
  onDone: (connection?: string) => void;
}) {
  const start = useConnectCommand("connect.start");
  const status = useConnectStatus();
  const catalog = useConnectCatalog();
  const [flow, setFlow] = useState<string>();
  const have = (status.data ?? []).filter((s) => s.org === org && s.service === entry.id).length;
  const [name, setName] = useState(have === 0 ? entry.name : `${entry.name} ${have + 1}`);
  const [access, setAccess] = useState<ConnectAccess>("read");
  const [products, setProducts] = useState<string[]>(defaultProducts(entry.products));
  const cli = entry.kind === "cli-login";
  const begin = () =>
    start.mutate(
      {
        org,
        service: entry.id,
        access,
        ...(name.trim() === "" || name.trim() === entry.name ? {} : { name: name.trim() }),
        ...(entry.products === undefined ? {} : { products }),
      },
      { onSuccess: (view) => setFlow(view.flow) },
    );
  if (flow !== undefined) {
    return (
      <ConnectFlowCard
        flow={flow}
        onRetry={() => {
          setFlow(undefined);
          begin();
        }}
        onDone={(connection) => {
          setFlow(undefined);
          onDone(connection);
        }}
      />
    );
  }
  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <p className="text-base text-fg-muted text-pretty">
        {cli
          ? `Sign in through ${entry.name}'s own login. majhi keeps this sign-in separate from other connections.`
          : `Continue to ${entry.name} to sign in and approve access. You come back here when it is connected.`}
      </p>
      <Field label="Name" hint="Agents see this name.">
        {(p) => (
          <Input
            {...p}
            className="max-w-[320px]"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      {entry.products !== undefined && (
        <ProductPicker products={entry.products} value={products} onChange={setProducts} />
      )}
      {cli && catalog.data?.helper === false && (
        <p role="alert" className="text-base text-amber text-pretty">
          majhi's helper is not running, so the tool cannot sign in now. Start the helper first.
        </p>
      )}
      {hasSend(entry) ? (
        <ChoiceGroup
          label="What agents may do"
          value={access}
          choices={[
            { value: "read" as const, label: "Read only" },
            { value: "readwrite" as const, label: "Read and write" },
            { value: "send" as const, label: "Read, write and send" },
          ]}
          onChange={setAccess}
        />
      ) : !cli && hasWrite(entry) ? (
        <Switch
          label="Also let agents change things"
          checked={access !== "read"}
          onChange={(on) => setAccess(on ? "readwrite" : "read")}
          title="Writes still ask you first unless the workspace allows that exact action"
        />
      ) : null}
      <ScopeList scopes={scopesAt(entry, access).map((s) => ({ access: s.access, sentence: s.sentence }))} />
      {entry.note && <p className="text-sm text-amber text-pretty">{entry.note}</p>}
      {start.error && (
        <p role="alert" className="text-base text-red text-pretty">
          {describeError(start.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={start.isPending || (cli && catalog.data?.helper === false)}
          onClick={begin}
        >
          {start.isPending ? "Opening" : cli ? `Sign in with ${entry.name}` : `Connect ${entry.name}`}
        </Button>
        <a
          href={entry.docs}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm text-fg-faint underline-offset-2 hover:text-fg hover:underline"
        >
          {entry.name} docs
        </a>
      </div>
    </div>
  );
}

/** GitHub, GitLab and Bitbucket: the host's own page on this Mac, or a pasted token, at the public host or a self-hosted one. */
export function GitHostBody({
  org,
  orgs,
  entry,
  onDone,
}: {
  org: string;
  orgs: readonly OrgView[];
  entry: ServiceEntry;
  onDone: (connection?: string) => void;
}) {
  const kind = entry.gitKind ?? "github";
  const [paste, setPaste] = useState(kind === "bitbucket");
  const name = orgs.find((o) => o.id === org)?.name ?? org;
  return (
    <div className="flex max-w-[660px] flex-col gap-4">
      {kind !== "bitbucket" && (
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
          <legend className="sr-only">How to sign in</legend>
          <Button variant={paste ? "ghost" : "secondary"} size="sm" onClick={() => setPaste(false)}>
            Sign in on this Mac
          </Button>
          <Button variant={paste ? "secondary" : "ghost"} size="sm" onClick={() => setPaste(true)}>
            Paste a token
          </Button>
          <span className="text-sm text-fg-faint">
            {paste
              ? "Works for self-hosted servers too."
              : `Uses the ${kind === "github" ? "gh" : "glab"} sign-in on this Mac. ${kind === "github" ? "GitHub Enterprise" : "A self-managed GitLab"} takes a token.`}
          </span>
        </fieldset>
      )}
      {kind === "bitbucket" && entry.note !== undefined && (
        <p className="text-sm text-fg-muted text-pretty">{entry.note}</p>
      )}
      {paste ? (
        <TokenForm org={org} git={{ kind }} onDone={onDone} />
      ) : (
        <SignIn
          workspace={{ id: org, name }}
          kind={kind}
          names={new Map(orgs.map((o) => [o.id, o.name]))}
          onClose={() => onDone()}
        />
      )}
      <p className="text-sm text-fg-faint text-pretty">
        {DEFAULT_GIT_HOST[kind]} is the default host. Enter another host in the token form for{" "}
        {kind === "github"
          ? "GitHub Enterprise"
          : kind === "gitlab"
            ? "a self-managed GitLab"
            : "Bitbucket Server"}
        .
      </p>
    </div>
  );
}

/** An MCP server by address: majhi asks how it signs in, then connects it the way it says. */
export function McpUrlBody({ org, onDone }: { org: string; onDone: (connection?: string) => void }) {
  const probe = useConnectionCommand("connections.probeMcp");
  const connectUrl = useConnectionCommand("connections.connectMcpUrl");
  const start = useConnectCommand("connect.start");
  const [url, setUrl] = useState("");
  const [priv, setPriv] = useState(false);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [flow, setFlow] = useState<string>();
  const found: ProbeMcpResult | undefined = probe.data;
  const failure = connectUrl.data?.state === "failed" ? connectUrl.data : undefined;

  const check = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() === "") return;
    probe.mutate({ url: url.trim(), ...(priv ? { allowPrivate: true } : {}) });
  };
  if (flow !== undefined) {
    return (
      <ConnectFlowCard
        flow={flow}
        onRetry={() => setFlow(undefined)}
        onDone={(connection) => {
          setFlow(undefined);
          onDone(connection);
        }}
      />
    );
  }
  const refused = probe.error !== undefined && probe.error !== null;
  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <form onSubmit={check} className="flex flex-col gap-3" aria-label="MCP server address">
        <Field label="Address" hint="The server's address, like https://mcp.acme.test/mcp.">
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://mcp.acme.test/mcp"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                probe.reset();
              }}
            />
          )}
        </Field>
        {refused && (
          <p role="alert" className="text-base text-red text-pretty">
            {describeError(probe.error)}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={url.trim() === "" || probe.isPending}>
            {probe.isPending ? "Asking" : "Check the address"}
          </Button>
        </div>
      </form>
      {found !== undefined && (
        <section aria-label="How it signs in" className="flex flex-col gap-3 border-t border-line pt-4">
          {found.method === "unreachable" && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-lg border border-red-line bg-red-wash p-3"
            >
              <p className="text-base font-medium text-red">{FAILURE_LINE[found.failure.reason]}.</p>
              <p className="text-base text-fg-soft text-pretty">
                {found.failure.fix ?? "Check the address."}
              </p>
              {(found.failure.reason === "blocked-host" || found.failure.reason === "unexpected") && (
                <Switch
                  label="This server is on my own network"
                  checked={priv}
                  onChange={(on) => {
                    setPriv(on);
                    probe.reset();
                  }}
                  title="Lets majhi reach a private address and an http address. Metadata addresses are never allowed."
                />
              )}
            </div>
          )}
          {found.method === "oauth" && (
            <>
              <p className="text-base text-fg-muted text-pretty">
                This server signs you in on its own page and lets majhi register itself. One click.
              </p>
              <Field label="Name" hint="Agents see this name.">
                {(p) => (
                  <Input
                    {...p}
                    className="max-w-[320px]"
                    value={name}
                    placeholder={new URL(found.url).host}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              {start.error && (
                <p role="alert" className="text-base text-red text-pretty">
                  {describeError(start.error)}
                </p>
              )}
              <div>
                <Button
                  variant="primary"
                  disabled={start.isPending}
                  onClick={() =>
                    start.mutate(
                      {
                        org,
                        url: found.url,
                        access: "read",
                        ...(priv ? { allowPrivate: true } : {}),
                        ...(name.trim() === "" ? {} : { name: name.trim() }),
                      },
                      { onSuccess: (view) => setFlow(view.flow) },
                    )
                  }
                >
                  {start.isPending ? "Opening" : "Connect"}
                </Button>
              </div>
            </>
          )}
          {(found.method === "token" || found.method === "oauth-needs-app") && (
            <>
              <p className="text-base text-fg-muted text-pretty">
                {found.method === "token"
                  ? "This server wants a token in a header."
                  : "This server signs in, but only for an app registered by hand. Paste a token instead."}
              </p>
              <Field
                label="Token"
                hint="Sent as Authorization: Bearer. It is checked with initialize and tools/list first."
              >
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    className="font-mono"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Name">
                {(p) => (
                  <Input
                    {...p}
                    className="max-w-[320px]"
                    value={name}
                    placeholder={new URL(found.url).host}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          {found.method === "open" && (
            <>
              <p className="text-base text-fg-muted text-pretty">
                This server answers without any sign-in. majhi adds it and lists its tools.
              </p>
              <Field label="Name">
                {(p) => (
                  <Input
                    {...p}
                    className="max-w-[320px]"
                    value={name}
                    placeholder={new URL(found.url).host}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          {(found.method === "token" || found.method === "oauth-needs-app" || found.method === "open") && (
            <>
              {failure !== undefined && (
                <p role="alert" className="text-base text-red text-pretty">
                  {FAILURE_LINE[failure.failure.reason]}. {failure.failure.fix}
                </p>
              )}
              {connectUrl.error && (
                <p role="alert" className="text-base text-red text-pretty">
                  {describeError(connectUrl.error)}
                </p>
              )}
              <div>
                <Button
                  variant="primary"
                  disabled={connectUrl.isPending || (found.method !== "open" && token.trim() === "")}
                  onClick={() =>
                    connectUrl.mutate(
                      {
                        org,
                        url: found.url,
                        ...(name.trim() === "" ? {} : { name: name.trim() }),
                        ...(found.method === "open" ? {} : { token: token.trim() }),
                        ...(priv ? { allowPrivate: true } : {}),
                      },
                      {
                        onSuccess: (out) => {
                          if (out.state === "connected") {
                            setToken("");
                            onDone(out.connection);
                          }
                        },
                      },
                    )
                  }
                >
                  {connectUrl.isPending ? "Checking" : "Check and connect"}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** A custom connection (SSH, Kubernetes, mail, a browser, values): the form of its type, inside the dialog. */
export function CustomBody({
  org,
  orgs,
  type,
  onDone,
  onBack,
}: {
  org: string;
  orgs: readonly OrgView[];
  type: ConnectionType;
  onDone: (connection?: string) => void;
  onBack: () => void;
}) {
  return (
    <NewConnection bare orgs={orgs} defaultOrg={org} initialType={type} onCreated={onDone} onClose={onBack} />
  );
}

/** The page the owner makes a token on, as a plain link. */
export function ExternalLinkButton({ href, children }: { href: string; children: string }) {
  return (
    <Button size="sm" asChild>
      <a href={href} target="_blank" rel="noreferrer noopener">
        <ExternalLink aria-hidden="true" />
        {children}
      </a>
    </Button>
  );
}
