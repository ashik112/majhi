import type { ChatApp } from "@majhi/shared";

/** The chat app's round mark. Telegram's is its own; the others show a letter until their adapters exist. */
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
