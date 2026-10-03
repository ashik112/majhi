import { ChevronDown, LoaderCircle } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot, toneText } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useFixCheck, useHealthChecks } from "@/lib/ops-queries";
import { KeyExportForm } from "./key-export-form";
import { KeyRestoreForm } from "./key-restore-form";
import { type CheckRow, checkTone, groupChecks, groupLevel, levelOf, openChecks } from "./model";

interface FixResult {
  ok: boolean;
  detail: string;
}

/** A fix that needs a form only the owner fills in, like the key export's passphrase. */
interface OpenForm {
  id: string;
  kind: "key-export" | "key-restore";
}

const LEVEL_TONE = { pass: "green", warn: "amber", fail: "red" } as const;

/**
 * Every doctor check, folded to one line per group with its count. Checks that fail or warn are
 * always open under it with their Fix; the full list opens on demand and scrolls inside itself.
 */
export function ChecksPanel({ onSignIn }: { onSignIn: (accountId: string) => void }) {
  const checks = useHealthChecks();
  const fix = useFixCheck();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [results, setResults] = useState<Record<string, FixResult>>({});
  const [form, setForm] = useState<OpenForm>();

  async function runFix(row: CheckRow) {
    setBusy(row.id);
    try {
      const out = await fix.mutateAsync(row.id);
      if (out.open?.kind === "key-export" || out.open?.kind === "key-restore") {
        setForm({ id: row.id, kind: out.open.kind });
        return;
      }
      setResults((prev) => ({ ...prev, [row.id]: { ok: out.ok, detail: out.detail } }));
      if (out.open?.kind === "sign-in") onSignIn(out.open.account);
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
  const groups = groupChecks(rows);
  const problems = openChecks(rows);
  const item = (row: CheckRow) => (
    <CheckItem
      key={row.id}
      row={row}
      busy={busy === row.id}
      locked={busy !== undefined}
      result={results[row.id]}
      onFix={() => void runFix(row)}
      form={form?.id === row.id ? formOf(form.kind) : undefined}
    />
  );

  return (
    <section aria-label="Checks" className={cn("flex shrink-0 flex-col rounded-2xl", GLASS)}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2">
        <h2 className="text-base font-semibold">Checks</h2>
        {checks.isError ? (
          <p role="alert" className="text-sm text-red">
            Could not run the checks: {describeError(checks.error)}
          </p>
        ) : checks.isPending ? (
          <Skeleton className="h-4 w-80" />
        ) : (
          <ul aria-label="Check groups" className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
            {groups.map((group) => {
              const level = groupLevel(group);
              const bad = group.rows.filter((r) => levelOf(r) !== "pass").length;
              return (
                <li key={group.id} className="flex items-center gap-2 text-sm">
                  <Dot tone={LEVEL_TONE[level]} size={7} />
                  <span className="text-fg-soft">{group.title}</span>
                  <span
                    className={cn("tnum font-mono", bad > 0 ? toneText(LEVEL_TONE[level]) : "text-fg-faint")}
                  >
                    {bad > 0 ? `${bad} of ${group.rows.length}` : group.rows.length}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {rows.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="ml-auto"
          >
            {open ? "Hide checks" : `Show all ${rows.length}`}
            <ChevronDown
              aria-hidden="true"
              className={cn("transition-transform duration-150", open && "rotate-180")}
            />
          </Button>
        )}
      </div>
      {problems.length > 0 && !open && (
        <ul aria-label="Checks that need you" className="flex flex-col border-t border-line px-2 py-1.5">
          {problems.map(item)}
        </ul>
      )}
      {open && (
        <div className="max-h-[42dvh] overflow-y-auto overscroll-contain border-t border-line px-2 pt-1.5 pb-5 scroll-fade">
          {groups.map((group) => (
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
    </section>
  );
}

function CheckItem({
  row,
  busy,
  locked,
  result,
  onFix,
  form,
}: {
  row: CheckRow;
  busy: boolean;
  locked: boolean;
  result: FixResult | undefined;
  onFix: () => void;
  form?: ReactNode;
}) {
  const tone = checkTone(row);
  const failing = levelOf(row) !== "pass";
  return (
    <li className="flex flex-col gap-0.5 rounded-md px-2 py-1.5">
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
        {row.fix && failing && form === undefined && (
          <Button size="sm" disabled={locked} aria-label={`${row.fix.label}: ${row.label}`} onClick={onFix}>
            {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {busy ? "Working" : row.fix.label}
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
