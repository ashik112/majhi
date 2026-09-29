import {
  type AgentLive,
  commands,
  type RoomItem,
  type RoomServerMessage,
  RoomServerMessageSchema,
  type Task,
  type ToolContent,
} from "@majhi/shared";

// Room state ----------------------------------------------------------------

export type Connection = "connecting" | "live" | "reconnecting";

export interface RoomState {
  /** In the order they happened (by `at`; an update keeps its place). */
  items: RoomItem[];
  agents: AgentLive[];
  /** True when older items exist on the server. */
  more: boolean;
  /** False until the first snapshot. */
  loaded: boolean;
  connection: Connection;
}

export const emptyRoom: RoomState = {
  items: [],
  agents: [],
  more: false,
  loaded: false,
  connection: "connecting",
};

function isNewer(next: RoomItem, current: RoomItem): boolean {
  return next.seq >= current.seq;
}

/**
 * Adds or updates items by id. An update with a lower seq than the copy we hold is stale and
 * dropped. An update keeps its position; a new item goes after the last item that is not later.
 */
export function mergeItems(current: readonly RoomItem[], incoming: readonly RoomItem[]): RoomItem[] {
  const out = current.slice();
  for (const next of incoming) {
    const at = out.findIndex((item) => item.id === next.id);
    const existing = at === -1 ? undefined : out[at];
    if (existing) {
      if (isNewer(next, existing)) out[at] = next;
      continue;
    }
    let index = out.length;
    while (index > 0 && (out[index - 1]?.at ?? "") > next.at) index -= 1;
    out.splice(index, 0, next);
  }
  return out;
}

/** The lowest seq we hold, the cursor for `room.items`. */
export function oldestSeq(items: readonly RoomItem[]): number | undefined {
  let min: number | undefined;
  for (const item of items) if (min === undefined || item.seq < min) min = item.seq;
  return min;
}

function upsertAgent(agents: readonly AgentLive[], next: AgentLive): AgentLive[] {
  const at = agents.findIndex((a) => a.agent === next.agent);
  if (at === -1) return [...agents, next];
  return agents.map((a, i) => (i === at ? next : a));
}

export type RoomAction =
  | { type: "message"; message: RoomServerMessage }
  | { type: "older"; items: readonly RoomItem[]; more: boolean }
  | { type: "local"; item: RoomItem }
  | { type: "connection"; connection: Connection };

/** Applies one socket message or fetch result. Pure, so it can be tested and cached per task. */
export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };
    case "local":
      return { ...state, items: mergeItems(state.items, [action.item]) };
    case "older":
      return { ...state, items: mergeItems(state.items, action.items), more: action.more };
    case "message": {
      const message = action.message;
      switch (message.type) {
        case "snapshot":
          // Older pages we already loaded stay; `more` only means something before them.
          return {
            ...state,
            items: mergeItems(state.items, message.items),
            agents: message.agents,
            more: state.loaded && state.items.length > message.items.length ? state.more : message.more,
            loaded: true,
          };
        case "item":
          return { ...state, items: mergeItems(state.items, [message.item]) };
        case "agent":
          return { ...state, agents: upsertAgent(state.agents, message.agent) };
        case "task":
          return state;
      }
    }
  }
}

