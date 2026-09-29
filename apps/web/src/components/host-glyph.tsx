import type { GitHost } from "@majhi/shared";
import { Server } from "lucide-react";
import { cn } from "@/lib/cn";

const HOST_COLOR: Record<GitHost, string> = {
  github: "text-fg-soft",
  gitlab: "text-coral",
  bitbucket: "text-blue",
  other: "text-fg-faint",
};

/** Line marks drawn on lucide's 24px grid and 2px stroke so they sit with the rest of the icon set. */
export function HostGlyph({ host, className }: { host: GitHost; className?: string }) {
  const classes = cn("size-3.5 shrink-0", HOST_COLOR[host], className);
  if (host === "other") return <Server className={classes} aria-hidden="true" />;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={classes}
    >
      {host === "github" && (
        <>
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          <path d="M9 18c-4.51 2-5-2-7-2" />
        </>
      )}
      {host === "gitlab" && (
        <path d="m22 13.29-3.33-10a.42.42 0 0 0-.78 0l-2.26 6.67H8.37L6.1 3.29a.42.42 0 0 0-.78 0L2 13.29a.74.74 0 0 0 .27.83L12 21l9.73-6.88a.74.74 0 0 0 .27-.83Z" />
      )}
      {host === "bitbucket" && (
        <>
          <path d="M3 4.5h18l-2.6 15H5.6Z" />
          <path d="M9.2 9.5h5.6l-.8 5h-4Z" />
        </>
      )}
    </svg>
  );
}
