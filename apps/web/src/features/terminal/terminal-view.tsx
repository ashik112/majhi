import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { closeSocket, wsUrl } from "@/lib/events-model";
import { inputMessage, parseTerminalMessage, resizeMessage, type TerminalEvent } from "./terminal-model";

/**
 * A terminal: xterm.js connected to `/api/term/<terminalId>`. Output is written as it
 * arrives, key presses are sent as input, and the size follows the container. `onEvent` gets
 * every parsed message, so the parent can react to the exit.
 * Esc goes to the tool, not to the dialog around the terminal.
 */
export function TerminalView({
  terminalId,
  onEvent,
  label,
  className,
}: {
  terminalId: string;
  onEvent: (event: TerminalEvent) => void;
  /** The accessible name of the terminal. */
  label: string;
  /** The size: a fixed height, or `min-h-0 flex-1` to fill the pane. */
  className: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      theme: { background: "#0e0f11", foreground: "#ecedef", cursor: "#f0b455" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const socket = new WebSocket(wsUrl(`/api/term/${encodeURIComponent(terminalId)}`, window.location));
    const send = (text: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    };
    socket.onopen = () => send(resizeMessage(term.cols, term.rows));
    socket.onmessage = (message) => {
      const event = parseTerminalMessage(message.data);
      if (event.kind === "output") term.write(event.data);
      if (event.kind !== "ignored") handler.current(event);
    };

    const input = term.onData((data) => send(inputMessage(data)));
    const size = term.onResize(({ cols, rows }) => send(resizeMessage(cols, rows)));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);
    const stopEsc = (event: KeyboardEvent) => {
      // Bubble phase: xterm has already sent the key to the tool by the time it gets here.
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    container.addEventListener("keydown", stopEsc);
    term.focus();

    return () => {
      container.removeEventListener("keydown", stopEsc);
      observer.disconnect();
      input.dispose();
      size.dispose();
      closeSocket(socket);
      term.dispose();
    };
  }, [terminalId]);

  return (
    <section
      ref={host}
      aria-label={label}
      className={`overflow-hidden rounded-md border border-line-strong bg-sunken p-2 ${className}`}
    />
  );
}
