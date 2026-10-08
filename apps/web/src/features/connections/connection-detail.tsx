import {
  type ConnectionHealth,
  type ConnectionView,
  connectionType,
  failureSentences,
  GLOBAL_CONNECTIONS,
  hostPorts,
  type OrgView,
  type ServiceProduct,
  scopesAt,
  serviceById,
  serviceByUrl,
} from "@majhi/shared";
import { Check, ExternalLink, Wrench } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { DetailSection } from "@/components/ui/list-detail";
import { PageLink } from "@/components/ui/page-link";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { Textarea } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { SignIn } from "@/features/git-signin/sign-in";
import { useConfirmWebhook } from "@/lib/client-queries";
import { cn } from "@/lib/cn";
import { useConnectCommand } from "@/lib/connect-queries";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError, errorDetails } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useAgents } from "@/lib/studio-queries";
import { ChatGroups } from "./chat-groups";
import { ConnectFlowCard, ScopeList } from "./connect-flow";
import { isOauth, useReconnect } from "./connect-section";
import { ConnectionFields } from "./connection-fields";
import { type ConnectionDraft, draftOf, updateInput } from "./model";
import { ProductPicker } from "./product-picker";
import { scopeAudience, scopeName, WorkspaceTag } from "./scope-picker";
import { SlackChannels } from "./slack-channels";
import { fixOf, rowStatus } from "./status";
import { TokenForm } from "./token-form";
import { ToolGateList } from "./tool-gate-list";

/**
 * The picked connection, in a side panel: its one status and what to do about it, what agents can do
 * with it, who shares it, then its settings. Remove is last.
 */