/** Parses one socket frame. Anything that is not a known message is dropped. */
export function parseRoomMessage(raw: unknown): RoomServerMessage | null {
  if (typeof raw !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RoomServerMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function taskFromMessage(message: RoomServerMessage): Task | null {
  return message.type === "task" ? message.task : null;
}

// Derived views -------------------------------------------------------------

type PlanItem = Extract<RoomItem, { type: "plan" }>;
type ToolItem = Extract<RoomItem, { type: "tool" }>;
type PermissionItem = Extract<RoomItem, { type: "permission" }>;

export function planIsOpen(plan: PlanItem): boolean {
  return plan.entries.some((entry) => entry.status !== "completed");
}

/** The latest plan of each agent that still has open entries. These are pinned above the room. */
export function pinnedPlans(items: readonly RoomItem[]): PlanItem[] {
  const latest = new Map<string, PlanItem>();
  for (const item of items) if (item.type === "plan") latest.set(item.agent, item);
  return [...latest.values()].filter(planIsOpen);
}

/** Working means the agent is starting, working or waiting on a permission. */
export function isBusy(agents: readonly AgentLive[]): boolean {
  return agents.some((a) => a.status === "working" || a.status === "starting" || a.status === "waiting");
}

export function isWorking(agent: AgentLive | undefined): boolean {
  return agent?.status === "working" || agent?.status === "starting";
}

// Tool rows -----------------------------------------------------------------

/** The file or path a tool call is about: its first location, else the path of a diff. */
export function toolTarget(item: ToolItem): string | undefined {
  const location = item.locations[0];
  if (location) return location;
  for (const content of item.content) if (content.type === "diff") return content.path;
  return undefined;
}

/** A path as the owner reads it: relative to the task folder when inside it. */
export function shortPath(path: string, folder: string): string {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

export function hasToolDetail(item: ToolItem): boolean {
  return item.content.length > 0;
}

/** Keeps the first `max` lines of text output and says how many were left out. */
export function trimOutput(text: string, max = 40): { text: string; hidden: number } {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length <= max) return { text: lines.join("\n"), hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

/** What majhi does with each option kind, in the owner's words. Adapters name them "Always allow" and "Reject". */
export function permissionOptionLabel(option: PermissionItem["options"][number]): string {
  if (option.kind === "allow_always") return "Allow for this task";
  if (option.kind === "reject_once") return "Deny";
  return option.name;
}

export type PermissionSummary = { pending: true } | { pending: false; text: string };

/** One line for a permission prompt that no longer waits: "Allowed: npm test, by rule". */
export function permissionSummary(item: PermissionItem): PermissionSummary {
  if (item.state === "pending") return { pending: true };
  if (item.state === "cancelled") return { pending: false, text: `Cancelled: ${item.title}` };
  const option = item.options.find((o) => o.id === item.chosen);
  const allowed = option ? option.kind.startsWith("allow") : true;
  const by = item.state === "auto" ? ", by rule" : "";
  const extra = option?.kind === "allow_always" ? " for this task" : "";
  return { pending: false, text: `${allowed ? "Allowed" : "Denied"}${extra}: ${item.title}${by}` };
}

// Touched files -------------------------------------------------------------

export type DiffContent = Extract<ToolContent, { type: "diff" }>;

export interface TouchedFile {
  /** As the agent reported it: usually absolute. */
  path: string;
  /** What happened last: edited, deleted or moved. */
  change: "edit" | "delete" | "move";
  diffs: DiffContent[];
}

const FILE_KINDS: Record<string, TouchedFile["change"]> = { edit: "edit", delete: "delete", move: "move" };

/**
 * The files the agent changed, from completed tool calls: edit, delete and move calls by their
 * locations, and any diff content by its path. In order of first touch.
 */
export function touchedFiles(items: readonly RoomItem[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  const touch = (path: string, change: TouchedFile["change"], diff?: DiffContent) => {
    const file = byPath.get(path) ?? { path, change, diffs: [] };
    file.change = change;
    if (diff) file.diffs.push(diff);
    byPath.set(path, file);
  };
  for (const item of items) {
    if (item.type !== "tool" || item.status !== "completed") continue;
    const change = FILE_KINDS[item.kind];
    const diffs = item.content.filter((c): c is DiffContent => c.type === "diff");
    for (const diff of diffs) touch(diff.path, change ?? "edit", diff);
    if (change) {
      for (const location of item.locations) {
        if (!diffs.some((d) => d.path === location)) touch(location, change);
      }
    }
  }
  return [...byPath.values()];
}

export interface RepoFiles<R> {
  repo: R | undefined;
  files: (TouchedFile & { shown: string })[];
}

/**
 * Splits touched files by the repo worktree they live in. `shown` is the path inside the repo.
 * Relative paths go to the only repo when there is one. Files outside every worktree get no repo.
 */
export function filesByRepo<R extends { worktree?: string | undefined }>(
  files: readonly TouchedFile[],
  repos: readonly R[],
): RepoFiles<R>[] {
  const groups = new Map<R | undefined, RepoFiles<R>["files"]>();
  for (const repo of repos) groups.set(repo, []);
  for (const file of files) {
    let owner: R | undefined;
    let shown = file.path;
    for (const repo of repos) {
      const root = repo.worktree?.replace(/\/+$/, "");
      if (root && file.path.startsWith(`${root}/`)) {
        owner = repo;
        shown = file.path.slice(root.length + 1);
        break;
      }
    }
    if (!owner && !file.path.startsWith("/") && repos.length === 1) owner = repos[0];
    const list = groups.get(owner) ?? [];
    list.push({ ...file, shown });
    groups.set(owner, list);
  }
  return [...groups.entries()]
    .map(([repo, list]) => ({ repo, files: list }))
    .filter((group) => group.repo !== undefined || group.files.length > 0);
}

// Diffs ---------------------------------------------------------------------

export type CtxLine = { kind: "ctx"; text: string; oldNo: number; newNo: number };
export type AddLine = { kind: "add"; text: string; newNo: number };
export type DelLine = { kind: "del"; text: string; oldNo: number };
export type DiffLine = CtxLine | AddLine | DelLine | { kind: "gap"; hidden: number };

/** Above this many old lines times new lines the diff is shown as remove-all, add-all. */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A line diff of two texts: keeps common lines as context, marks the rest removed or added. */
export function diffLines(oldText: string | undefined, newText: string): DiffLine[] {
  const a = splitLines(oldText ?? "");
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  type Op = { kind: "ctx" | "add" | "del"; text: string };
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: "ctx", text: a[i] ?? "" });

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const text of midA) ops.push({ kind: "del", text });
    for (const text of midB) ops.push({ kind: "add", text });
  } else {
    // Longest common subsequence table, filled from the end so the walk below runs forward.
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: "ctx", text: midA[i] ?? "" });
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        ops.push({ kind: "del", text: midA[i] ?? "" });
        i += 1;
      } else {
        ops.push({ kind: "add", text: midB[j] ?? "" });
        j += 1;
      }
    }
    for (; i < midA.length; i += 1) ops.push({ kind: "del", text: midA[i] ?? "" });
    for (; j < midB.length; j += 1) ops.push({ kind: "add", text: midB[j] ?? "" });
  }
  for (let i = endA; i < a.length; i += 1) ops.push({ kind: "ctx", text: a[i] ?? "" });

  let oldNo = 0;
  let newNo = 0;
  return ops.map((op): DiffLine => {
    if (op.kind === "del") {
      oldNo += 1;
      return { kind: "del", text: op.text, oldNo };
    }
    if (op.kind === "add") {
      newNo += 1;
      return { kind: "add", text: op.text, newNo };
    }
    oldNo += 1;
    newNo += 1;
    return { kind: "ctx", text: op.text, oldNo, newNo };
  });
}

