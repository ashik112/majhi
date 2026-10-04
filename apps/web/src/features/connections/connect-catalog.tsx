import type { ConnectAccess, ConnectStatus, OrgView, ServiceEntry } from "@majhi/shared";
import { type ConnectionType, GLOBAL_CONNECTIONS, PRIVATE, scopesAt } from "@majhi/shared";
import { ArrowLeft, ChevronRight, Globe, KeyRound, Network, Plug, Search, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAppStatus, useConnectCatalog, useConnectCommand, useConnectStatus } from "@/lib/connect-queries";
import { describeError } from "@/lib/errors";
import { AppSetupSheet } from "./app-setup-sheet";
import { ConnectFlowCard, ScopeList } from "./connect-flow";
import { ScopePicker } from "./scope-picker";
import { ServiceLogo } from "./service-logo";

/** Matches the name and the one-line summary, ignoring case. */
export function matchesService(service: Pick<ServiceEntry, "name" | "summary">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || `${service.name} ${service.summary}`.toLowerCase().includes(q);
}

const hasSend = (s: ServiceEntry) => s.scopes.some((x) => x.level === "send");
const hasWrite = (s: ServiceEntry) => s.scopes.some((x) => x.access === "write");

/**
 * Choose a destination and service, then reuse the provider's sign-in or guided app setup.
 */
