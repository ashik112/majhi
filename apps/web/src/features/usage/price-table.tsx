import { findPrice, type PriceRow, type PricesConfig } from "@majhi/shared";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { describeError } from "@/lib/errors";
import { useSetPrice, useUsagePrices } from "@/lib/usage-queries";
import { dayLabel } from "./daily-chart";
import {
  draftFromRow,
  EMPTY_PRICE_DRAFT,
  formatPrice,
  PRICE_FIELDS,
  type PriceDraft,
  type PriceDraftErrors,
  parsePriceDraft,
  sortPriceRows,
} from "./model";

const CELL = "px-2 py-1.5";

/** The owner-editable price table: majhi's defaults and the owner's own rows, in dollars per million tokens. */
export function PriceTable({ id, models }: { id: string; models: readonly string[] }) {
  const prices = useUsagePrices();
  const setPrice = useSetPrice();
  /** The form: a new row, or the row being changed. */
  const [form, setForm] = useState<{ draft: PriceDraft; locked: boolean }>();
  const [failure, setFailure] = useState<string>();
  const [removing, setRemoving] = useState<string>();

  const rows = sortPriceRows(prices.data?.rows ?? []);
  const owner: PricesConfig = Object.fromEntries(
    rows.filter((r) => r.source === "owner").map((r) => [r.model, r.price]),
  );
  /** Models seen in turns that no row covers yet. */
  const suggestions = models.filter((m) => findPrice(m, owner) === undefined);

  function remove(row: PriceRow) {
    setFailure(undefined);
    setRemoving(row.model);
    setPrice.mutate(
      { model: row.model, price: null },
      { onError: (e) => setFailure(describeError(e)), onSettled: () => setRemoving(undefined) },
    );
  }

  return (
    <div id={id} className="flex flex-col gap-3 rounded-[10px] border border-line-strong bg-raised p-3.5">
      <p className="text-sm text-fg-muted text-pretty">
        Dollars per million tokens. New turns use these prices; recorded turns keep their cost.
        {prices.data && ` Defaults checked ${dayLabel(prices.data.checked, true)}.`}
      </p>
      {prices.isError ? (
        <p role="alert" className="text-sm text-red">
          Could not load prices: {describeError(prices.error)}
        </p>
      ) : prices.isPending ? (
        <RowsSkeleton rows={3} height={28} />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs tracking-[0.08em] text-fg-faint uppercase">
              <th scope="col" className={`${CELL} font-normal`}>
                Model
              </th>
              {PRICE_FIELDS.map((f) => (
                <th key={f.key} scope="col" className={`${CELL} text-right font-normal`}>
                  {f.label}
                </th>
              ))}
              <th scope="col" className={`${CELL} font-normal`}>
                Source
              </th>
              <th scope="col" className={CELL}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.source}-${row.model}`} className="border-t border-line">
                <th scope="row" className={`${CELL} text-left font-mono font-normal text-fg-soft`}>
                  {row.model}
                </th>
                {PRICE_FIELDS.map((f) => (
                  <td key={f.key} className={`${CELL} text-right text-fg-soft tabular-nums`}>
                    {formatPrice(row.price[f.key])}
                  </td>
                ))}
                <td className={CELL}>
                  {row.source === "owner" ? (
                    <Badge tone="amber">{row.overridesDefault ? "Yours, replaces default" : "Yours"}</Badge>
                  ) : (
                    <span className="text-fg-faint">Default</span>
                  )}
                </td>
                <td className={`${CELL} text-right whitespace-nowrap`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    aria-label={`Change the price of ${row.model}`}
                    onClick={() => {
                      setFailure(undefined);
                      setForm({ draft: draftFromRow(row), locked: true });
                    }}
                  >
                    Change
                  </Button>
                  {row.source === "owner" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={removing !== undefined}
                      aria-label={`Remove your price for ${row.model}`}
                      onClick={() => remove(row)}
                    >
                      {removing === row.model ? "Removing" : "Remove"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {form ? (
        <PriceForm
          key={form.draft.model}
          initial={form.draft}
          locked={form.locked}
          suggestions={suggestions}
          onDone={() => setForm(undefined)}
        />
      ) : (
        <div>
          <Button
            size="sm"
            onClick={() => {
              setFailure(undefined);
              setForm({ draft: EMPTY_PRICE_DRAFT, locked: false });
            }}
          >
            Add a price
          </Button>
        </div>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red">
          {failure}
        </p>
      )}
    </div>
  );
}

function PriceForm({
  initial,
  locked,
  suggestions,
  onDone,
}: {
  initial: PriceDraft;
  locked: boolean;
  suggestions: readonly string[];
  onDone: () => void;
}) {
  const setPrice = useSetPrice();
  const listId = useId();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<PriceDraftErrors>({});
  const [failure, setFailure] = useState<string>();
  const set = (patch: Partial<PriceDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function submit() {
    const parsed = parsePriceDraft(draft);
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    setFailure(undefined);
    setPrice.mutate(
      { model: parsed.model, price: parsed.price },
      { onSuccess: onDone, onError: (e) => setFailure(describeError(e)) },
    );
  }

  return (
    <form
      aria-label={locked ? `Price of ${initial.model}` : "New price"}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 rounded-lg border border-line-bright bg-card p-3"
    >
      <div className="grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-3">
        <Field
          label="Model id"
          error={errors.model}
          hint={locked ? undefined : "Like gpt-5.5. It also covers dated versions of the model."}
        >
          {(p) => (
            <>
              <Input
                {...p}
                className="font-mono"
                disabled={locked}
                list={suggestions.length > 0 ? listId : undefined}
                value={draft.model}
                onChange={(e) => set({ model: e.target.value })}
              />
              {suggestions.length > 0 && (
                <datalist id={listId}>
                  {suggestions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </>
          )}
        </Field>
        {PRICE_FIELDS.map((f) => (
          <Field key={f.key} label={`${f.label}, $ / M`} error={errors[f.key]}>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                className="tabular-nums"
                value={draft[f.key]}
                onChange={(e) => set({ [f.key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-red text-pretty">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={setPrice.isPending}>
          {setPrice.isPending ? "Saving" : "Save price"}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
