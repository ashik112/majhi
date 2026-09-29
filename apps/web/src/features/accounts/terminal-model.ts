import {
  type HealthCheck,
  type TerminalClientMessage,
  type TerminalServerMessage,
  TerminalServerMessageSchema,
} from "@majhi/shared";

export type TerminalEvent =
  | { kind: "output"; data: string }
  | { kind: "exit"; code: number; health?: HealthCheck }
  | { kind: "ignored" };

/** Parses one WebSocket frame from a login terminal. Frames that do not match the protocol are ignored. */
export function parseTerminalMessage(raw: unknown): TerminalEvent {
  if (typeof raw !== "string") return { kind: "ignored" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "ignored" };
  }
  const parsed = TerminalServerMessageSchema.safeParse(json);
  if (!parsed.success) return { kind: "ignored" };
  return toEvent(parsed.data);
}

function toEvent(message: TerminalServerMessage): TerminalEvent {
  if (message.type === "output") return { kind: "output", data: message.data };
  return message.health
    ? { kind: "exit", code: message.code, health: message.health }
    : { kind: "exit", code: message.code };
}

export function inputMessage(data: string): string {
  const message: TerminalClientMessage = { type: "input", data };
  return JSON.stringify(message);
}

/** Clamped to the ranges the server accepts, so a tiny or huge container never produces a rejected message. */
export function resizeMessage(cols: number, rows: number): string {
  const message: TerminalClientMessage = {
    type: "resize",
    cols: Math.min(500, Math.max(10, Math.round(cols))),
    rows: Math.min(200, Math.max(4, Math.round(rows))),
  };
  return JSON.stringify(message);
}

export type LoginState =
  | { phase: "running" }
  | { phase: "signed-in"; health: HealthCheck }
  /** The command exited non-zero, or exited cleanly but the check afterwards failed or did not run. */
  | { phase: "failed"; code: number; health?: HealthCheck };

/** Folds a terminal event into the login state. Output does not change it. */
export function nextLoginState(state: LoginState, event: TerminalEvent): LoginState {
  if (event.kind !== "exit") return state;
  if (event.code === 0 && event.health?.ok) return { phase: "signed-in", health: event.health };
  return event.health
    ? { phase: "failed", code: event.code, health: event.health }
    : { phase: "failed", code: event.code };
}