/** Keeps `context` lines around each change and replaces long runs of unchanged lines with a gap. */
export function collapseContext(lines: readonly DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.kind === "ctx") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1)
      keep[k] = true;
  });
  const out: DiffLine[] = [];
  let hidden = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (hidden > 0) out.push({ kind: "gap", hidden });
      hidden = 0;
      out.push(line);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) out.push({ kind: "gap", hidden });
  return out;
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

export type SplitRow =
  | { kind: "gap"; hidden: number }
  | { left?: CtxLine | DelLine; right?: CtxLine | AddLine };

/** Pairs removed and added runs side by side. Context lines appear on both sides. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DelLine[] = [];
  let adds: AddLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i += 1) {
      const row: SplitRow = {};
      const left = dels[i];
      const right = adds[i];
      if (left) row.left = left;
      if (right) row.right = right;
      rows.push(row);
    }
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "del") dels.push(line);
    else if (line.kind === "add") adds.push(line);
    else {
      flush();
      rows.push(line.kind === "gap" ? line : { left: line, right: line });
    }
  }
  flush();
  return rows;
}

// Composer ------------------------------------------------------------------

export type ComposerAction = "send" | "interrupt" | "newline" | "cancel" | "close-popup" | "none";

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
}

/**
 * What a key press in the composer does. Enter sends (the server queues it while the agent works),
 * Cmd or Ctrl with Enter interrupts a working agent and sends, Shift+Enter adds a line, Esc closes
 * a popup or else stops the agent. With a popup open, Enter and arrows belong to the popup.
 */