export function ConnectCatalog({
  orgs,
  defaultOrg,
  onOpen,
  onCustom,
  onBusyChange,
}: {
  orgs: readonly OrgView[];
  defaultOrg: string | undefined;
  onOpen: (connection: string) => void;
  onCustom: (org: string, type: ConnectionType) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const catalog = useConnectCatalog();
  const status = useConnectStatus();
  const start = useConnectCommand("connect.start");
  const [org, setOrg] = useState(defaultOrg ?? PRIVATE);
  const apps = useAppStatus(org);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ServiceEntry>();
  const [access, setAccess] = useState<ConnectAccess>("read");
  const [flow, setFlow] = useState<string>();
  const [sheet, setSheet] = useState(false);
  const busy = flow !== undefined || start.isPending;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const services = useMemo(
    () =>
      (catalog.data?.services ?? [])
        .filter(
          (s) =>
            matchesService(s, query) &&
            (category === "all" || categoryOf(s.id) === category) &&
            (!s.id.startsWith("digitalocean-") || query.trim() !== ""),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [catalog.data, query, category],
  );
  const tools = services.filter((s) => s.kind === "cli-login");
  const others = services.filter((s) => s.kind !== "cli-login");
  const connected = (service: ServiceEntry): ConnectStatus | undefined =>
    (status.data ?? []).find((s) => s.org === org && s.service === service.id);
  const pickedConnection = picked ? connected(picked) : undefined;
  /** True when the service needs the owner's own app and the workspace has none yet. */
  const needsApp = (service: ServiceEntry): boolean => {
    if (service.app === undefined) return false;
    const app = (apps.data ?? []).find((a) => a.app === service.app);
    return app?.saved !== true && app?.builtIn !== true;
  };

  const begin = (service: ServiceEntry) =>
    start.mutate({ org, service: service.id, access }, { onSuccess: (view) => setFlow(view.flow) });
  const pick = (service: ServiceEntry) => {
    setPicked(service);
    setAccess("read");
    setSheet(false);
    start.reset();
  };

  const tile = (service: ServiceEntry) => {
    const have = connected(service);
    const shared =
      org !== GLOBAL_CONNECTIONS &&
      (status.data ?? []).some(
        (s) => s.org === GLOBAL_CONNECTIONS && s.service === service.id && s.state === "connected",
      );
    const method =
      service.kind === "api-key"
        ? "Access token"
        : service.kind === "cli-login"
          ? "Tool sign-in"
          : "Browser sign-in";
    return (
      <li key={service.id}>
        <button
          type="button"
          disabled={!service.ready || start.isPending || status.isPending || status.isError}
          onClick={() => (have && service.id !== "digitalocean" ? onOpen(have.connection) : pick(service))}
          className="group flex h-full w-full cursor-pointer flex-col gap-3 rounded-xl border border-line-strong bg-card p-4 text-left transition-colors duration-150 hover:border-line-hover hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex min-w-0 items-center gap-3">
            <ServiceLogo service={service.id} />
            <span className="min-w-0 text-base font-semibold text-fg">{service.name}</span>
            <ChevronRight
              aria-hidden="true"
              className="ml-auto size-4 shrink-0 text-fg-faint group-hover:text-fg"
            />
          </span>
          <span className="text-sm text-fg-muted">
            {service.id === "digitalocean"
              ? "Droplets, Kubernetes, databases, apps and more"
              : service.summary}
          </span>
          <span className="mt-auto flex flex-wrap items-center justify-between gap-2 text-xs text-fg-faint">
            <span>
              {!service.ready
                ? "Coming soon"
                : service.app && needsApp(service) && service.kind !== "api-key"
                  ? "App setup required"
                  : method}
            </span>
            {have ? (
              <Badge tone={have.state === "connected" ? "green" : "amber"}>
                {have.state === "connected" ? "Connected" : "Reconnect"}
              </Badge>
            ) : shared ? (
              <Badge>Available globally</Badge>
            ) : service.ready ? (
              <span className="text-sm text-fg-soft">Connect</span>
            ) : null}
          </span>
        </button>
      </li>
    );
  };
  const group = (label: string, list: readonly ServiceEntry[]) =>
    list.length === 0 ? null : (
      <section aria-label={label} className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-fg-soft">{label}</h3>
        <ul
          aria-label={label}
          className="grid gap-3 @[480px]:grid-cols-2 @[820px]:grid-cols-3 @[1120px]:grid-cols-4"
        >
          {list.map(tile)}
        </ul>
      </section>
    );

  const accessChoices = (s: ServiceEntry) => [
    { value: "read" as const, label: "Read only" },
    { value: "readwrite" as const, label: "Read and write" },
    ...(hasSend(s) ? [{ value: "send" as const, label: "Read, write and send" }] : []),
  ];

  return (
    <DetailPane
      label="Connect a service"
      head={
        <ScopePicker
          orgs={orgs}
          value={org}
          disabled={flow !== undefined || start.isPending}
          onChange={(next) => {
            setOrg(next);
            setPicked(undefined);
            setSheet(false);
            start.reset();
          }}
        />
      }
    >
      {catalog.isError ? (
        <p role="alert" className="pt-5 text-base text-red">
          Could not load the services: {describeError(catalog.error)}
        </p>
      ) : picked !== undefined ? (
        <div className="flex flex-col gap-4 pt-4">
          {flow === undefined && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setPicked(undefined)}>
              <ArrowLeft aria-hidden="true" />
              All services
            </Button>
          )}
          <div className="flex items-center gap-3">
            <ServiceLogo service={picked.id} className="size-12" />
            <div>
              <h3 className="text-md font-semibold">Connect {picked.name}</h3>
              <p className="text-sm text-fg-muted">{picked.summary}</p>
            </div>
          </div>
          {picked.id.startsWith("digitalocean") && flow === undefined && (
            <Field label="DigitalOcean service">
              {(props) => (
                <Select
                  {...props}
                  aria-label="DigitalOcean service"
                  className="max-w-[380px]"
                  value={picked.id}
                  onChange={(e) => {
                    const next = catalog.data?.services.find((s) => s.id === e.target.value);
                    if (next) pick(next);
                  }}
                >
                  {(catalog.data?.services ?? [])
                    .filter((s) => s.id.startsWith("digitalocean"))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id === "digitalocean" ? "Droplets" : s.name.replace("DigitalOcean ", "")}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
          {flow !== undefined ? (
            <ConnectFlowCard
              flow={flow}
              onRetry={() => {
                setFlow(undefined);
                begin(picked);
              }}
              onDone={(connection) => {
                setFlow(undefined);
                if (connection !== undefined) onOpen(connection);
                else setPicked(undefined);
              }}
            />
          ) : pickedConnection ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-base text-fg-muted">This service already has a connection for this scope.</p>
              <Button variant="primary" onClick={() => onOpen(pickedConnection.connection)}>
                Open connection
              </Button>
            </div>
          ) : picked.app !== undefined && (sheet || picked.kind === "api-key" || needsApp(picked)) ? (
            <AppSetupSheet
              org={org}
              app={picked.app}
              access={access}
              serviceName={picked.name}
              key={`${org}-${picked.app}`}
              onDone={(saved, connection) => {
                setSheet(false);
                if (saved && connection !== undefined) onOpen(connection);
                else if (saved && picked.kind === "api-key") setPicked(undefined);
                if (!saved && needsApp(picked)) setPicked(undefined);
              }}
            />
          ) : (
            <div className="flex max-w-[620px] flex-col gap-4">
              <p className="text-base text-fg-muted text-pretty">
                {picked.kind === "cli-login"
                  ? `Sign in through ${picked.name}'s own login. majhi keeps this sign-in separate from other connections.`
                  : picked.kind === "device"
                    ? `Continue to ${picked.name} and enter the code majhi shows you.`
                    : `Continue to ${picked.name} to sign in and approve access. You'll return here when it's connected.`}
              </p>

              {picked.kind === "cli-login" && catalog.data?.helper === false && (
                <p role="alert" className="text-base text-amber text-pretty">
                  majhi's helper is not running, so the tool cannot sign in now. Start the helper first.
                </p>
              )}
              {hasSend(picked) ? (
                <ChoiceGroup
                  label="What agents may do"
                  value={access}
                  choices={accessChoices(picked)}
                  onChange={setAccess}
                />
              ) : picked.kind !== "cli-login" && hasWrite(picked) ? (
                <Switch
                  label="Also let agents change things"
                  checked={access !== "read"}
                  onChange={(on) => setAccess(on ? "readwrite" : "read")}
                  title="Writes still ask you first unless the workspace allows that exact action"
                />
              ) : null}
              <ScopeList
                scopes={scopesAt(picked, access).map((s) => ({ access: s.access, sentence: s.sentence }))}
              />
              {picked.scopes.some((s) => s.oauth === undefined) && picked.kind !== "cli-login" && (
                <p className="text-sm text-fg-faint text-pretty">
                  {picked.name} decides what its page offers. majhi shows what it granted.
                </p>
              )}
              {picked.note && <p className="text-sm text-amber text-pretty">{picked.note}</p>}
              {start.error && (
                <p role="alert" className="text-base text-red text-pretty">
                  {describeError(start.error)}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  disabled={
                    start.isPending ||
                    org === "" ||
                    (picked.kind === "cli-login" && catalog.data?.helper === false)
                  }
                  onClick={() => begin(picked)}
                >
                  {start.isPending
                    ? "Opening"
                    : picked.kind === "cli-login"
                      ? `Sign in with ${picked.name}`
                      : `Connect ${picked.name}`}
                </Button>
                {picked.app !== undefined && (
                  <Button variant="ghost" onClick={() => setSheet(true)}>
                    App setup
                  </Button>
                )}
                <a
                  href={picked.docs}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm text-fg-faint underline-offset-2 hover:text-fg hover:underline"
                >
                  {picked.name} docs
                </a>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6 pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <h2 className="text-md font-semibold">Choose a service</h2>
              <p className="mt-1 text-sm text-fg-muted">
                Sign in to a service, or use custom setup for your own server.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="relative min-w-[200px] flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-2.5 left-3 size-3.5 text-fg-faint"
              />
              <Input
                type="search"
                aria-label="Search services"
                className="pl-9"
                placeholder="Search services, e.g. DigitalOcean, Gmail, Slack"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select
              aria-label="Service category"
              className="w-[200px]"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="all">All services</option>
              <option value="work">Work & communication</option>
              <option value="cloud">Cloud & hosting</option>
              <option value="monitoring">Monitoring</option>
              <option value="payments">Payments</option>
              <option value="social">Social</option>
            </Select>
          </div>
          {status.isError && (
            <p role="alert" className="text-sm text-red">
              Could not check existing connections.{" "}
              <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>
                Retry
              </Button>
            </p>
          )}
          {catalog.isPending ? (
            <div aria-busy="true" className="grid grid-cols-2 gap-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-36 rounded-xl" />
              ))}
            </div>
          ) : services.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-base text-fg">No services match {query ? `"${query}"` : "this category"}.</p>
              <p className="text-sm text-fg-muted">
                Use custom setup below to connect an MCP server, API or host.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <>
              {group("Services", others)}
              {group("Cloud tools", tools)}
            </>
          )}
          <section aria-label="Custom setup" className="flex flex-col gap-3 border-t border-line pt-5">
            <div>
              <h3 className="text-base font-semibold">Custom setup</h3>
              <p className="mt-1 text-sm text-fg-muted">
                Connect a service that is not listed above, or your own infrastructure.
              </p>
            </div>
            <div className="grid gap-1 @[620px]:grid-cols-2">
              {CUSTOM.map(({ type, label, hint, icon: Icon }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => onCustom(org, type)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Icon aria-hidden="true" className="size-5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-medium">{label}</span>
                    <span className="block text-sm text-fg-muted">{hint}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 text-fg-faint" />
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </DetailPane>
  );
}

const CUSTOM = [
  { type: "mcp" as const, label: "MCP server", hint: "Connect by URL or local command", icon: Plug },
  {
    type: "env" as const,
    label: "API keys & credentials",
    hint: "Use any service with an API key",
    icon: KeyRound,
  },
  { type: "ssh" as const, label: "SSH host", hint: "Reach a server through SSH", icon: Server },
  { type: "kubectl" as const, label: "Kubernetes cluster", hint: "Upload a kubeconfig", icon: Network },
  { type: "mail" as const, label: "Mail server", hint: "IMAP and SMTP credentials", icon: Plug },
  { type: "browser" as const, label: "Browser", hint: "An isolated browser for your agents", icon: Globe },
] satisfies readonly { type: ConnectionType; label: string; hint: string; icon: typeof Plug }[];

function categoryOf(id: string): string {
  if (
    id.startsWith("digitalocean") ||
    ["vercel", "vercel-cli", "cloudflare-observability", "wrangler", "aws", "gcloud"].includes(id)
  )
    return "cloud";
  if (["sentry", "sentry-cli", "posthog", "grafana", "datadog", "betterstack"].includes(id))
    return "monitoring";
  if (id.startsWith("stripe")) return "payments";
  if (["x", "linkedin"].includes(id)) return "social";
  return "work";
}
