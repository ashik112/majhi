import { type Notice, type NoticeLink, PAGE_PATH } from "@majhi/shared";
import { actionOf } from "@/features/decisions/model";
import type { BannerAction } from "@/features/shell/model";

/** Where a row opens: its decision's home, or the page that holds it. */
export function noticeAction(link: NoticeLink): BannerAction {
  return link.kind === "page" ? { kind: "page", to: PAGE_PATH[link.page] } : actionOf(link);
}

/** "now", "22m", "10h", "3d": the short age the bell shows on the right of a row. */
export function shortAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The unread rows first (New), then the read ones (Earlier); each group keeps the server's newest-first order. */
export function groupNotices(notices: readonly Notice[]): { fresh: Notice[]; earlier: Notice[] } {
  return { fresh: notices.filter((n) => !n.read), earlier: notices.filter((n) => n.read) };
}