export function ConnectionPanel({
  view,
  orgs,
  checking,
  now,
  onCheck,
  onClose,
  onRemoved,
}: {
  view: ConnectionView;
  orgs: readonly OrgView[];
  checking: boolean;
  now: number;
  onCheck: () => void;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const def = connectionType(view.type);
  const service = serviceByUrl(view.fields.url?.value ?? "");
  const [removing, setRemoving] = useState(false);
  const remove = useConnectionCommand("connections.remove");
  const disconnect = useConnectCommand("connect.disconnect");
  const managed = isOauth(view);
  const busy = remove.isPending || disconnect.isPending;
  const failure = remove.error ?? disconnect.error;
  return (
    <Sheet
      title={view.name}
      subtitle={
        <span className="flex items-center gap-1.5">
          <WorkspaceTag org={view.org} orgs={orgs} className="text-xs" />
          <span aria-hidden="true">·</span>
          <span>{view.org === GLOBAL_CONNECTIONS ? "Every workspace" : def.label}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-sm text-fg-faint">
            {managed
              ? "Removing asks the service to end majhi's access."
              : "Removing deletes its secrets and files."}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRemoving(true)}
            aria-label={`Remove ${view.name}`}
          >
            Remove
          </Button>
        </div>
      }
    >
      <StatusBlock view={view} orgs={orgs} checking={checking} now={now} onCheck={onCheck} />
      {view.type === "chat" ? (
        <DetailSection title="Client chats" className="border-t border-line">
          {view.fields.service?.value === "slack" ? (
            <SlackChannels connection={view.id} orgs={orgs} />
          ) : (
            <ChatGroups connection={view.id} orgs={orgs} />
          )}
        </DetailSection>
      ) : (
        <>
          <UsageSection view={view} orgs={orgs} />
          <SharingSection view={view} orgs={orgs} />
          {service?.products !== undefined && (
            <ProductsSection key={`products-${view.id}`} view={view} products={service.products} />
          )}
          <AgentsSection view={view} orgs={orgs} />
          <DetailsSection key={`details-${view.id}`} view={view} />
          {!managed && (
            <ValuesSection key={`values-${view.id}`} view={view} title={`${def.label} settings`} />
          )}
          {view.type !== "host" && <AllowSection key={`allow-${view.id}`} view={view} />}
        </>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${view.name}?`}
          body={
            <>
              Its secrets and files are deleted.
              {view.org === GLOBAL_CONNECTIONS
                ? " Agents in every workspace lose access to this connection."
                : view.agents.length > 0 &&
                  ` ${view.agents.length === 1 ? "The agent that uses it loses it" : `The ${view.agents.length} agents that use it lose it`}.`}{" "}
              This cannot be undone.
            </>
          }
          confirmLabel="Remove"
          busy={busy}
          error={failure ? describeError(failure) : undefined}
          onCancel={() => setRemoving(false)}
          onConfirm={() => {
            const done = {
              onSuccess: () => {
                setRemoving(false);
                onRemoved();
              },
            };
            // A sign-in through Connect is ended at the service when it can; anything else is deleted here.
            if (managed) disconnect.mutate({ connection: view.id }, done);
            else remove.mutate({ id: view.id }, done);
          }}
        />
      )}
    </Sheet>
  );
}

/** The word for how long ago, with the time itself for a title. */
function Ago({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatAgo(iso, now)}
    </time>
  );
}

/**
 * The one status: a lamp and a word, why in one line, what was checked, and the fix with the one
 * action that does it. There is no second status anywhere else on the panel.
 */
function StatusBlock({
  view,
  orgs,
  checking,
  now,
  onCheck,
}: {
  view: ConnectionView;
  orgs: readonly OrgView[];
  checking: boolean;
  now: number;
  onCheck: () => void;
}) {
  const health = view.health;
  const status = rowStatus(view, checking, now);
  const fix = fixOf(health);
  const reasons = failureSentences(view);
  const re = useReconnect(view);
  const toast = useToast();
  const removeWebhook = useConfirmWebhook();
  const [other, setOther] = useState(false);
  const failed = health?.state === "failed" || health?.state === "needs-attention";
  return (
    <section aria-label="Status" className="flex min-w-0 flex-col gap-3 pb-5">
      <p className={cn("flex items-center gap-2 text-md font-semibold", LAMP_TEXT[status.lamp])}>
        <Lamp state={status.lamp} size={9} />
        {status.word}
      </p>
      {health?.state === "connected" && <Verified health={health} now={now} />}
      {failed && health !== undefined && (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-line-strong bg-sunken p-3">
          <p className="text-base font-medium text-fg">{reasons[0]}.</p>
          {reasons.length > 1 && (
            <p className="text-base text-fg-muted text-pretty">{reasons.slice(1).join(". ")}.</p>
          )}
          {health.state === "needs-attention" && (
            <p className="text-sm text-fg-faint">
              It last worked <Ago iso={health.lastVerifiedAt} now={now} />.
            </p>
          )}
          {health.status !== undefined && (
            <p className="font-mono text-xs text-fg-faint">The service answered {health.status}.</p>
          )}
        </div>
      )}
      {re.flow !== undefined ? (
        <ConnectFlowCard flow={re.flow} onRetry={re.reconnect} onDone={re.clear} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {failed && fix?.url !== undefined && (
            <Button size="sm" asChild>
              <a href={fix.url} target="_blank" rel="noreferrer noopener">
                <ExternalLink aria-hidden="true" />
                Open the page
              </a>
            </Button>
          )}
          {failed && health.reason === "webhook-set" && view.type === "chat" && (
            <Button
              variant="primary"
              disabled={removeWebhook.isPending}
              onClick={() =>
                removeWebhook.mutate(
                  { connection: view.id },
                  {
                    onSuccess: onCheck,
                    onError: (error) =>
                      toast("Could not remove the webhook", { detail: describeError(error), tone: "error" }),
                  },
                )
              }
            >
              {removeWebhook.isPending ? "Removing" : "Remove webhook"}
            </Button>
          )}
          {status.action === "reconnect" && re.canReconnect && (
            <Button variant="primary" disabled={re.pending} onClick={re.reconnect}>
              {re.pending ? "Opening" : "Reconnect"}
            </Button>
          )}
          {status.action === "reconnect" && !re.canReconnect && view.type === "git" && (
            <Button variant="primary" onClick={() => setOther((v) => !v)}>
              <Wrench aria-hidden="true" />
              Sign in again
            </Button>
          )}
          <Button variant={failed ? "secondary" : "primary"} disabled={checking} onClick={onCheck}>
            {checking ? "Checking" : "Check now"}
          </Button>
        </div>
      )}
      {re.error !== undefined && re.error !== null && (
        <p role="alert" className="text-base text-red text-pretty">
          {describeError(re.error)}
        </p>
      )}
      {failed && view.type === "git" && (other || status.action === "fix") && (
        <GitFix view={view} orgs={orgs} />
      )}
      {failed &&
        (view.type === "env" || view.type === "chat") &&
        view.fields.service?.value !== undefined && <TokenReplace view={view} />}
      {failed && view.type === "mcp" && view.fields.auth?.value !== "oauth" && (
        <p className="text-sm text-fg-faint text-pretty">
          Replace the token under MCP server settings below, then check again.
        </p>
      )}
    </section>
  );
}

/** What the passing check did, and who the service says it is. */
function Verified({
  health,
  now,
}: {
  health: Extract<ConnectionHealth, { state: "connected" }>;
  now: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-base text-fg-muted">
        Verified <Ago iso={health.verifiedAt} now={now} />
        {health.account !== undefined && (
          <>
            {" "}
            as <span className="font-mono text-fg">{health.account}</span>
          </>
        )}
        .
      </p>
      <ul aria-label="What was checked" className="flex flex-col gap-0.5">
        {health.checked.map((line) => (
          <li key={line} className="flex items-start gap-2 text-sm text-fg-muted">
            <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-green" />
            <span className="text-pretty">{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Signing a workspace in to its git host again: the host's own page, or a pasted token. */
function GitFix({ view, orgs }: { view: ConnectionView; orgs: readonly OrgView[] }) {
  const kind = (view.fields.provider?.value ?? "gitlab") as "github" | "gitlab" | "bitbucket";
  const host = view.fields.host?.value;
  // The Mac sign-in starts a real login on this computer, so it starts only when the owner asks.
  const [mode, setMode] = useState<"choose" | "mac" | "token">(
    host !== undefined || kind === "bitbucket" ? "token" : "choose",
  );
  const name = scopeName(view.org, orgs);
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={mode === "mac" ? "secondary" : "ghost"}
          onClick={() => setMode("mac")}
          disabled={host !== undefined || kind === "bitbucket"}
        >
          Sign in with {kind === "github" ? "gh" : "glab"}
        </Button>
        <Button size="sm" variant={mode === "token" ? "secondary" : "ghost"} onClick={() => setMode("token")}>
          Paste a token
        </Button>
      </div>
      {mode === "token" ? (
        <TokenForm
          org={view.org}
          git={{ kind, ...(host === undefined ? {} : { host }) }}
          onDone={() => undefined}
        />
      ) : mode === "choose" ? null : (
        <SignIn
          workspace={{ id: view.org, name }}
          kind={kind}
          names={new Map(orgs.map((o) => [o.id, o.name]))}
          onClose={() => undefined}
        />
      )}
    </div>
  );
}

/** A token service whose token stopped working: paste the new one. It is stored, then checked. */
function TokenReplace({ view }: { view: ConnectionView }) {
  const entry = serviceById(view.fields.service?.value ?? "");
  const method = entry?.token;
  const setSecret = useConnectionCommand("connections.setSecret");
  const test = useConnectionCommand("connections.test");
  const [token, setToken] = useState("");
  if (method === undefined) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim() === "") return;
    setSecret.mutate(
      { id: view.id, list: "vars", field: method.variable, value: token.trim() },
      {
        onSuccess: () => {
          setToken("");
          test.mutate({ id: view.id });
        },
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      className="flex min-w-0 flex-col gap-2 border-t border-line pt-3"
      aria-label="New token"
    >
      <Field
        label={`New ${entry?.name ?? "service"} token`}
        hint={`Make one at ${new URL(method.page.url).host}.`}
      >
        {(p) => (
          <Input
            {...p}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono"
            placeholder="Paste the token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        )}
      </Field>
      {(setSecret.error || test.error) && (
        <p role="alert" className="text-base text-red text-pretty">
          {describeError(setSecret.error ?? test.error)}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={token.trim() === "" || setSecret.isPending || test.isPending}
        >
          {setSecret.isPending || test.isPending ? "Checking" : "Save and check"}
        </Button>
        <Button size="sm" asChild>
          <a href={method.page.url} target="_blank" rel="noreferrer noopener">
            <ExternalLink aria-hidden="true" />
            {method.page.label}
          </a>
        </Button>
      </div>
    </form>
  );
}

/** What agents can do with it, in plain words, and which agents have it. */
function UsageSection({ view, orgs }: { view: ConnectionView; orgs: readonly OrgView[] }) {
  const re = useReconnect(view);
  const entry = serviceById(view.fields.service?.value ?? "") ?? serviceByUrl(view.fields.url?.value ?? "");
  const lines =
    re.mine !== undefined && re.mine.scopes.length > 0
      ? re.mine.scopes
      : entry === undefined
        ? []
        : scopesAt(entry, "readwrite").map((s) => ({ access: s.access, sentence: s.sentence }));
  const sign = re.mine;
  if (view.type === "host") return <HostUsage view={view} orgs={orgs} />;
  return (
    <DetailSection title="What agents can do" className="border-t border-line">
      <div className="flex min-w-0 flex-col gap-3">
        {lines.length > 0 ? (
          <ScopeList scopes={lines} />
        ) : (
          <p className="text-base text-fg-muted text-pretty">
            {(view.description !== "" ? view.description : connectionType(view.type).summary).replace(
              /\.$/,
              "",
            )}
            .
          </p>
        )}
        {view.toolGate !== undefined && <ToolGateList tools={view.toolGate} />}
        <p className="text-sm text-fg-faint text-pretty">
          Anything that changes something asks you first, unless the exact action is allowed below.
          {sign?.account !== undefined && (
            <>
              {" "}
              Signed in as <span className="font-mono text-fg-muted">{sign.account}</span>
              {sign.renews ? ", renewed by majhi" : ""}.
            </>
          )}
        </p>
      </div>
    </DetailSection>
  );
}

/** A service on this computer: what the workspace's agents reach, in plain words. Only the owner changes it. */
function HostUsage({ view, orgs }: { view: ConnectionView; orgs: readonly OrgView[] }) {
  const ports = hostPorts(view.fields.ports?.value);
  const workspace = orgs.find((o) => o.id === view.org)?.name ?? view.org;
  return (
    <DetailSection title="What agents can do" className="border-t border-line">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-base text-fg-muted text-pretty">
          Let {workspace}'s agents reach {view.name} on this computer: ports {ports.join(", ")}. Nothing else
          on this computer is reachable.
        </p>
        <p className="text-sm text-fg-faint text-pretty">
          Agents use the name{" "}
          <span className="font-mono text-fg-muted">
            {view.id}.host:{ports[0] ?? ""}
          </span>
          . Only you can add or change this. It is on only while the check passes.
        </p>
      </div>
    </DetailSection>
  );
}

/** Which workspaces share it. */
function SharingSection({ view, orgs }: { view: ConnectionView; orgs: readonly OrgView[] }) {
  const global = view.org === GLOBAL_CONNECTIONS;
  return (
    <DetailSection title="Shared with">
      <div className="flex min-w-0 flex-col gap-2">
        {global ? (
          <ul aria-label="Workspaces" className="flex flex-wrap gap-x-4 gap-y-1.5">
            {orgs.map((o) => (
              <li key={o.id}>
                <WorkspaceTag org={o.id} orgs={orgs} className="text-base text-fg-soft" />
              </li>
            ))}
          </ul>
        ) : (
          <WorkspaceTag org={view.org} orgs={orgs} className="text-base font-medium text-fg-soft" />
        )}
        <p className="text-sm text-fg-faint text-pretty">{scopeAudience(view.org, orgs)}</p>
      </div>
    </DetailSection>
  );
}

/** Which agents get it: every agent of its workspace and every root agent, each with a switch. */
function AgentsSection({ view, orgs }: { view: ConnectionView; orgs: readonly OrgView[] }) {
  const agents = useAgents();
  const update = useConnectionCommand("connections.update");
  const toast = useToast();
  const global = view.org === GLOBAL_CONNECTIONS;
  const candidates = (agents.data ?? []).flatMap((e) =>
    e.status === "ok" &&
    (global || e.agent.frontmatter.scope === view.org || e.agent.frontmatter.scope === "root")
      ? [e.agent.frontmatter]
      : [],
  );
  const root = candidates.filter((a) => a.scope === "root");
  const own = candidates.filter((a) => a.scope !== "root");
  const toggle = (agent: string, on: boolean) =>
    update.mutate(
      {
        id: view.id,
        agentsOff: on ? view.agentsOff.filter((a) => a !== agent) : [...view.agentsOff, agent],
      },
      {
        onError: (error) =>
          toast(`Could not change @${agent}`, { detail: describeError(error), tone: "error" }),
      },
    );
  const row = (a: (typeof candidates)[number]) => (
    <li key={a.id} className="flex min-w-0 items-center gap-3">
      <Switch
        label={`@${a.id}`}
        checked={!view.agentsOff.includes(a.id)}
        disabled={update.isPending}
        onChange={(on) => toggle(a.id, on)}
      />
      <span className="truncate text-sm text-fg-faint">
        {a.role}
        {global && a.scope !== "root" ? ` · ${scopeName(a.scope, orgs)}` : ""}
      </span>
    </li>
  );
  return (
    <DetailSection
      title="Agents"
      note={
        global
          ? "Every agent gets it, in every workspace. Switch one off to keep it from that agent."
          : `Every agent of ${scopeName(view.org, orgs)} gets it, and root agents in its tasks. Switch one off to keep it from that agent.`
      }
    >
      {agents.isError ? (
        <p role="alert" className="text-sm text-red">
          Could not load agents: {describeError(agents.error)}
        </p>
      ) : candidates.length === 0 && agents.data !== undefined ? (
        <p className="text-sm text-amber text-pretty">
          {scopeName(view.org, orgs)} has no agents yet, so nothing uses this connection.{" "}
          <PageLink page="agents" className="text-fg underline-offset-2 hover:underline">
            Add an agent
          </PageLink>
          .
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {own.length > 0 && (
            <ul aria-label="Workspace agents" className="flex flex-col gap-0.5">
              {own.map(row)}
            </ul>
          )}
          {root.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-fg-muted">Root agents</p>
              <ul aria-label="Root agents" className="flex flex-col gap-0.5">
                {root.map(row)}
              </ul>
            </div>
          )}
        </div>
      )}
    </DetailSection>
  );
}

/** The products of a service that has them. A change reaches sessions at their next turn. */
function ProductsSection({ view, products }: { view: ConnectionView; products: readonly ServiceProduct[] }) {
  const update = useConnectionCommand("connections.update");
  const saved = (view.fields.products?.value ?? "").split(/\s+/).filter((p) => p !== "");
  const [draft, setDraft] = useState<string[]>();
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const shown = draft ?? saved;
  return (
    <SaveSection
      title="Products"
      note="Each product is its own MCP server on the same sign-in."
      dirty={draft !== undefined && draft.join(" ") !== saved.join(" ")}
      state={state}
      onDiscard={() => {
        setDraft(undefined);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        if (draft === undefined) return;
        setState({ kind: "saving" });
        update.mutate(
          { id: view.id, fields: { products: draft.join(" ") } },
          {
            onSuccess: () => {
              setDraft(undefined);
              setState({ kind: "saved" });
            },
            onError: (e) => setState(errorState(e)),
          },
        );
      }}
    >
      <ProductPicker
        compact
        products={products}
        value={shown}
        onChange={(next) => {
          setDraft(next);
          setState({ kind: "idle" });
        }}
      />
    </SaveSection>
  );
}

function errorState(error: unknown): SaveState {
  return { kind: "error", message: describeError(error), details: errorDetails(error) };
}

/** Name and description: what agents see of the connection. */
function DetailsSection({ view }: { view: ConnectionView }) {
  const update = useConnectionCommand("connections.update");
  const [name, setName] = useState(view.name);
  const [description, setDescription] = useState(view.description);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const dirty = name.trim() !== view.name || description.trim() !== view.description;
  return (
    <SaveSection
      title="Details"
      note="Agents see the name and description, never a value."
      dirty={dirty}
      state={state}
      onDiscard={() => {
        setName(view.name);
        setDescription(view.description);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        setState({ kind: "saving" });
        update.mutate(
          { id: view.id, name: name.trim(), description: description.trim() },
          { onSuccess: () => setState({ kind: "saved" }), onError: (e) => setState(errorState(e)) },
        );
      }}
    >
      <div className="grid gap-3">
        <Field label="Name">
          {(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field
          label="Description"
          hint="What it reaches and how to use it, like which namespaces matter. Never a secret."
        >
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              maxLength={2000}
              className="font-sans"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
      </div>
    </SaveSection>
  );
}

function plain(draft: ConnectionDraft): string {
  const lists = Object.entries(draft.lists).map(([key, entries]) => [
    key,
    entries.map((e) => [e.name.trim(), e.kind, e.kind === "text" ? e.value.trim() : ""]),
  ]);
  return JSON.stringify([draft.fields, lists]);
}

/** The type's fields and lists. Text saves with the section; secrets and files save on their own. */
function ValuesSection({ view, title }: { view: ConnectionView; title: string }) {
  const update = useConnectionCommand("connections.update");
  const saved = draftOf(view);
  const [draft, setDraft] = useState<ConnectionDraft | undefined>();
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const shown = draft ?? saved;
  const dirty = draft !== undefined && plain(draft) !== plain(saved);
  return (
    <SaveSection
      title={title}
      note="Secrets are never shown again once set."
      dirty={dirty}
      state={state}
      onDiscard={() => {
        setDraft(undefined);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        if (draft === undefined) return;
        setState({ kind: "saving" });
        update.mutate(updateInput(view, draft), {
          onSuccess: () => {
            setDraft(undefined);
            setState({ kind: "saved" });
          },
          onError: (e) => setState(errorState(e)),
        });
      }}
    >
      <ConnectionFields
        type={view.type}
        draft={shown}
        view={view}
        onChange={(next) => {
          setDraft(next);
          setState({ kind: "idle" });
        }}
      />
    </SaveSection>
  );
}

/** The exact writes agents may run without asking. Empty: every write asks the owner. */
function AllowSection({ view }: { view: ConnectionView }) {
  const allow = useConnectionCommand("connections.allow");
  const saved = view.allow.join("\n");
  const [text, setText] = useState(saved);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return (
    <SaveSection
      title="Allowed without asking"
      note="Every other write asks you first."
      dirty={lines.join("\n") !== saved}
      state={state}
      onDiscard={() => {
        setText(saved);
        setState({ kind: "idle" });
      }}
      onSave={() => {
        setState({ kind: "saving" });
        allow.mutate(
          { id: view.id, allow: lines },
          { onSuccess: () => setState({ kind: "saved" }), onError: (e) => setState(errorState(e)) },
        );
      }}
    >
      <Field
        label="Actions, one per line"
        hint="Exact actions, like kubectl rollout restart deployment/api. Reads never ask."
      >
        {(p) => (
          <Textarea
            {...p}
            rows={Math.max(2, Math.min(8, lines.length + 1))}
            value={text}
            placeholder="kubectl rollout restart deployment/api"
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
    </SaveSection>
  );
}
