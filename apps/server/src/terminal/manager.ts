import { randomUUID } from "node:crypto";
import type { HealthCheck, TerminalServerMessage } from "@majhi/shared";
import * as nodePty from "node-pty";

/** Output kept for late joiners. */
export const BUFFER_LIMIT_BYTES = 256 * 1024;
/** A terminal is removed this long after its command exits. */
export const REMOVE_AFTER_EXIT_MS = 60_000;
/** A command still running after this is killed. */
export const MAX_RUNTIME_MS = 15 * 60_000;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export interface TerminalSpec {
  /** One live terminal per key: starting a second one kills the first. */
  key: string;
  command: string;
  args: string[];
  /** The whole environment of the process. Nothing is added from the server's own. */
  env: Record<string, string>;
  cwd: string;
  /** Runs after the command exits. What it returns is sent in the `exit` message. */
  onExit?: (code: number) => Promise<HealthCheck | undefined>;
}

export interface TerminalTimers {
  removeAfterExitMs?: number;
  maxRuntimeMs?: number;
}

type Listener = (message: TerminalServerMessage) => void;

/** One command in a pty, with its output buffer and the sockets watching it. */
export class Terminal {
  readonly id = randomUUID();
  private buffer = "";
  private exitMessage: TerminalServerMessage | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly key: string,
    private readonly pty: nodePty.IPty,
  ) {}

  get exited(): boolean {
    return this.exitMessage !== undefined;
  }

  /** Sends the buffered output (and the exit, when it happened), then everything after. Returns a stop function. */
  subscribe(listener: Listener): () => void {
    if (this.buffer !== "") listener({ type: "output", data: this.buffer });
    if (this.exitMessage !== undefined) listener(this.exitMessage);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.pty.resize(cols, rows);
  }

  kill(): void {
    if (!this.exited) this.pty.kill();
  }

  /** @internal Called by the manager. */
  pushOutput(data: string): void {
    this.buffer += data;
    if (Buffer.byteLength(this.buffer) > BUFFER_LIMIT_BYTES) {
      // Keep the tail. Slicing by characters is close enough for a cap of this size.
      this.buffer = this.buffer.slice(-BUFFER_LIMIT_BYTES);
    }
    this.emit({ type: "output", data });
  }

  /** @internal Called by the manager. */
  finish(message: TerminalServerMessage): void {
    this.exitMessage = message;
    this.emit(message);
  }

  private emit(message: TerminalServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly removeAfterExitMs: number;
  private readonly maxRuntimeMs: number;

  constructor(timers: TerminalTimers = {}) {
    this.removeAfterExitMs = timers.removeAfterExitMs ?? REMOVE_AFTER_EXIT_MS;
    this.maxRuntimeMs = timers.maxRuntimeMs ?? MAX_RUNTIME_MS;
  }

  get(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  start(spec: TerminalSpec): Terminal {
    for (const old of this.terminals.values()) if (old.key === spec.key) old.kill();

    const pty = nodePty.spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: spec.cwd,
      env: { TERM: "xterm-256color", ...spec.env },
    });
    const terminal = new Terminal(spec.key, pty);
    this.terminals.set(terminal.id, terminal);

    const limit = setTimeout(() => terminal.kill(), this.maxRuntimeMs);
    limit.unref();
    pty.onData((data) => terminal.pushOutput(data));
    pty.onExit(({ exitCode }) => {
      clearTimeout(limit);
      void this.finish(terminal, exitCode, spec.onExit);
    });
    return terminal;
  }

  /** Kills every running terminal. Called on shutdown. */
  closeAll(): void {
    for (const terminal of this.terminals.values()) terminal.kill();
  }

  /** Kills the running terminal with this key, if any. */
  killKey(key: string): void {
    for (const terminal of this.terminals.values()) if (terminal.key === key) terminal.kill();
  }

  private async finish(terminal: Terminal, code: number, onExit: TerminalSpec["onExit"]): Promise<void> {
    let health: HealthCheck | undefined;
    try {
      health = await onExit?.(code);
    } catch {
      // The exit message still goes out without a health result.
    }
    terminal.finish(health === undefined ? { type: "exit", code } : { type: "exit", code, health });
    const remove = setTimeout(() => this.terminals.delete(terminal.id), this.removeAfterExitMs);
    remove.unref();
  }
}
