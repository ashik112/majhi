import type { ChatApp } from "@majhi/shared";

/** The chat app's round mark. Telegram and Slack have their own; the others show a letter until their adapters exist. */
export function AppMark({ app, size = 20 }: { app: ChatApp; size?: number }) {
  if (app === "telegram") {
    return (
      <span className="inline-flex shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
          <circle cx="12" cy="12" r="12" fill="#29A9EB" />
          <path
            fill="#fff"
            d="M5.4 11.7l11.9-4.6c.6-.2 1 .1.8.9l-2 9.5c-.1.7-.6.8-1.1.5l-3-2.2-1.5 1.4c-.2.2-.3.3-.6.3l.2-3.1 5.6-5.1c.2-.2 0-.3-.4-.1l-6.9 4.4-3-.9c-.6-.2-.7-.6.1-.9z"
          />
        </svg>
      </span>
    );
  }
  if (app === "slack") {
    // Slack's mark is dark on its own, so it sits on a white disc that reads in both themes.
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full"
        style={{ width: size, height: size, backgroundColor: "#fff" }}
      >
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden="true">
          <path
            fill="#4A154B"
            d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
          />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-raised font-mono text-xs uppercase text-fg-muted"
      style={{ width: size, height: size }}
    >
      {app.charAt(0)}
    </span>
  );
}
