import { WIKI_COST_CAP_USD } from "@majhi/shared";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { describeError } from "@/lib/errors";
import { formatMoney, formatTokens, plural } from "@/lib/format";
import { useWikiEstimate, useWikiUpdate } from "@/lib/wiki-queries";

/**
 * Update, with what it would cost first. An update rewrites only the pages whose cited files changed, so the
 * estimate says how many and what they cost. Where the server cannot estimate or run an update, the dialog
 * says that and offers no button that does nothing.
 */
export function UpdateDialog({
  org,
  project,
  onClose,
}: {
  org: string;
  project: string;
  onClose: () => void;
}) {
  const estimate = useWikiEstimate(org, project, true);
  const update = useWikiUpdate();
  const data = estimate.data;
  const nothing = data !== undefined && data.pages === 0;
  let body: React.ReactNode;
  if (estimate.isPending) body = "Working out what an update would cost.";
  else if (estimate.isError) body = "majhi cannot say yet what an update would cost.";
  else if (data === undefined) body = null;
  else if (nothing)
    body = data.note ?? "Nothing changed since the pages were built, so there is nothing to rewrite.";
  else {
    body = (
      <>
        <p className="m-0">
          Rewrites {plural(data.pages, "page")} of {plural(data.projects, "project")}: about{" "}
          {formatTokens(data.tokens)} tokens
          {data.usd === undefined ? "" : `, about ${formatMoney(data.usd)}`}.
        </p>
        <p className="m-0 mt-2">
          One update stops at {formatMoney(data.cap || WIKI_COST_CAP_USD)}.
          {data.overCap && " This one is over that, so it would stop early and leave some pages as they are."}
        </p>
      </>
    );
  }
  const error = estimate.isError
    ? describeError(estimate.error)
    : update.isError
      ? describeError(update.error)
      : undefined;
  return (
    <ConfirmDialog
      title="Update the wiki"
      body={body}
      confirmLabel="Update"
      busy={update.isPending}
      confirmDisabled={estimate.isPending || estimate.isError || nothing}
      error={error}
      onConfirm={() => update.mutate({ org, project }, { onSuccess: onClose })}
      onCancel={onClose}
    />
  );
}
