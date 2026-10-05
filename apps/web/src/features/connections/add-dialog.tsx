import { type OrgView, PRIVATE, type ServiceEntry } from "@majhi/shared";
import { ArrowLeft, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { useConnectCatalog } from "@/lib/connect-queries";
import { useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { AppBackedBody, TokenAppBody } from "./add-app";
import { CustomBody, GitHostBody, McpUrlBody, OneClickBody } from "./add-bodies";
import { type AddCard, addCards, GROUPS, groupOfEntry, type MethodGroup, matchesCard } from "./catalog";
import { ScopePicker } from "./scope-picker";
import { ServiceLogo, serviceOf } from "./service-logo";
import { TokenForm } from "./token-form";

/**
 * Add a connection: search every supported service, grouped by how it connects, with the method and
 * how long it takes. Picking one opens its setup right here. The workspace it goes to stays on top.
 */
export function AddDialog({
  orgs,
  defaultOrg,
  onClose,
  onOpen,
}: {
  orgs: readonly OrgView[];
  defaultOrg: string | undefined;
  onClose: () => void;
  /** A connection was made: open it. */
  onOpen: (connection: string) => void;
}) {
  const catalog = useConnectCatalog();
  const connections = useConnections();
  const [org, setOrg] = useState(defaultOrg ?? PRIVATE);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<AddCard>();
  const [busy, setBusy] = useState(false);
  const cards = useMemo(() => addCards(catalog.data?.services ?? []), [catalog.data]);
  const shown = cards.filter((c) => matchesCard(c, query));

  /** Connections of this workspace (and Global) that belong to a card. */
  const heldBy = (card: AddCard) => {
    const ids = new Set([...card.services, ...card.others].map((s) => s.id));
    return (connections.data ?? []).filter((c) => {
      const id = serviceOf(c);
      return id !== undefined && ids.has(id) && (c.org === org || c.org === "global");
    });
  };

  const done = (connection?: string) => {
    if (connection !== undefined) onOpen(connection);
    else onClose();
  };

  return (
    <Modal
      label="Add a connection"
      onClose={busy ? () => undefined : onClose}
      className="flex h-[min(780px,calc(100dvh-32px))] w-[min(940px,calc(100vw-32px))] flex-col open:flex"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line-strong px-5 py-3">
        {picked !== undefined && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to all services"
            disabled={busy}
            onClick={() => setPicked(undefined)}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold">
          {picked === undefined ? "Add a connection" : picked.name}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close" disabled={busy} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="shrink-0 border-b border-line px-5 py-3">
        <ScopePicker orgs={orgs} value={org} onChange={setOrg} disabled={busy} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4 pb-6 scroll-fade">
        {picked === undefined ? (
          <div className="flex flex-col gap-6">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-2.5 left-3 size-3.5 text-fg-faint"
              />
              <Input
                type="search"
                aria-label="Search services"
                className="pl-9"
                placeholder="Search every service: GitHub, Bitbucket, Gmail, Linear, Slack, an MCP server"
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {catalog.isError ? (
              <p role="alert" className="text-base text-red">
                Could not load the services: {describeError(catalog.error)}
              </p>
            ) : catalog.isPending ? (
              <div aria-busy="true" className="grid grid-cols-2 gap-3">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : shown.length === 0 ? (
              <p className="text-base text-fg-muted">
                No service matches "{query}". Add it as an MCP server by address, or as your own key.
              </p>
            ) : (
              GROUPS.map((g) => (
                <Group
                  key={g.id}
                  id={g.id}
                  title={g.title}
                  blurb={g.blurb}
                  cards={shown.filter((c) => c.group === g.id)}
                  held={heldBy}
                  onPick={setPicked}
                />
              ))
            )}
          </div>
        ) : (
          <Setup
            card={picked}
            org={org}
            orgs={orgs}
            onDone={done}
            onBusy={setBusy}
            onBack={() => setPicked(undefined)}
          />
        )}
      </div>
    </Modal>
  );
}

function Group({
  id,
  title,
  blurb,
  cards,
  held,
  onPick,
}: {
  id: MethodGroup;
  title: string;
  blurb: string;
  cards: readonly AddCard[];
  held: (card: AddCard) => { health?: { state: string } | undefined }[];
  onPick: (card: AddCard) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-3">
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        <span className="font-mono text-xs text-fg-faint tabular-nums">{cards.length}</span>
        <p className="min-w-0 truncate text-sm text-fg-faint">{blurb}</p>
      </div>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {cards.map((card) => {
          const have = held(card);
          const stale = have.some((c) => c.health?.state !== "connected");
          return (
            <li key={`${id}-${card.id}`}>
              <button
                type="button"
                onClick={() => onPick(card)}
                className="group flex h-full w-full cursor-pointer items-start gap-3 rounded-xl border border-line-strong bg-card p-3 text-left transition-colors duration-150 hover:border-line-hover hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <ServiceLogo
                  service={card.logo}
                  type={
                    card.special !== undefined && typeof card.special === "object"
                      ? card.special.type
                      : undefined
                  }
                  className="size-9"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-base font-semibold text-fg">{card.name}</span>
                    {have.length > 0 && (
                      <Badge tone={stale ? "amber" : "green"}>
                        {stale
                          ? "Needs a look"
                          : have.length === 1
                            ? "Connected"
                            : `${have.length} connected`}
                      </Badge>
                    )}
                  </span>
                  <span className="truncate text-sm text-fg-muted">{card.summary}</span>
                  <span className="truncate text-xs text-fg-faint">
                    {card.time}
                    {card.others.length > 0 &&
                      ` · ${card.others.length} other way${card.others.length === 1 ? "" : "s"}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The setup of one card: its best way first, the others under "Other ways". */
function Setup({
  card,
  org,
  orgs,
  onDone,
  onBusy,
  onBack,
}: {
  card: AddCard;
  org: string;
  orgs: readonly OrgView[];
  onDone: (connection?: string) => void;
  onBusy: (busy: boolean) => void;
  onBack: () => void;
}) {
  void onBusy;
  const methods = [...card.services.slice(0, 1), ...card.others];
  const [chosen, setChosen] = useState(methods[0]?.id);
  const entry: ServiceEntry | undefined = methods.find((m) => m.id === chosen) ?? methods[0];
  const special = card.special;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <ServiceLogo
          service={card.logo}
          type={special !== undefined && typeof special === "object" ? special.type : undefined}
          className="size-12"
        />
        <div className="min-w-0">
          <p className="text-base text-fg-muted text-pretty">{card.summary}</p>
          <p className="text-sm text-fg-faint">
            {GROUPS.find((g) => g.id === (entry === undefined ? card.group : groupOfEntry(entry)))?.title} ·{" "}
            {card.time}
          </p>
        </div>
      </div>
      {methods.length > 1 && (
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
          <legend className="sr-only">Other ways</legend>
          {methods.map((m, i) => (
            <Button
              key={m.id}
              size="sm"
              variant={m.id === entry?.id ? "secondary" : "ghost"}
              className={cn(m.id === entry?.id && "text-fg")}
              onClick={() => setChosen(m.id)}
            >
              {i === 0 ? "Best way" : m.name}
            </Button>
          ))}
          <span className="text-sm text-fg-faint">
            {entry === undefined
              ? ""
              : groupOfEntry(entry) === "one-click"
                ? "One click"
                : groupOfEntry(entry) === "on-this-mac"
                  ? "On this Mac"
                  : groupOfEntry(entry) === "token"
                    ? "Token"
                    : "Your own app"}
          </span>
        </fieldset>
      )}
      {special === "mcp-url" ? (
        <McpUrlBody org={org} onDone={onDone} />
      ) : special !== undefined ? (
        <CustomBody org={org} orgs={orgs} type={special.type} onDone={onDone} onBack={onBack} />
      ) : card.id === "google" ? (
        <AppBackedBody org={org} entries={card.services} app="google" onDone={onDone} />
      ) : entry === undefined ? null : entry.kind === "git-host" ? (
        <GitHostBody org={org} orgs={orgs} entry={entry} onDone={onDone} />
      ) : entry.kind === "token" ? (
        <TokenForm org={org} service={entry} onDone={onDone} />
      ) : entry.kind === "api-key" ? (
        <TokenAppBody org={org} entry={entry} onDone={onDone} />
      ) : entry.kind === "oauth-loopback" || entry.kind === "device" ? (
        <AppBackedBody org={org} entries={[entry]} app={entry.app ?? entry.id} onDone={onDone} />
      ) : (
        <OneClickBody key={entry.id} org={org} entry={entry} onDone={onDone} />
      )}
    </div>
  );
}