export function composerKey(
  event: KeyInput,
  state: { popupOpen: boolean; busy: boolean; hasContent: boolean },
): ComposerAction {
  if (event.isComposing) return "none";
  if (event.key === "Escape") return state.popupOpen ? "close-popup" : "cancel";
  if (event.key !== "Enter") return "none";
  if (state.popupOpen && !event.metaKey && !event.ctrlKey) return "none";
  if (event.shiftKey) return "newline";
  if (!state.hasContent) return "none";
  if (event.metaKey || event.ctrlKey) return state.busy ? "interrupt" : "send";
  return "send";
}

export interface Trigger {
  kind: "slash" | "mention";
  query: string;
  /** Index of the `/` or `@`. */
  start: number;
  end: number;
}

/**
 * The `/` command or `@` file mention being typed at the caret. A slash only counts at the very
 * start of the text; an `@` counts at the start of a word.
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const word = /(^|\s)([/@])([^\s]*)$/.exec(before);
  if (!word) return null;
  const sign = word[2];
  const query = word[3] ?? "";
  const start = caret - query.length - 1;
  if (sign === "/") {
    if (start !== 0) return null;
    return { kind: "slash", query, start, end: caret };
  }
  return { kind: "mention", query, start, end: caret };
}

/** Puts the chosen command or path in place of the trigger and says where the caret goes. */
export function applyCompletion(
  text: string,
  trigger: Trigger,
  insert: string,
): { text: string; caret: number } {
  const sign = trigger.kind === "slash" ? "/" : "@";
  const inserted = `${sign}${insert} `;
  const after = text.slice(trigger.end).replace(/^ /, "");
  return { text: text.slice(0, trigger.start) + inserted + after, caret: trigger.start + inserted.length };
}

/** Slash commands whose name starts with, else contains, the query. */
export function filterCommands<T extends { name: string }>(commands: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}

/** True when the pointer or list should stay pinned to the bottom: within a few lines of it. */
export function nearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  slack = 48,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

// Tool names ------------------------------------------------------------------

/** CLI tools that only load other tools: shown as a quiet line, not as work. */
const QUIET_TOOLS = new Set(["ToolSearch"]);

export function isQuietTool(title: string): boolean {
  return QUIET_TOOLS.has(title.trim());
}

/**
 * A tool call's title in plain words. The CLIs name MCP tools `mcp__<server>__<tool>`; majhi's own
 * become "majhi: <what the command does>", others "server: tool".
 */
export function toolLabel(title: string): string {
  const t = title.trim();
  if (isQuietTool(t)) return "Loaded tools";
  const mcp = /^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/.exec(t);
  if (!mcp) return title;
  const server = mcp[1] ?? "";
  const tool = mcp[2] ?? "";
  if (server === "majhi-decide") return "majhi: Ask the decision model";
  if (server === "majhi-admin") {
    if (tool === "majhi_request_secret") return "majhi: Ask you for a secret";
    const name = tool.replace(/^majhi_/, "").replace(/_/g, ".");
    const summary = (commands as Record<string, { summary: string } | undefined>)[name]?.summary;
    return `majhi: ${summary ? firstSentence(summary) : name}`;
  }
  return `${server}: ${tool.replace(/_/g, " ")}`;
}

function firstSentence(text: string): string {
  const cut = text.indexOf(". ");
  return cut === -1 ? text.replace(/\.$/, "") : text.slice(0, cut);
}

type ContextItem = Extract<RoomItem, { type: "context" }>;

/** `164k`, `18k`, `950`. */
export function shortTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

/** One quiet line for a compaction: "@builder compacted: 164k to 18k tokens (native)". */
export function contextLine(item: ContextItem): string {
  const { before, after } = item;
  if (before !== undefined && after !== undefined) {
    return `@${item.agent} compacted: ${shortTokens(before)} to ${shortTokens(after)} tokens (${item.method})`;
  }
  const size = after === undefined ? "" : `: ${shortTokens(after)} tokens`;
  return `@${item.agent} moved to a fresh session${size} (${item.method})`;
}
