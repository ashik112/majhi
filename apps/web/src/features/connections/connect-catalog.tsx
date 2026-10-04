import type { ConnectAccess, ConnectStatus, OrgView, ServiceEntry } from "@majhi/shared";
import { scopesAt } from "@majhi/shared";
import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane } from "@/components/ui/list-detail";
import { SectionLabel } from "@/components/ui/section-label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { useAppStatus, useConnectCatalog, useConnectCommand, useConnectStatus } from "@/lib/connect-queries";
import { describeError } from "@/lib/errors";
import { AppSetupSheet } from "./app-setup-sheet";
import { ConnectFlowCard, ScopeList } from "./connect-flow";

/** Matches the name and the one-line summary, ignoring case. */
export function matchesService(service: Pick<ServiceEntry, "name" | "summary">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || `${service.name} ${service.summary}`.toLowerCase().includes(q);
}

const hasSend = (s: ServiceEntry) => s.scopes.some((x) => x.level === "send");
const hasWrite = (s: ServiceEntry) => s.scopes.some((x) => x.access === "write");

/**
 * The services majhi connects, for one workspace. Pick one, read what it can do, connect in the
 * browser, and see who signed in. A service that needs the owner's own app opens its guided setup
 * first. A service already connected in the workspace opens its connection instead. Command-line
 * tools are their own group: majhi runs the tool's own login in a folder of this workspace.
 */
export function ConnectCatalog({
  orgs,
  defaultOrg,
  onOpen,
  onClose,
}: {
  orgs: readonly OrgView[];
  defaultOrg: string | undefined;
  onOpen: (connection: string) => void;
  onClose: () => void;
}) {
  const catalog = useConnectCatalog();
  const status = useConnectStatus();
  const start = useConnectCommand("connect.start");
  const [org, setOrg] = useState(defaultOrg ?? orgs[0]?.id ?? "");
  const apps = useAppStatus(org);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ServiceEntry>();
  const [access, setAccess] = useState<ConnectAccess>("read");
  const [flow, setFlow] = useState<string>();
  const [sheet, setSheet] = useState(false);

  const services = useMemo(
    () => (catalog.data?.services ?? []).filter((s) => matchesService(s, query)),
    [catalog.data, query],
  );
  const tools = services.filter((s) => s.kind === "cli-login");
  const others = services.filter((s) => s.kind !== "cli-login");
  const connected = (service: ServiceEntry): ConnectStatus | undefined =>
    (status.data ?? []).find((s) => s.org === org && s.service === service.id);
  const orgName = orgs.find((o) => o.id === org)?.name ?? org;
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

  const tile = (s: ServiceEntry) => {
    const have = connected(s);
    return (
      <li key={s.id}>
        <button
          type="button"
          disabled={!s.ready}
          onClick={() => (have !== undefined ? onOpen(have.connection) : pick(s))}
          className={cn(
            "flex h-full w-full min-w-0 flex-col gap-1 rounded-lg border border-line bg-raised p-3 text-left",
            "hover:border-line-hover focus-visible:outline-2 focus-visible:outline-accent",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-base font-medium text-fg">{s.name}</span>
            {have !== undefined ? (
              <Badge tone={have.state === "connected" ? "green" : "amber"} className="ml-auto">
                {have.state === "connected" ? "Connected" : "Needs you"}
              </Badge>
            ) : !s.ready ? (
              <Badge className="ml-auto">Coming next</Badge>
            ) : needsApp(s) ? (
              <Badge tone="amber" className="ml-auto">
                Set up the app first
              </Badge>
            ) : null}
          </span>
          <span className="text-sm text-fg-muted text-pretty">{s.summary}</span>
          {have?.account && <span className="min-w-0 truncate text-xs text-fg-faint">{have.account}</span>}
        </button>
      </li>
    );
  };

  const group = (label: string, list: readonly ServiceEntry[]) =>
    list.length === 0 ? null : (
      <section aria-label={label} className="flex flex-col gap-2">
        <SectionLabel>{label}</SectionLabel>
        <ul aria-label={label} className="grid gap-2 @[440px]:grid-cols-2 @[900px]:grid-cols-3">
          {list.map(tile)}
        </ul>
      </section>
    );

  const accessChoices = (s: ServiceEntry) => [
    { value: "read" as const, label: "Read only" },
    { value: "readwrite" as const, label: "Read and write drafts" },
    ...(hasSend(s) ? [{ value: "send" as const, label: "Read, write and send" }] : []),
  ];

  return (
    <DetailPane
      label="Connect a service"
      head={
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 className="text-md leading-6 font-semibold">Connect a service</h2>
          <p className="min-w-0 text-sm text-fg-muted">Once per workspace. Nothing else to set up by hand.</p>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="flex items-center gap-2 text-sm text-fg-faint">
              Workspace
              <Select
                aria-label="Workspace"
                className="w-[180px]"
                value={org}
                disabled={flow !== undefined}
                onChange={(e) => setOrg(e.target.value)}
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </span>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
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
          <h3 className="text-md font-semibold">
            {picked.name} <span className="font-normal text-fg-muted">for {orgName}</span>
          </h3>
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
          ) : picked.app !== undefined && (sheet || picked.kind === "api-key" || needsApp(picked)) ? (
            <AppSetupSheet
              org={org}
              app={picked.app}
              access={access}
              serviceName={picked.name}
              onDone={(saved) => {
                setSheet(false);
                if (saved && picked.kind === "api-key") setPicked(undefined);
                if (!saved && needsApp(picked)) setPicked(undefined);
              }}
            />
          ) : (
            <div className="flex max-w-[620px] flex-col gap-4">
              <p className="text-base text-fg-muted text-pretty">
                {picked.kind === "cli-login"
                  ? `majhi runs ${picked.name}'s own sign-in on this computer, in a folder of ${orgName}. Only runs of ${orgName} see it. Another workspace can sign in as a different account.`
                  : picked.kind === "device"
                    ? `majhi shows a code and opens ${picked.name}. Type the code there. Agents of ${orgName} can then use ${picked.name}. Other workspaces never get this sign-in.`
                    : `majhi opens ${picked.name}'s own sign-in page in your browser. Agents of ${orgName} can then use ${picked.name}. Other workspaces never get this sign-in.`}
              </p>
              {picked.packs.length > 0 && (
                <p className="text-sm text-fg-faint">For {picked.packs.join(", ")}.</p>
              )}
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
        <div className="flex flex-col gap-5 pt-4">
          <Field label="Search services">
            {(props) => (
              <div className="relative max-w-[360px]">
                <Search aria-hidden="true" className="absolute top-2.5 left-2.5 size-3.5 text-fg-faint" />
                <Input
                  {...props}
                  type="search"
                  autoFocus
                  className="pl-8"
                  placeholder="Linear, Gmail, wrangler"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
          </Field>
          {catalog.isPending ? (
            <p className="text-base text-fg-muted">Loading</p>
          ) : services.length === 0 ? (
            <p className="text-base text-fg-muted">No service matches "{query}".</p>
          ) : (
            <>
              {group("Services", others)}
              {group("Command-line tools", tools)}
            </>
          )}
        </div>
      )}
    </DetailPane>
  );
}
