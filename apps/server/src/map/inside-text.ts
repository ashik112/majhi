import type { InsideData, InsideTrigger } from "@majhi/shared";

/**
 * The plain sentences of the Inside tab when no model has written better ones. They come from facts only:
 * the kind of thing a function does (its first word), what it does it to (the rest of its name, or the class
 * it belongs to), the table, the file, the outside call. A function name never appears in a sentence; the
 * names are in the detail list of an opened step.
 */

export const capital = (word: string): string => word.slice(0, 1).toUpperCase() + word.slice(1);

/** Words of a name: `reservedPorts` is reserved, ports; `retention.count` is just count. */
export function splitName(name: string): string[] {
  const out: string[] = [];
  let cur = "";
  let prevLower = false;
  for (const ch of name) {
    const lower = ch >= "a" && ch <= "z";
    const upper = ch >= "A" && ch <= "Z";
    const digit = ch >= "0" && ch <= "9";
    if (!lower && !upper && !digit) {
      if (cur !== "") out.push(cur.toLowerCase());
      cur = "";
      prevLower = false;
      continue;
    }
    if (upper && prevLower && cur !== "") {
      out.push(cur.toLowerCase());
      cur = "";
    }
    cur += ch;
    prevLower = lower || digit;
  }
  if (cur !== "") out.push(cur.toLowerCase());
  return out;
}

/** What the first word of a function name says it does. A phrase that ends in a preposition takes an object. */
const VERBS: Readonly<Record<string, string>> = {
  create: "creates",
  add: "adds",
  make: "makes",
  build: "builds",
  new: "creates",
  insert: "saves",
  save: "saves",
  write: "writes",
  put: "saves",
  set: "sets",
  change: "saves the change to",
  update: "updates",
  edit: "updates",
  patch: "updates",
  delete: "deletes",
  remove: "removes",
  drop: "removes",
  prune: "removes",
  clear: "clears",
  clean: "cleans up",
  purge: "removes",
  get: "looks up",
  find: "looks up",
  lookup: "looks up",
  list: "lists",
  read: "reads",
  load: "loads",
  fetch: "fetches",
  view: "builds the view of",
  show: "shows",
  search: "searches",
  query: "queries",
  count: "counts",
  check: "checks",
  test: "tests",
  validate: "checks",
  verify: "checks",
  assert: "checks",
  ensure: "makes sure of",
  is: "checks",
  has: "checks",
  can: "checks",
  send: "sends",
  notify: "notifies about",
  report: "reports",
  post: "sends",
  publish: "publishes",
  emit: "announces",
  start: "starts",
  run: "runs",
  spawn: "starts",
  launch: "starts",
  stop: "stops",
  cancel: "cancels",
  close: "closes",
  open: "opens",
  exchange: "exchanges",
  discover: "looks up",
  probe: "checks",
  identify: "identifies",
  revoke: "revokes",
  refresh: "renews",
  renew: "renews",
  sweep: "sweeps",
  poll: "polls",
  sync: "syncs",
  parse: "reads",
  format: "formats",
  render: "renders",
  resolve: "works out",
  decide: "decides",
  apply: "applies",
  commit: "commits",
  merge: "merges",
  register: "registers",
  subscribe: "subscribes to",
  handle: "handles",
  process: "processes",
  compute: "works out",
  derive: "works out",
  scan: "scans",
  capture: "captures",
  record: "records",
  log: "logs",
  tell: "tells",
  ask: "asks",
  approve: "approves",
  reject: "rejects",
  connect: "connects",
  disconnect: "disconnects",
  attach: "attaches",
  detach: "detaches",
  mount: "mounts",
  install: "installs",
  download: "downloads",
  upload: "uploads",
  reserve: "reserves",
  assign: "assigns",
  pick: "picks",
  plan: "plans",
  summarize: "summarizes",
  index: "indexes",
  embed: "embeds",
  upsert: "saves",
  begin: "begins",
  finish: "finishes",
  end: "ends",
  expire: "expires",
  restore: "restores",
  backup: "backs up",
};
/** Verbs too general to say what an outside call is for. */
const GENERIC = new Set([
  "post",
  "get",
  "fetch",
  "send",
  "run",
  "handle",
  "call",
  "request",
  "process",
  "do",
]);
/** Words that describe an object rather than name it. */
const ADJECTIVES = new Set([
  "old",
  "all",
  "new",
  "stale",
  "expired",
  "due",
  "pending",
  "current",
  "next",
  "last",
]);
/** The end of a class name that says what kind of thing it is, not what it is about. */
const KINDS = new Set([
  "service",
  "store",
  "repo",
  "manager",
  "handler",
  "controller",
  "provider",
  "client",
  "helper",
]);

const singular = (w: string): string =>
  w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

/** What a function belongs to: the property or class before its name (`ConnectionService.create` is connection). */
function subjectOf(id: string): string {
  const parts = (id.split(":")[0] ?? id).split(".");
  const prev = parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
  if (prev === "") return "";
  const first = prev.slice(0, 1);
  const isProperty = first === first.toLowerCase();
  const words = splitName(prev).filter((w) => isProperty || !KINDS.has(w));
  const last = words.length - 1;
  return words.map((w, i) => (i === last ? singular(w) : w)).join(" ");
}

/** The first word of a function's name, when it names a known action. */
export function verbClass(id: string): string | undefined {
  const last = (id.split(":")[0] ?? id).split(".").pop() ?? id;
  const w = splitName(last)[0];
  return w === undefined ? undefined : w;
}

