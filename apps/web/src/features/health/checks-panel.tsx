import { PAGE_PATH } from "@majhi/shared";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useCheckOne, useFixCheck, useHealthChecks } from "@/lib/ops-queries";
import { useNow } from "@/lib/use-now";
import { KeyExportForm } from "./key-export-form";
import { KeyRestoreForm } from "./key-restore-form";
import { type CheckRow, checkTone, groupChecks, levelOf, openChecks, passingChecks, rowFix } from "./model";

interface FixResult {
  ok: boolean;
  detail: string;
}

/** A fix that needs a form only the owner fills in, like the key export's passphrase. */
interface OpenForm {
  id: string;
  kind: "key-export" | "key-restore";
}

/**
 * What needs the owner, then what is fine. Failing and warning checks come first, one line each: what
 * is wrong, why, one button that fixes it, and when it was checked. Passing checks fold into "All good".
 */
export function ChecksPanel({ checking }: { checking: boolean }) {
  const checks = useHealthChecks();
  const fix = useFixCheck();
  const again = useCheckOne();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [results, setResults] = useState<Record<string, FixResult>>({});
  const [form, setForm] = useState<OpenForm>();

  async function runFix(row: CheckRow) {
    const action = rowFix(row);
    if (action?.kind === "open-connection") {
      void navigate({
        to: PAGE_PATH.connections,
        search: { connection: row.id.slice("connection:".length) },
      });
      return;
    }
    setBusy(row.id);
    try {
      const out = await fix.mutateAsync(row.id);
      if (out.open?.kind === "key-export" || out.open?.kind === "key-restore") {
        setForm({ id: row.id, kind: out.open.kind });
        return;
      }
      setResults((prev) => ({ ...prev, [row.id]: { ok: out.ok, detail: out.detail } }));
      if (out.open?.kind === "sign-in") {
        void navigate({ to: PAGE_PATH.accounts, search: { account: out.open.account } });
      }
    } catch (err) {
      setResults((prev) => ({ ...prev, [row.id]: { ok: false, detail: describeError(err) } }));
    } finally {
      setBusy(undefined);
    }
  }

  async function recheck(row: CheckRow) {
    setBusy(row.id);
    try {
      await again.mutateAsync(row.id);
      setResults((prev) => {
        const { [row.id]: _gone, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setResults((prev) => ({ ...prev, [row.id]: { ok: false, detail: describeError(err) } }));
    } finally {
      setBusy(undefined);
    }
  }

  // The check passes once the form is done and leaves this list, so the result goes to a toast.
  const formOf = (kind: OpenForm["kind"]) =>
    kind === "key-export" ? (
      <KeyExportForm
        onDone={(detail) => {
          setForm(undefined);
          toast("Secrets key exported", { detail });
        }}
      />
    ) : (
      <KeyRestoreForm
        onDone={(detail) => {
          setForm(undefined);
          toast("Secrets key", { detail });
        }}
      />
    );

  const rows = checks.data?.checks ?? [];
  const problems = openChecks(rows);
  const good = passingChecks(rows);
  const item = (row: CheckRow) => (
    <CheckItem
      key={row.id}
      row={row}
      now={now}
      checking={checking}
      busy={busy === row.id}
      locked={busy !== undefined}
      result={results[row.id]}
      onFix={() => void runFix(row)}
      onRecheck={() => void recheck(row)}
      form={form?.id === row.id ? formOf(form.kind) : undefined}
    />
  );

  return (
    <section aria-label="Checks" className={cn("flex shrink-0 flex-col rounded-2xl", GLASS)}>
      {checks.isError ? (
        <p role="alert" className="px-4 py-3 text-sm text-red">
          Could not run the checks: {describeError(checks.error)}
        </p>
      ) : checks.isPending ? (
        <div className="px-4 py-3">
          <Skeleton className="h-4 w-80" />
        </div>
      ) : (
        <>
          <div className="flex min-h-11 items-center gap-2 px-4 py-2">
            <h2 className="text-base font-semibold">Needs you</h2>
            <span
              className={cn("tnum font-mono text-sm", problems.length > 0 ? "text-red" : "text-fg-faint")}
            >
              {problems.length}
            </span>
            {problems.length === 0 && (
              <span className="text-sm text-fg-muted">Nothing is failing. Every check passed.</span>
            )}
          </div>
          {problems.length > 0 && (
            <ul aria-label="Checks to fix" className="flex flex-col border-t border-line px-2 py-1.5">
              {problems.map(item)}
            </ul>
          )}
          {good.length > 0 && (
            <div className="border-t border-line">
              <Button
                variant="ghost"
                size="md"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="h-11 w-full justify-start gap-2 rounded-none rounded-b-2xl px-4"
              >
                <Dot tone="green" size={7} />
                <span className="font-semibold text-fg">All good</span>
                <span className="tnum font-mono text-fg-faint">{good.length}</span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn("ml-auto transition-transform duration-150", open && "rotate-180")}
                />
              </Button>
              {open && (
                <div className="px-2 pt-0.5 pb-3">
                  {groupChecks(good).map((group) => (
                    <div key={group.id} className="flex flex-col">
                      <h3 className="px-2 pt-2 pb-1 text-xs font-medium tracking-[0.08em] text-fg-faint uppercase">
                        {group.title}
                      </h3>
                      <ul aria-label={group.title} className="flex flex-col">
                        {group.rows.map(item)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CheckItem({
  row,
  now,
  checking,
  busy,
  locked,
  result,
  onFix,
  onRecheck,
  form,
}: {
  row: CheckRow;
  now: number;
  checking: boolean;
  busy: boolean;
  locked: boolean;
  result: FixResult | undefined;
  onFix: () => void;
  onRecheck: () => void;
  form?: ReactNode;
}) {
  const tone = checkTone(row);
  const failing = levelOf(row) !== "pass";
  const action = rowFix(row);
  return (
    <li data-check={row.id} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-3">
        <Dot tone={tone} size={7} />
        <span className="w-[200px] shrink-0 truncate text-sm font-medium" title={row.label}>
          {row.label}
        </span>
        <span
          className={cn("min-w-0 flex-1 text-sm text-pretty", failing ? toneText(tone) : "text-fg-muted")}
        >
          {row.detail}
        </span>
        <time
          dateTime={row.checkedAt}
          title={`Checked ${new Date(row.checkedAt).toLocaleString()}`}
          className="tnum hidden shrink-0 text-xs text-fg-faint min-[900px]:block"
        >
          {checking && !busy ? "checking" : formatAgo(row.checkedAt, now)}
        </time>
        {action && form === undefined && (
          <Button size="sm" disabled={locked} aria-label={`${action.label}: ${row.label}`} onClick={onFix}>
            {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {busy ? "Working" : action.label}
          </Button>
        )}
        {failing && !action ? (
          <Button size="sm" disabled={locked} aria-label={`Check again: ${row.label}`} onClick={onRecheck}>
            {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {busy ? "Checking" : "Check again"}
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={locked}
            aria-label={`Check again: ${row.label}`}
            title="Check again"
            onClick={onRecheck}
          >
            <RefreshCw aria-hidden="true" className={cn(busy && "animate-spin")} />
          </Button>
        )}
      </div>
      {form}
      {result && (
        <p role="status" className={cn("pl-[19px] text-sm", toneText(result.ok ? "green" : "red"))}>
          {result.detail}
        </p>
      )}
    </li>
  );
}
