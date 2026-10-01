import type { AttentionEvent } from "@majhi/shared";
import { useEffect, useState } from "react";

/** The browser's permission for notifications, or `unsupported` where there is no Notification API. */
export type Permission = NotificationPermission | "unsupported";

export function currentPermission(): Permission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

const PROMPT_KEY = "majhi.notify-prompt";

function dismissedBefore(): boolean {
  try {
    return window.localStorage.getItem(PROMPT_KEY) === "no";
  } catch {
    return false;
  }
}

/** Whether to show the notice at all: asked from the banner, never on load. */
export function shouldAsk(permission: Permission, dismissed: boolean): boolean {
  return permission === "default" && !dismissed;
}

/**
 * Whether a tab shows a notification for an event. The owner's setting must allow it and the browser
 * must have granted it. A tab the owner is looking at already shows the banner, so only a hidden or
 * unfocused tab pops one, except for the test button, which always shows.
 */
export function shouldPop(
  event: Pick<AttentionEvent, "browser" | "kind">,
  permission: Permission,
  tab: { visible: boolean; focused: boolean },
): boolean {
  if (!event.browser || permission !== "granted") return false;
  return event.kind === "test" || !tab.visible || !tab.focused;
}

/** Shows the notification of an event. Clicking it brings the tab forward and opens the page. */
export function showAttention(event: AttentionEvent, open: (path: string) => void): void {
  const tab = { visible: document.visibilityState === "visible", focused: document.hasFocus() };
  if (!shouldPop(event, currentPermission(), tab)) return;
  try {
    const note = new Notification(event.kind === "group" ? "majhi" : event.title, {
      body: event.text,
      tag: event.id,
      silent: !event.sound,
    });
    note.onclick = () => {
      window.focus();
      open(event.path);
      note.close();
    };
  } catch {
    // Some browsers refuse `new Notification` outside a service worker. The banner still shows.
  }
}

/** The permission, whether the notice is showing, and what its two buttons do. */
export function useNotifyPrompt(enabled: boolean) {
  const [permission, setPermission] = useState<Permission>(currentPermission);
  const [dismissed, setDismissed] = useState(dismissedBefore);
  return {
    show: enabled && shouldAsk(permission, dismissed),
    permission,
    enable: () => {
      if (typeof Notification === "undefined") return;
      void Notification.requestPermission().then(setPermission);
    },
    dismiss: () => {
      setDismissed(true);
      try {
        window.localStorage.setItem(PROMPT_KEY, "no");
      } catch {
        // Not remembered: the notice returns on the next visit.
      }
    },
  };
}

/** "(3) majhi": the count in front of the tab's title, or the title alone at zero. */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
}

/** The count on the tab: in front of the title and as a badge on the icon. */
export function useAttentionBadge(count: number): void {
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\) /, "");
    document.title = titleWithCount(base, count);
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (link === null) return;
    const original = link.dataset.original ?? link.href;
    link.dataset.original = original;
    if (count === 0) {
      link.href = original;
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) link.href = badged(image, count);
    };
    image.onerror = () => {
      if (!cancelled) link.href = badged(undefined, count);
    };
    image.src = original;
    return () => {
      cancelled = true;
    };
  }, [count]);
}

function badged(image: HTMLImageElement | undefined, count: number): string {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return image?.src ?? "";
  if (image !== undefined) ctx.drawImage(image, 0, 0, size, size);
  ctx.fillStyle = "#e5484d";
  ctx.beginPath();
  ctx.arc(44, 20, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 26px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count > 9 ? "9+" : String(count), 44, 21);
  return canvas.toDataURL("image/png");
}
