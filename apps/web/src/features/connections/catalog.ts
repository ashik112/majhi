import type { ConnectionType, ConnectionView, ServiceEntry } from "@majhi/shared";
import { serviceById } from "@majhi/shared";

/**
 * How a service connects, the one thing the Connections page and its Add dialog group by. The
 * owner picks a service, majhi shows the cheapest method that works, and the others sit behind
 * "Other ways".
 */
export type MethodGroup = "one-click" | "on-this-mac" | "token" | "own-app" | "own";

export const GROUPS: readonly { id: MethodGroup; title: string; blurb: string }[] = [
  {
    id: "one-click",
    title: "Sign in with one click",
    blurb: "The service's own page signs majhi in. Nothing to copy.",
  },
  {
    id: "on-this-mac",
    title: "Sign in on this Mac",
    blurb: "A command-line sign-in through majhi's helper. The login stays in this workspace's folder.",
  },
  {
    id: "token",
    title: "Paste a token",
    blurb: "majhi opens the exact token page. You paste it once and it is checked on the spot.",
  },
  {
    id: "own-app",
    title: "Needs your own app",
    blurb: "The service gives majhi no sign-in of its own, so you make one app. majhi guides each step.",
  },
  {
    id: "own",
    title: "Your own servers and keys",
    blurb: "Hosts, clusters, mailboxes and keys that are not a listed service.",
  },
];

export const TIME: Record<MethodGroup, string> = {
  "one-click": "About 30 seconds",
  "on-this-mac": "About a minute",
  token: "About 2 minutes",
  "own-app": "About 10 minutes",
  own: "About 2 minutes",
};

/** The word for a group in a row's tooltip and the dialog. */
export const METHOD_WORD: Record<MethodGroup, string> = {
  "one-click": "One click",
  "on-this-mac": "On this Mac",
  token: "Token",
  "own-app": "Your own app",
  own: "Custom",
};

/** The group of one catalog entry. */
export function groupOfEntry(entry: ServiceEntry): MethodGroup {
  switch (entry.kind) {
    case "mcp-oauth":
      return "one-click";
    case "cli-login":
      return "on-this-mac";
    case "token":
      return "token";
    case "git-host":
      return entry.gitKind === "bitbucket" ? "token" : "on-this-mac";
    default:
      return "own-app";
  }
}

/** One card of the Add dialog. A card may hold several services (Google) and other ways to connect. */
export interface AddCard {
  id: string;
  name: string;
  summary: string;
  group: MethodGroup;
  time: string;
  /** The services the card connects. One, except Google's Gmail, Calendar and Drive. */
  services: ServiceEntry[];
  /** Other ways to connect the same service. */
  others: ServiceEntry[];
  /** The card is the MCP server by address, or a custom connection type. */
  special?: "mcp-url" | { type: ConnectionType };
  /** The logo of this service id. */
  logo: string | undefined;
}

export const MCP_URL_CARD: AddCard = {
  id: "mcp-url",
  name: "MCP server by address",
  summary: "Any MCP server. majhi finds how it signs in.",
  group: "one-click",
  time: TIME["one-click"],
  services: [],
  others: [],
  special: "mcp-url",
  logo: undefined,
};

const OWN_TYPES: readonly { type: ConnectionType; name: string; summary: string }[] = [
  { type: "ssh", name: "SSH host", summary: "Reach a server through SSH. Agents never hold the key." },
  { type: "kubectl", name: "Kubernetes cluster", summary: "A kubeconfig, one context, one namespace." },
  { type: "mail", name: "Mail server", summary: "A mailbox over IMAP and SMTP." },
  { type: "browser", name: "Browser", summary: "An isolated browser profile for your agents." },
  { type: "env", name: "API keys and values", summary: "Named values for any tool or API." },
  { type: "mcp", name: "MCP server by command", summary: "A local command, or a server with headers." },
  { type: "git", name: "Git host CLI", summary: "glab or gh signed in for this workspace." },
  {
    type: "host",
    name: "Service on this computer",
    summary: "Let agents reach a local stack, port by port. Nothing else.",
  },
];

/** Every card the dialog can show, with the other ways folded under the service they belong to. */
export function addCards(services: readonly ServiceEntry[]): AddCard[] {
  const primary = services.filter((s) => s.alt === undefined);
  const cards: AddCard[] = [];
  const google = primary.filter((s) => s.app === "google");
  for (const entry of primary) {
    if (entry.app === "google") continue;
    cards.push({
      id: entry.id,
      name: entry.name,
      summary: entry.summary,
      group: groupOfEntry(entry),
      time: TIME[groupOfEntry(entry)],
      services: [entry],
      others: services.filter((s) => s.alt === entry.id),
      logo: entry.id,
    });
  }
  if (google.length > 0) {
    cards.push({
      id: "google",
      name: "Google",
      summary: "Gmail, Calendar and Drive from one setup",
      group: "own-app",
      time: TIME["own-app"],
      services: google,
      others: [],
      logo: "gmail",
    });
  }
  cards.push(MCP_URL_CARD);
  for (const t of OWN_TYPES) {
    cards.push({
      id: `type-${t.type}`,
      name: t.name,
      summary: t.summary,
      group: "own",
      time: TIME.own,
      services: [],
      others: [],
      special: { type: t.type },
      logo: undefined,
    });
  }
  return cards;
}

/** Matches the name, the summary and the names of the other ways, ignoring case. */
export function matchesCard(card: AddCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const text = [
    card.name,
    card.summary,
    ...card.others.map((o) => o.name),
    ...card.services.map((s) => s.name),
  ];
  return text.join(" ").toLowerCase().includes(q);
}

/** How a stored connection was connected, to put its row under the right group. */
export function groupOfConnection(view: ConnectionView): MethodGroup {
  const service = view.fields.service?.value;
  const entry = service === undefined ? undefined : serviceById(service);
  switch (view.type) {
    case "mcp":
      if (view.fields.transport?.value === "local") return "own";
      return view.fields.auth?.value === "oauth" ? "one-click" : "token";
    case "api":
      return "own-app";
    case "cli":
      return "on-this-mac";
    case "git":
      return view.fields.signed_in_by?.value === "browser" ? "on-this-mac" : "token";
    case "env":
      return entry === undefined ? "own" : groupOfEntry(entry);
    default:
      return "own";
  }
}