/** Whether a doc line starts with what the function does ("Creates a finding"), not with a noun ("Every scope"). */
function startsWithAction(text: string): boolean {
  const w = (text.split(" ")[0] ?? "").toLowerCase();
  if (VERBS[w] !== undefined) return true;
  return w.endsWith("s") && (VERBS[w.slice(0, -1)] !== undefined || VERBS[w.slice(0, -2)] !== undefined);
}

/** Whether a function's name says what it does: only those are worth a line under "if it fails". */
export function hasKnownVerb(id: string): boolean {
  const w = verbClass(id);
  return w !== undefined && VERBS[w] !== undefined && w !== "log";
}

/** What a function does, as a verb phrase without a capital or a full stop: "creates the connection". */
export function describeFn(id: string, doc = ""): string {
  const text = doc.endsWith(".") ? doc.slice(0, -1) : doc;
  if (text !== "" && doc.length < 88 && !text.includes("`") && startsWithAction(text))
    return text.slice(0, 1).toLowerCase() + text.slice(1);
  const last = (id.split(":")[0] ?? id).split(".").pop() ?? id;
  const words = splitName(last);
  const subject = subjectOf(id);
  const verb = words[0] === undefined ? undefined : VERBS[words[0]];
  if (verb === undefined) {
    const noun = words.join(" ");
    return noun === "" ? "does its part of the work" : `handles the ${noun}`;
  }
  const rest = words.slice(1);
  const object =
    rest.length === 0
      ? subject === ""
        ? "entries"
        : subject
      : rest.every((w) => ADJECTIVES.has(w))
        ? `${rest.join(" ")} ${subject === "" ? "entries" : subject}`
        : rest.join(" ");
  return `${verb} the ${object}`;
}

/** The sentence of a step that hands the work to another part. */
export function callSentence(id: string, doc: string): string {
  return `${capital(describeFn(id, doc))}.`;
}

/** The sentence of a step that goes out over the web: what the nearest meaningful caller does, "with an outside service". */
export function outsideSentence(callers: readonly string[]): string {
  for (const id of callers.toReversed()) {
    const w = verbClass(id);
    if (w !== undefined && VERBS[w] !== undefined && !GENERIC.has(w))
      return `${capital(describeFn(id))} with an outside service.`;
  }
  return "Sends a web request to an outside service.";
}

/** The sentence of an entry point itself. `next` is the first function it runs, when there is one. */
export function entrySentence(
  kind: InsideTrigger,
  raw: string,
  next: { id: string; doc: string } | undefined,
): string {
  switch (kind) {
    case "HTTP":
      return `Receives ${raw}.`;
    case "SOCKET":
      return "A live connection opens.";
    case "TOOL":
      return "An agent calls a tool.";
    case "SCHEDULE":
      return next === undefined ? `Wakes up ${raw}.` : `${capital(raw)}, ${describeFn(next.id, next.doc)}.`;
    case "QUEUE":
      return `A job for ${raw} arrives.`;
    case "COMMAND":
      return `${capital(raw)} starts.`;
  }
}

/** The tables of one datastore a step touches, with what it does to each: one sentence. */
export function tablesSentence(
  byTable: ReadonlyMap<string, ReadonlySet<"read" | "write" | "call" | "use">>,
  named: boolean,
): string {
  const names = (verb: "read" | "write") => [...byTable].filter(([, v]) => v.has(verb)).map(([n]) => n);
  const phrase = (list: readonly string[]) => {
    const head = list.slice(0, 3).join(", ");
    const what = list.length > 3 ? `${head} and ${list.length - 3} more` : head;
    return named ? `the ${what} ${list.length === 1 ? "table" : "tables"}` : what;
  };
  const reads = names("read");
  const writes = names("write");
  const others = [...byTable].filter(([, v]) => !v.has("read") && !v.has("write")).map(([n]) => n);
  const parts = [
    ...(reads.length > 0 ? [`reads from ${phrase(reads)}`] : []),
    ...(writes.length > 0 ? [`saves to ${phrase(writes)}`] : []),
    ...(others.length > 0 ? [`uses ${phrase(others)}`] : []),
  ];
  return `${capital(parts.join(", "))}.`;
}

const PHRASE: Readonly<Record<string, string>> = {
  "Hacker News": "reads the Hacker News front page",
  Stripe: "creates a payment with Stripe",
  OpenAI: "sends the request to OpenAI",
  Anthropic: "sends the prompt to Anthropic",
  Telegram: "talks to Telegram",
  GitHub: "reads from GitHub",
  Slack: "posts to Slack",
  Sentry: "reports to Sentry",
  Twilio: "sends through Twilio",
  SendGrid: "sends the email through SendGrid",
  Resend: "sends the email through Resend",
  Exa: "searches the web with Exa",
  Firecrawl: "scrapes the page with Firecrawl",
  Replicate: "runs the model on Replicate",
};

/** The sentence of a step that uses one thing: a table, files, a program, a named service, another project. */
export function dataSentence(data: InsideData, verb: "read" | "write" | "call" | "use"): string {
  if (data.kind === "out" && data.name === "Processes") return "Starts a program.";
  if (data.kind === "out" && data.name === "Files")
    return verb === "write"
      ? "Writes files on disk."
      : verb === "read"
        ? "Reads files from disk."
        : "Uses files on disk.";
  if (data.kind === "out") {
    const phrase = PHRASE[data.name];
    return phrase === undefined ? `Sends a request to ${data.name}.` : `${capital(phrase)}.`;
  }
  if (data.kind === "proj") return `Hands the work to ${data.name}.`;
  const store = data.sub.endsWith("table") ? `the ${data.name} table` : data.name;
  if (verb === "write") return `Saves to ${store}.`;
  if (verb === "read") return `Reads from ${store}.`;
  return `Uses ${store}.`;
}
