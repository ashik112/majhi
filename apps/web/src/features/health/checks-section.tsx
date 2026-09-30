import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useFixCheck, useHealthChecks } from "@/lib/ops-queries";
import { type CheckRow, checksSummary, checkTone, groupChecks } from "./model";

interface FixResult {
  ok: boolean;
  detail: string;
}

/** Every doctor check, grouped, each with the Fix majhi can run itself. Sits above Accounts. */
export function ChecksSection({ onSignIn }: { onSignIn: (accountId: string) => void }) {
  const checks = useHealthChecks();
  const fix = useFixCheck();
  const [busy, setBusy] = useState<string>();
  const [results, setResults] = useState<Record<string, FixResult>>({});

  async function runFix(row: CheckRow) {
    setBusy(row.id);
    try {
      const out = await fix.mutateAsync(row.id);
      setResults((prev) => ({ ...prev, [row.id]: { ok: out.ok, detail: out.detail } }));
      if (out.open?.kind === "sign-in") onSignIn(out.open.account);
    } catch (err) {
      setResults((prev) => ({ ...prev, [row.id]: { ok: false, detail: describeError(err) } }));
    } finally {
      setBusy(undefined);
    }
  }

  const rows = checks.data?.checks ?? [];
  return (
    <section aria-labelledby="health-checks" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id="health-checks" className="text-md font-semibold">
          Checks
        </h2>
        {checks.data && <span className="text-sm text-fg-muted">{checksSummary(rows)}</span>}
      </div>
      {checks.isError ? (
        <p role="alert" className="text-base text-red">
          Could not run the checks: {describeError(checks.error)}
        </p>
      ) : checks.isPending ? (
        <RowsSkeleton rows={4} />
      ) : (
        groupChecks(rows).map((group) => (
          <div key={group.id} className="flex flex-col gap-1.5">
            <SectionLabel className="ml-1">{group.title}</SectionLabel>
            <ul aria-label={group.title} className="flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <CheckItem
                  key={row.id}
                  row={row}
                  busy={busy === row.id}
                  locked={busy !== undefined}
                  result={results[row.id]}
                  onFix={() => void runFix(row)}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function CheckItem({
  row,
  busy,
  locked,
  result,
  onFix,
}: {
  row: CheckRow;
  busy: boolean;
  locked: boolean;
  result: FixResult | undefined;
  onFix: () => void;
}) {
  const tone = checkTone(row);
  const failing = row.level !== "pass" && (row.level !== undefined || !row.ok);
  return (
    <li className="flex flex-col gap-1 rounded-[10px] border border-line-strong bg-card px-3.5 py-2">
      <div className="flex items-center gap-3">
        <Dot tone={tone} />
        <span className="w-[210px] shrink-0 truncate text-sm font-medium">{row.label}</span>
        <span className="min-w-0 flex-1 text-sm text-fg-muted text-pretty">{row.detail}</span>
        {row.fix && failing && (
          <Button size="sm" disabled={locked} aria-label={`${row.fix.label}: ${row.label}`} onClick={onFix}>
            {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {busy ? "Working" : row.fix.label}
          </Button>
        )}
      </div>
      {result && (
        <p role="status" className={cn("pl-5 text-sm", toneText(result.ok ? "green" : "red"))}>
          {result.detail}
        </p>
      )}
    </li>
  );
}
