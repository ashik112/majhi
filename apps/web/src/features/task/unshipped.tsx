import type { UnshippedRepo } from "@majhi/shared";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** "1 commit not shipped", "3 commits not shipped", or "Not shipped" when git could not count. */
export function unshippedCount(list: readonly UnshippedRepo[]): string {
  const commits = list.reduce((n, r) => n + r.commits, 0);
  if (commits === 0) return "Not shipped";
  return `${commits} commit${commits === 1 ? "" : "s"} not shipped`;
}

/** "task/acm-1-fix", or "task/acm-1-fix and task/acm-1-docs". */
function branches(list: readonly UnshippedRepo[]): string {
  const names = [...new Set(list.map((r) => r.branch))];
  if (names.length <= 1) return names[0] ?? "the branch";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The one confirmation before closing a task whose commits are not merged, pushed or in a pull request. */
export function CloseUnshippedDialog({
  unshipped,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  unshipped: readonly UnshippedRepo[];
  busy: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title="Close without shipping?"
      body={unshippedBody(unshipped)}
      confirmLabel="Close anyway"
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** "1 commit not shipped. The commits stay on task/acm-1-fix." */
export function unshippedBody(list: readonly UnshippedRepo[]): string {
  return `${unshippedCount(list)}. The commits stay on ${branches(list)}.`;
}
