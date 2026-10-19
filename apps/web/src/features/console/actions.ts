import { useSyncExternalStore } from "react";
import { cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";

/**
 * What the owner has done in the console and can still take back for five seconds: the one place that
 * hides an item the moment it is answered, shows the Undo toast and sends when the time is up. Module
 * state, so a pane that unmounts does not lose a pending answer (it is sent when its time is up).
 */
export const UNDO_MS = 5000;

interface Pending {
  token: number;
  text: string;
  /** Ids hidden from Needs you while this waits. */
  hidden: readonly string[];
  /** Takes it back. */
  undo: () => void;
  timer: number;
}

let nextToken = 1;
const stack: Pending[] = [];
const listeners = new Set<() => void>();
let version = 0;
let hiddenIds: ReadonlySet<string> = new Set();

function changed(): void {
  version += 1;
  hiddenIds = new Set([...snoozeIds(), ...stack.flatMap((p) => p.hidden)]);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The ids Needs you leaves out: answers waiting out their undo time, and what was put off until later. */
export function useHiddenIds(): ReadonlySet<string> {
  useSyncExternalStore(subscribe, () => version);
  return hiddenIds;
}

/** The toast: the newest thing that can be taken back, or nothing. */
export function useUndoToast(): { text: string } | undefined {
  useSyncExternalStore(subscribe, () => version);
  const top = stack.at(-1);
  return top === undefined ? undefined : { text: top.text };
}

function drop(token: number): void {
  const at = stack.findIndex((p) => p.token === token);
  if (at < 0) return;
  const [gone] = stack.splice(at, 1);
  if (gone !== undefined) window.clearTimeout(gone.timer);
  changed();
}

/** Takes back the newest pending action, like the Undo button and the U key. */
export function undoLast(): boolean {
  const top = stack.at(-1);
  if (top === undefined) return false;
  top.undo();
  drop(top.token);
  return true;
}

export interface HoldInput {
  /** The toast line: what was done, "Merge: acme · Login fix". */
  text: string;
  /** Ids to hide from the queue at once. */
  hidden: readonly string[];
  /** Runs when the five seconds are up. Resolves once it is done; a failure brings the items back. */
  send: () => Promise<unknown>;
  /** Called after it was sent, to read again what changed. */
  afterSend?: () => void;
  /** Called with the reason when sending failed. */
  onFail: (message: string) => void;
}

/** Hides the items, shows the Undo toast, and sends after five seconds unless it was taken back. */
export function hold(input: HoldInput): void {
  const token = nextToken++;
  const timer = window.setTimeout(() => {
    input
      .send()
      .then(
        () => undefined,
        (error: unknown) => input.onFail(describeError(error)),
      )
      .finally(() => {
        drop(token);
        input.afterSend?.();
      });
  }, UNDO_MS);
  stack.push({ token, text: input.text, hidden: input.hidden, undo: () => undefined, timer });
  changed();
}

export interface ServerHoldInput {
  text: string;
  hidden: readonly string[];
  /** The decision the server holds, and its key to cancel it. */
  key: string;
  /** Starts the answer with the server's hold: it sends it itself when the time is up. */
  start: () => Promise<unknown>;
  afterSend: () => void;
  onFail: (message: string) => void;
}

/**
 * A one-click answer to a question: the server keeps it for the undo time and sends it, also when this
 * tab is gone (`holdMs` on `decisions.answer`). Undo asks the server to drop it.
 */
export function holdOnServer(input: ServerHoldInput): void {
  const token = nextToken++;
  const timer = window.setTimeout(() => {
    drop(token);
    input.afterSend();
  }, UNDO_MS + 400);
  const pending: Pending = {
    token,
    text: input.text,
    hidden: input.hidden,
    timer,
    undo: () => {
      void cmd("answers.cancelHeld", { key: input.key }, { reason: "Owner undid an answer" }).then(
        () => input.afterSend(),
        () => undefined,
      );
    },
  };
  stack.push(pending);
  changed();
  input.start().then(
    () => undefined,
    (error: unknown) => {
      drop(token);
      input.onFail(describeError(error));
    },
  );
}

// Later ----------------------------------------------------------------------

const SNOOZE_KEY = "majhi.later";
/** How long "Later" puts an item off. */
export const LATER_MS = 4 * 60 * 60 * 1000;

let snoozed: Record<string, number> = readSnoozed();
let wake: number | undefined;

function readSnoozed(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > now),
    );
  } catch {
    return {};
  }
}

function snoozeIds(): string[] {
  const now = Date.now();
  return Object.entries(snoozed)
    .filter(([, until]) => until > now)
    .map(([id]) => id);
}

function saveSnoozed(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(snoozed));
  } catch {
    // Storage can be blocked; Later then lasts until the page reloads.
  }
  window.clearTimeout(wake);
  const soonest = Math.min(...Object.values(snoozed));
  if (Number.isFinite(soonest)) {
    // setTimeout caps at about 24 days; four hours is far inside it.
    wake = window.setTimeout(
      () => {
        snoozed = Object.fromEntries(Object.entries(snoozed).filter(([, until]) => until > Date.now()));
        saveSnoozed();
        changed();
      },
      Math.max(1000, soonest - Date.now() + 50),
    );
  }
}

if (typeof window !== "undefined") {
  saveSnoozed();
  hiddenIds = new Set(snoozeIds());
}

/** Puts items off until `until` (ms); Undo brings them back. Shows the toast like any action. */
export function later(ids: readonly string[], text: string, until: number): void {
  const token = nextToken++;
  for (const id of ids) snoozed[id] = until;
  saveSnoozed();
  const pending: Pending = {
    token,
    text,
    hidden: [],
    timer: window.setTimeout(() => drop(token), UNDO_MS),
    undo: () => {
      for (const id of ids) delete snoozed[id];
      saveSnoozed();
    },
  };
  stack.push(pending);
  changed();
}

/** Shows a line with no Undo, for what could not be done now (offline, nothing to answer). */
export function say(text: string): void {
  const token = nextToken++;
  stack.push({ token, text, hidden: [], undo: () => undefined, timer: window.setTimeout(() => drop(token), UNDO_MS) });
  changed();
}
